import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
import { getFeedStatus, getFeedProductDetails } from "@/lib/jumia/api";
import { refreshAccessToken } from "@/lib/jumia/oauth";

// ─── GET /api/cron/jumia-feeds ────────────────────────────────────────────────
// Vercel cron — runs every 5 minutes (see vercel.json)
// Checks all pending_approval listings across all users and updates statuses.
//
// Security: Vercel sets the Authorization: Bearer <CRON_SECRET> header.
// Set CRON_SECRET in your Vercel env vars.

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return new NextResponse("Unauthorized", { status: 401 });
    }
  }

  const db = createServerClient();

  // ── Fetch all pending listings with a feedId ──────────────────────────────
  const { data: pending } = await db
    .from("listings")
    .select("id, user_id, jumia_ref")
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

      accessToken = conn.access_token as string;

      if (conn.token_expires_at) {
        const expiresAt = new Date(conn.token_expires_at as string).getTime();
        if (Date.now() >= expiresAt - 5 * 60 * 1000 && conn.refresh_token) {
          const fresh = await refreshAccessToken(conn.refresh_token as string);
          accessToken = fresh.access_token;
          await db.from("jumia_connections").update({
            access_token:     fresh.access_token,
            refresh_token:    fresh.refresh_token ?? conn.refresh_token,
            token_expires_at: new Date(Date.now() + fresh.expires_in * 1000).toISOString(),
            updated_at:       new Date().toISOString(),
          }).eq("user_id", userId);
        }
      }
    } catch (e) {
      console.warn(`[Cron] Skipping user ${userId}: ${(e as Error).message}`);
      continue;
    }

    // Poll each feed for this user
    for (const listing of listings) {
      const feedStatus = await getFeedStatus(accessToken, listing.jumia_ref as string);
      if (!feedStatus) continue;

      let newStatus: string | null = null;
      let errorMsg: string | null = null;

      if (feedStatus.status === "DONE") {
        newStatus = feedStatus.failed > 0 ? "failed" : "live";
        if (feedStatus.failed > 0 && feedStatus.errors.length) {
          errorMsg = JSON.stringify(feedStatus.errors[0]).slice(0, 500);
        }
      } else if (feedStatus.status === "ERROR") {
        newStatus = "failed";
        errorMsg = feedStatus.errors.length
          ? JSON.stringify(feedStatus.errors[0]).slice(0, 500)
          : "Jumia feed processing error";
      }

      if (newStatus) {
        // When the feed is DONE, fetch the productSid + qc.status. We need
        // these to perform any future stock/price/status updates per Jumia
        // docs: only QC-approved products allow updates.
        const updates: Record<string, unknown> = {
          status:      newStatus,
          jumia_error: errorMsg,
          updated_at:  new Date().toISOString(),
        };

        if (feedStatus.status === "DONE" && newStatus === "live") {
          const productInfos = await getFeedProductDetails(accessToken, listing.jumia_ref as string);
          if (productInfos && productInfos.length > 0) {
            // For non-variant listings we expect exactly one product entry
            const info = productInfos[0];
            if (info.productSid)        updates.jumia_product_sid = info.productSid;
            if (info.qcStatus)          updates.jumia_qc_status   = info.qcStatus;
            // If multiple variants, store the full map for later lookup
            if (productInfos.length > 1) {
              updates.jumia_product_map = productInfos.reduce<Record<string, { sid: string | null; qc: string | null }>>(
                (acc, p) => { acc[p.sellerSku] = { sid: p.productSid, qc: p.qcStatus }; return acc; },
                {}
              );
            }
            console.info(
              `[Cron] ${listing.id} → ${newStatus} (sid=${info.productSid ?? "—"}, qc=${info.qcStatus ?? "—"})`
            );
          }
        }

        await db.from("listings").update(updates).eq("id", listing.id);
        updated++;
        if (!(feedStatus.status === "DONE" && newStatus === "live")) {
          console.info(`[Cron] ${listing.id} → ${newStatus}`);
        }
      }
    }
  }

  return NextResponse.json({ checked: pending.length, updated });
}
