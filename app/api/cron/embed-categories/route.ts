import { NextRequest, NextResponse } from "next/server";
import { embedPendingCategories } from "@/lib/jumia/embed-categories";

// Same 60s budget as the admin route this reuses embedPendingCategories
// from, but this loops multiple batches per invocation (see TIME_BUDGET_MS
// below) so a normal day's drift (a sync adding a few dozen/hundred new
// categories) finishes in one run instead of trickling in over many days.
export const maxDuration = 60;

// ─── GET /api/cron/embed-categories ───────────────────────────────────────
// Vercel cron — runs daily at 00:20 UTC (see vercel.json), 5 minutes after
// check-category-freshness so a freshness check that finds new categories
// synced earlier that day is followed shortly by those same categories
// actually getting embedded.
//
// Before this, jumia_categories.embedding only ever got backfilled by an
// admin manually POSTing /api/admin/embed-categories and repeating it
// until { done: true } — meaning any category a sync newly added stayed
// un-embedded (and so invisible to searchCategoriesByEmbedding, which
// filters WHERE embedding IS NOT NULL) until someone remembered to do
// that by hand. This automates the exact same idempotent batch.
//
// Batch size and concurrency match the admin route's defaults — see
// lib/jumia/embed-categories.ts's own comment for why.
const BATCH_SIZE = 300;

// Soft deadline well inside maxDuration — same pattern as
// lib/whatsapp/intake.ts's ANALYSIS_DEADLINE_MS: stop starting new
// batches once we're this far into the run, rather than risking Vercel
// killing the function mid-batch with no response sent at all. Any
// categories left over just get picked up by tomorrow's run (or an
// admin's manual POST, if it can't wait).
const TIME_BUDGET_MS = 50_000;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error(
      "[cron/embed-categories] CRON_SECRET is not set — refusing to run. Configure it in your Vercel env vars.",
    );
    return new NextResponse("Server not configured", { status: 500 });
  }

  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${cronSecret}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const startedAt = Date.now();
  let totalEmbedded = 0;
  let lastRemaining = 0;
  let runs = 0;

  try {
    while (Date.now() - startedAt < TIME_BUDGET_MS) {
      const result = await embedPendingCategories(BATCH_SIZE);
      totalEmbedded += result.embedded;
      lastRemaining = result.remaining;
      runs++;
      if (result.done || result.attempted === 0) break;
    }

    console.log(
      `[cron/embed-categories] ${totalEmbedded} embedded across ${runs} batch(es); ${lastRemaining} remaining`,
    );
    return NextResponse.json({ ok: true, embedded: totalEmbedded, remaining: lastRemaining, runs });
  } catch (e) {
    const error = e instanceof Error ? e.message : "Unknown error";
    console.error(`[cron/embed-categories] failed: ${error}`);
    return NextResponse.json({ ok: false, error, embedded: totalEmbedded, remaining: lastRemaining }, { status: 500 });
  }
}
