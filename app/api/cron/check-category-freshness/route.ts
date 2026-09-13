import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { getValidJumiaCredentials } from "@/lib/jumia/api";
import { fetchCategoriesFromJumia } from "@/lib/jumia/categories";
import { recordCategorySyncHealth } from "@/lib/jumia/category-sync-health";

// Same budget as the admin sync route this reuses fetchCategoriesFromJumia
// from — a full paginated walk of Jumia's catalog, just to count it.
export const maxDuration = 60;

// ─── GET /api/cron/check-category-freshness ──────────────────────────────────
// Vercel cron — runs daily at 00:15 UTC (see vercel.json), 15 minutes after
// the other daily crons so it never contends with them for the same
// Jumia rate-limit window.
//
// Sync itself stays admin-triggered (see AGENTS.md) — this doesn't write
// to jumia_categories at all. It only answers "has our cached catalog
// count drifted from Jumia's live one?" and records the result in
// jumia_category_sync_health for the admin categories page to show a
// warning banner from. Before this, a stale/incorrect local catalog had
// no automated way to be noticed short of a seller's push actually
// failing or an admin happening to re-sync.
//
// Needs SOME connected seller's Jumia token to call the catalog API —
// Jumia's category tree isn't seller-scoped, so any valid token works.
// Reuses the first configured admin account for this rather than
// inventing a separate service-credential concept; if that admin's own
// Jumia connection isn't active, the check can't run and records that
// as an error rather than silently skipping.
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error(
      "[cron/check-category-freshness] CRON_SECRET is not set — refusing to run. " +
        "Configure it in your Vercel env vars.",
    );
    return new NextResponse("Server not configured", { status: 500 });
  }

  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${cronSecret}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const adminUserId = (process.env.ADMIN_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean)[0];
  if (!adminUserId) {
    const error = "No ADMIN_USER_IDS configured — nothing to authenticate the Jumia catalog read with.";
    console.error(`[cron/check-category-freshness] ${error}`);
    await recordCategorySyncHealth({ localCount: 0, liveCount: 0, error }).catch(() => {});
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }

  try {
    const db = createServerClient();
    const [{ accessToken }, { count: localCount }] = await Promise.all([
      getValidJumiaCredentials(adminUserId),
      db.from("jumia_categories").select("*", { count: "exact", head: true }),
    ]);

    const liveCategories = await fetchCategoriesFromJumia(accessToken);
    const liveCount = liveCategories.length;

    await recordCategorySyncHealth({ localCount: localCount ?? 0, liveCount });

    console.log(
      `[cron/check-category-freshness] local=${localCount ?? 0} live=${liveCount} ` +
        `drift=${Math.abs((localCount ?? 0) - liveCount)}`,
    );

    return NextResponse.json({ ok: true, localCount: localCount ?? 0, liveCount });
  } catch (e) {
    const error = e instanceof Error ? e.message : "Unknown error";
    console.error(`[cron/check-category-freshness] failed: ${error}`);
    await recordCategorySyncHealth({ localCount: 0, liveCount: 0, error }).catch(() => {});
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}
