import { NextRequest, NextResponse } from "next/server";
import { recomputeIsLeafForAllCategories } from "@/lib/jumia/categories";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// ─── GET /api/cron/recompute-category-leaves ──────────────────────────────────
//
// Safety net for jumia_categories.is_leaf, called on a schedule (see
// supabase/schedule-workers.sql) independently of any category sync.
//
// is_leaf drives the AI's "prefer a leaf category over a parent" ranking
// (lib/actions/ai.ts) — the fix for Jumia's "You can't list products in
// this category, choose a different (more specific) category" rejection.
// A category sync writes is_leaf=false provisionally on every page and
// relies on a separate, ADMIN-ONLY "finalize" step
// (/api/admin/jumia/sync-categories/finalize) to recompute the real value
// afterward. Confirmed live, 2026-09-20: that finalize step had
// apparently never completed — 27,719 of 27,720 categories read
// is_leaf=false — which made the leaf-preference ranking a no-op for
// every listing drafted since, because every candidate looked equally
// "non-leaf" to the AI. Running this on a schedule means a sync whose
// finalize step is skipped, fails, or times out can't leave is_leaf wrong
// for more than a day before this repairs it.
//
// Security: same bearer-CRON_SECRET contract as every other /api/cron
// route, fail-secure when the secret is missing.

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[recompute-category-leaves] CRON_SECRET is not set — refusing to run.");
    return new NextResponse("Server not configured", { status: 500 });
  }
  if (req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  try {
    const result = await recomputeIsLeafForAllCategories();
    if (result.updated > 0) {
      console.info(`[recompute-category-leaves] is_leaf changed for ${result.updated}/${result.total} categories`);
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error(`[recompute-category-leaves] failed: ${(e as Error).message}`);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
