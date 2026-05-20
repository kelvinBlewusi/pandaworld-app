import { NextRequest, NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import * as Sentry from "@sentry/nextjs";
import { createServerClient } from "@/lib/supabase/server";
import { revokeToken } from "@/lib/jumia/oauth";
import { decrypt } from "@/lib/security/token-crypto";

// ─── POST /api/account/delete ────────────────────────────────────────────────
//
// Right-to-erasure (Ghana Data Protection Act 2012, GDPR Article 17).
// Sellers can wipe their account + data on demand from Settings →
// Account → Danger zone.
//
// Strategy: immediate hard delete. We do NOT do a 30-day soft delete
// today because:
//   - The legal floor is "delete on request" — soft-delete invites
//     dispute about whether the data was actually deleted.
//   - We don't yet have a worker reliable enough to run scheduled
//     hard-deletes; an in-app "Sorry, please re-create your account"
//     path is simpler than building one to risk forgetting and
//     leaving stale rows.
//
// Order of operations (matters if any step throws partway):
//   1. Revoke Jumia OAuth tokens (so a leaked DB after this point
//      can't be used against the seller's vendor center).
//   2. Cancel Paystack subscription (stops the recurring charge).
//   3. Delete Supabase storage objects (product images).
//   4. Delete database rows (variants → listings → jumia_connections
//      → subscriptions → app_users).
//   5. Delete Clerk user (signs the seller out everywhere).
//
// Each step is wrapped so a partial failure still progresses the
// rest — losing the chance to revoke a token is bad, but losing
// the chance to delete the user record is worse. Errors are
// captured to Sentry so we can manually clean up survivors.
//
// Requires the seller to POST the literal string "DELETE" in the
// body's `confirm` field — the UI enforces this via a type-to-
// confirm modal so accidental clicks can't wipe an account.

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  let confirm = "";
  try {
    const body = await req.json();
    confirm = String(body?.confirm ?? "").trim();
  } catch { /* no body — fine; will fail the confirm check */ }

  if (confirm !== "DELETE") {
    return NextResponse.json(
      { error: 'Confirmation required. POST { "confirm": "DELETE" } to proceed.' },
      { status: 400 },
    );
  }

  const db = createServerClient();
  const errors: string[] = [];

  // ── 1. Revoke Jumia tokens ───────────────────────────────────────────────
  try {
    const { data: conn } = await db
      .from("jumia_connections")
      .select("access_token, refresh_token")
      .eq("user_id", userId)
      .maybeSingle();

    if (conn?.access_token && conn.access_token !== "credential_auth") {
      try { await revokeToken(decrypt(conn.access_token as string)); }
      catch (e) { errors.push(`jumia access-token revoke: ${(e as Error).message}`); }
    }
    if (conn?.refresh_token) {
      try { await revokeToken(decrypt(conn.refresh_token as string)); }
      catch (e) { errors.push(`jumia refresh-token revoke: ${(e as Error).message}`); }
    }
  } catch (e) {
    errors.push(`jumia revoke lookup: ${(e as Error).message}`);
  }

  // ── 2. Cancel Paystack subscription ──────────────────────────────────────
  try {
    const { data: sub } = await db
      .from("subscriptions")
      .select("paystack_subscription_code, paystack_email_token")
      .eq("user_id", userId)
      .maybeSingle();

    if (sub?.paystack_subscription_code && process.env.PAYSTACK_SECRET_KEY) {
      const res = await fetch("https://api.paystack.co/subscription/disable", {
        method:  "POST",
        headers: {
          Authorization:   `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          "Content-Type":  "application/json",
        },
        body: JSON.stringify({
          code:  sub.paystack_subscription_code,
          token: sub.paystack_email_token,
        }),
      });
      if (!res.ok) {
        errors.push(`paystack disable: HTTP ${res.status}`);
      }
    }
  } catch (e) {
    errors.push(`paystack cancel: ${(e as Error).message}`);
  }

  // ── 3. Delete storage objects ────────────────────────────────────────────
  // List then delete — Supabase storage doesn't support delete-by-prefix
  // in a single call. We page in 1000s because that's what list returns
  // per request.
  try {
    let offset = 0;
    while (true) {
      const { data: files, error: listError } = await db.storage
        .from("product-images")
        .list(userId, { limit: 1000, offset, sortBy: { column: "created_at", order: "asc" } });
      if (listError) {
        errors.push(`storage list: ${listError.message}`);
        break;
      }
      if (!files || files.length === 0) break;
      const paths = files.map((f) => `${userId}/${f.name}`);
      const { error: deleteError } = await db.storage.from("product-images").remove(paths);
      if (deleteError) {
        errors.push(`storage delete: ${deleteError.message}`);
        break;
      }
      if (files.length < 1000) break;
      offset += 1000;
    }
  } catch (e) {
    errors.push(`storage cleanup: ${(e as Error).message}`);
  }

  // ── 4. Delete database rows ──────────────────────────────────────────────
  // Order matters because of foreign keys: child rows first, then parents.
  // We collect errors but DO NOT abort — better to leave a few orphan
  // rows than to leave a Clerk user without their data deleted.
  const tablesInOrder = [
    "variants",          // FK → listings
    "listings",          // FK → app_users
    "jumia_connections", // FK → app_users
    "subscriptions",     // FK → app_users
    "app_users",         // parent
  ];

  for (const table of tablesInOrder) {
    try {
      const { error } = await db.from(table).delete().eq("user_id", userId);
      if (error && !/relation.*does not exist/i.test(error.message)) {
        errors.push(`db delete ${table}: ${error.message}`);
      }
    } catch (e) {
      errors.push(`db delete ${table}: ${(e as Error).message}`);
    }
  }

  // ── 5. Delete the Clerk user ─────────────────────────────────────────────
  // Has to happen LAST so the auth() check at the top of this route
  // still works through earlier steps. Once Clerk deletes the user,
  // their session is invalidated everywhere.
  try {
    const client = await clerkClient();
    await client.users.deleteUser(userId);
  } catch (e) {
    errors.push(`clerk delete: ${(e as Error).message}`);
  }

  if (errors.length > 0) {
    // Report to Sentry so we know about partial deletions and can
    // manually clean them up. The seller still gets a success
    // response — their data IS gone from our side; the leftovers are
    // residual records we can sweep later.
    Sentry.captureMessage(`Account deletion partial: ${userId}`, {
      level: "warning",
      extra: { errors },
    });
    console.warn(`[account-delete] partial for ${userId}: ${errors.join("; ")}`);
  }

  return NextResponse.json({ success: true, errors });
}
