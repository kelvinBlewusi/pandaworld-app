import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { fetchCategoriesFromJumia, upsertCategories } from "@/lib/jumia/categories";
import { refreshAccessToken } from "@/lib/jumia/oauth";

// ─── GET /api/cron/sync-categories ────────────────────────────────────────────
// Vercel cron — refreshes the Jumia category list nightly without requiring
// a seller to click "Sync now". Schedule is set in vercel.json. Walks the
// connected sellers' tokens, picks one (the first viable), and uses it to
// re-pull the category tree. We only need one valid Jumia token because the
// category list is global (not per-shop).
//
// Security: Vercel sets `Authorization: Bearer <CRON_SECRET>`. We verify
// when CRON_SECRET is set.
//
// Returns: { synced: number, source: "<userId|none>", duration_ms: number }

export const dynamic     = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return new NextResponse("Unauthorized", { status: 401 });
    }
  }

  const t0 = Date.now();
  console.info("[Cron] ▶ Category sync — start");

  const db = createServerClient();

  // ── Find any active Jumia connection — categories are global so any
  //    valid token works. We prefer the most recently refreshed one. ───
  const { data: conns } = await db
    .from("jumia_connections")
    .select("user_id, access_token, refresh_token, token_expires_at, app_id, app_secret, status")
    .eq("status", "active")
    .not("access_token", "eq", "credential_auth")
    .order("updated_at", { ascending: false })
    .limit(5);

  if (!conns || conns.length === 0) {
    console.info("[Cron] No active Jumia connections — nothing to sync.");
    return NextResponse.json({ synced: 0, source: "none", duration_ms: Date.now() - t0 });
  }

  // Try connections in order until one yields a working token + sync.
  for (const conn of conns) {
    let accessToken = conn.access_token as string;
    // Refresh if expired (or about to expire) — same logic as
    // getValidJumiaCredentials, inlined here so we don't need a user session.
    const expiresAt = conn.token_expires_at ? new Date(conn.token_expires_at as string).getTime() : 0;
    if (expiresAt && Date.now() >= expiresAt - 5 * 60 * 1000) {
      try {
        const fresh = await refreshAccessToken(
          conn.refresh_token as string,
          (conn.app_id     ?? undefined) as string | undefined,
          (conn.app_secret ?? undefined) as string | undefined,
        );
        accessToken = fresh.access_token;
        await db.from("jumia_connections").update({
          access_token:     fresh.access_token,
          refresh_token:    fresh.refresh_token ?? conn.refresh_token,
          token_expires_at: new Date(Date.now() + fresh.expires_in * 1000).toISOString(),
          updated_at:       new Date().toISOString(),
        }).eq("user_id", conn.user_id);
      } catch (e) {
        console.warn(`[Cron] Token refresh failed for user ${conn.user_id}:`, (e as Error).message);
        continue;
      }
    }

    try {
      const categories = await fetchCategoriesFromJumia(accessToken);
      await upsertCategories(categories);
      console.info(`[Cron] ✓ Synced ${categories.length} categories in ${Date.now() - t0}ms via user ${conn.user_id}`);
      return NextResponse.json({
        synced:      categories.length,
        source:      conn.user_id,
        duration_ms: Date.now() - t0,
      });
    } catch (e) {
      console.warn(`[Cron] Sync failed via user ${conn.user_id}:`, (e as Error).message);
      // Try the next connection
      continue;
    }
  }

  console.error("[Cron] ✕ All connections failed — no sync performed.");
  return NextResponse.json(
    { synced: 0, source: "none", error: "All active Jumia connections failed", duration_ms: Date.now() - t0 },
    { status: 502 },
  );
}
