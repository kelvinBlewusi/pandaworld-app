import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { encrypt, decrypt } from "@/lib/security/token-crypto";

export const dynamic = "force-dynamic";
import { refreshAccessToken } from "@/lib/jumia/oauth";
import { refreshPendingFeedStatus, notifyResolvedListings, toResolvedNotice, type ResolvedListingNotice } from "@/lib/jumia/push-listing";

// ─── GET /api/cron/jumia-feeds ────────────────────────────────────────────────
// Checks all pending_approval listings across all users and updates statuses.
//
// Scheduled by pg_cron every minute (supabase/schedule-workers.sql, job
// 'jumia-feed-poll'), NOT by vercel.json — the Hobby plan caps its own cron
// at once a DAY, which is what left listings sitting at "pending Jumia
// review" for up to 24 hours in the first place. The vercel.json entry is
// kept only as a daily backstop; the comment here used to claim five
// minutes, which was never true on this plan.
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
  //
  // The error is READ, not discarded. It used to be `const { data: pending }`
  // with no error binding, and that one omission hid a total outage of this
  // route: a failed query answers `data: null`, which is indistinguishable
  // from "nothing is pending", so the route took the early-out below and
  // returned 200 {checked: 0} — every minute, for as long as it was broken.
  //
  // How that looked in production on 2026-09-15: four listings sat at
  // pending_approval from 02:31, this cron ran and returned 200 every
  // minute for the next 26 minutes, and not one line of output was logged,
  // because the first console.info sat AFTER the early-out. The seller's
  // status only ever moved when they opened /extension/whatsapp-listings,
  // whose own refresh does the same work user-scoped. Same lesson the
  // worker's claimError already learned: an empty result and a failure
  // must never look alike.
  const { data: pending, error: pendingError } = await db
    .from("listings")
    .select("id, user_id, jumia_ref, title, whatsapp_batch_id, whatsapp_seq")
    .eq("status", "pending_approval")
    .not("jumia_ref", "is", null);

  if (pendingError) {
    console.error(
      `[Cron] Could not list pending feeds: ${pendingError.message} — ` +
      `no listing statuses were refreshed this run.`,
    );
    return NextResponse.json({ checked: 0, updated: 0, error: pendingError.message }, { status: 500 });
  }

  // Logged unconditionally, INCLUDING the zero case. A route that says
  // nothing when idle cannot be told apart from a route that is not
  // running at all — which is exactly how this went unnoticed.
  console.info(`[Cron] Checking ${pending?.length ?? 0} pending Jumia feeds`);

  if (!pending || pending.length === 0) {
    return NextResponse.json({ checked: 0, updated: 0 });
  }

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
    //
    // skipNotify: true here — this loop runs across EVERY pending listing
    // for this user, which for a multi-product WhatsApp batch used to mean
    // one separate "🎉 X is live!" / "⚠️ X was rejected" message per
    // listing the moment each one resolved, often several ticks apart. The
    // resolutions are collected instead and handed to
    // notifyResolvedListings ONCE per user below, which groups them by
    // whatsapp_batch_id and sends at most one message per batch for
    // whatever resolved in THIS run.
    const resolved: ResolvedListingNotice[] = [];
    for (const listing of listings) {
      const before = "pending_approval";
      const result = await refreshPendingFeedStatus(accessToken, {
        id:         listing.id as string,
        status:     before,
        jumia_ref:  listing.jumia_ref as string,
      }, { skipNotify: true });
      if (result.status !== before) {
        updated++;
        console.info(
          `[Cron] ${listing.id} → ${result.status}` +
          (result.totalCount > 1 ? ` (${result.liveCount}/${result.totalCount} variants live)` : ""),
        );
      }
      const notice = toResolvedNotice(
        {
          id:                listing.id as string,
          title:             listing.title as string | null,
          whatsapp_batch_id: listing.whatsapp_batch_id as string | null,
          whatsapp_seq:      listing.whatsapp_seq as number | null,
        },
        before,
        result,
      );
      if (notice) resolved.push(notice);
    }
    await notifyResolvedListings(userId, resolved);
  }

  return NextResponse.json({ checked: pending.length, updated });
}
