import { NextRequest, NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import * as Sentry from "@sentry/nextjs";
import { purgeUserData } from "@/lib/account/purge";

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
//   1-4. purgeUserData() — revoke Jumia tokens, delete storage objects,
//        then delete every user-scoped row (see lib/account/purge.ts for
//        the table list and why it is shared with the Clerk webhook).
//   5.   Delete the Clerk user (signs the seller out everywhere).
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

  // ── 1-4. Erase every trace from Supabase ─────────────────────────────────
  //
  // One shared implementation with the user.deleted webhook — see
  // lib/account/purge.ts. Keeping two lists was how this one came to name
  // a table that does not exist (`app_users`, silently skipped) while
  // missing eleven that do, among them whatsapp_connections and
  // extension_api_keys: a phone link and an API key that both went on
  // working after the account was gone.
  //
  // Token revocation and storage cleanup happen inside the purge, in that
  // order, for the same reason they did here: revoke before the rows
  // holding the tokens are deleted.
  const { errors } = await purgeUserData(userId);

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
