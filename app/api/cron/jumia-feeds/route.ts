import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { encrypt, decrypt } from "@/lib/security/token-crypto";

export const dynamic = "force-dynamic";
import { refreshAccessToken } from "@/lib/jumia/oauth";
import { refreshPendingFeedStatus } from "@/lib/jumia/push-listing";

// ─── GET /api/cron/jumia-feeds ────────────────────────────────────────────────
// Vercel cron — runs every 5 minutes (see vercel.json)
// Checks all pending_approval listings across all users and updates statuses.
//
// Security: Vercel sets the Authorization: Bearer <CRON_SECRET> header.
// CRON_SECRET is REQUIRED — fail-secure if missing. The previous check
// only enforced auth when the env var was set, so a misconfigured
// deploy (env var empty) would expose this endpoint to the public
// and let anyone poll every seller's pending listings.

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[cron] CRON_SECRET is not set — refusing to run. Configure it in your Vercel env vars.");
    return new NextResponse("Server not configured", { status: 500 });
  }
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${cronSecret}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const db = createServerClient();

  // ── Fetch all pending listings with a feedId ──────────────────────────────
  const { data: pending } = await db
    .from("listings")
    .select("id, user_id, jumia_ref, title, whatsapp_batch_id")
    .eq("status", "pending_approval")
    .not("jumia_ref", "is", null);

  if (!pending || pending.length === 0) {
    return NextResponse.json({ checked: 0, updated: 0 });
  }

  console.info(`[Cron] Checking ${pending.length} pending Jumia feeds`);

  // ── Group by user so we only fetch each token once ────────────────────────
  const byUser = new Map<string, typeof pending>();
  for (const row of pending) {
    const uid = row.user_id as string;
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid)!.push(row);
  }

  let updated = 0;

  for (const [userId, listings] of Array.from(byUser)) {
    // Get a valid access token for this user
    let accessToken: string;
    try {
      const { data: conn } = await db
        .from("jumia_connections")
        .select("access_token, refresh_token, token_expires_at")
        .eq("user_id", userId)
        .eq("status", "active")
        .maybeSingle();

      if (!conn) continue;

      // Decrypt — handles both encrypted (enc:v1:…) rows and the
      // legacy plaintext format transparently.
      accessToken = decrypt(conn.access_token as string);
      const refreshTokenPlain = conn.refresh_token ? decrypt(conn.refresh_token as string) : null;

      if (conn.token_expires_at) {
        const expiresAt = new Date(conn.token_expires_at as string).getTime();
        if (Date.now() >= expiresAt - 5 * 60 * 1000 && refreshTokenPlain) {
          const fresh = await refreshAccessToken(refreshTokenPlain);
          accessToken = fresh.access_token;
          await db.from("jumia_connections").update({
            access_token:     encrypt(fresh.access_token),
            refresh_token:    encrypt(fresh.refresh_token ?? refreshTokenPlain),
            token_expires_at: new Date(Date.now() + fresh.expires_in * 1000).toISOString(),
            updated_at:       new Date().toISOString(),
          }).eq("user_id", userId);
        }
      }
    } catch (e) {
      console.warn(`[Cron] Skipping user ${userId}: ${(e as Error).message}`);
      continue;
    }

    // Poll each feed for this user.
    //
    // The status logic, the productSid/qc capture and the WhatsApp notify
    // all used to be written out inline here — and separately again in
    // /api/jumia/feeds/poll, /api/jumia/diagnose and push-listing.ts. Four
    // copies meant four chances to disagree, and they did: three of them
    // never notified the seller at all, so whichever happened to observe
    // the transition first silently consumed it (the row stops being
    // pending_approval, so this cron never looks at it again). All four
    // also counted a feed with ANY failed product as a total failure, which
    // is how a listing with four live variants and one rejected showed up
    // as "Failed". One shared implementation now, in push-listing.ts.
    for (const listing of listings) {
      const before = "pending_approval";
      const result = await refreshPendingFeedStatus(accessToken, {
        id:         listing.id as string,
        status:     before,
        jumia_ref:  listing.jumia_ref as string,
      });
      if (result.status !== before) {
        updated++;
        console.info(
          `[Cron] ${listing.id} → ${result.status}` +
          (result.totalCount > 1 ? ` (${result.liveCount}/${result.totalCount} variants live)` : ""),
        );
      }
    }
  }

  return NextResponse.json({ checked: pending.length, updated });
}
