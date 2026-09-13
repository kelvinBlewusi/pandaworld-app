import { NextRequest, NextResponse } from "next/server";
import {
  claimAnalysisJobs,
  markJobDone,
  markJobFailed,
  isBatchSettled,
  claimBatchFinalization,
  nudgeWorker,
  type AnalysisJob,
} from "@/lib/whatsapp/analysis-queue";
import { runQueuedAnalysis, finalizeBatch } from "@/lib/whatsapp/intake";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ─── POST /api/worker/analyze-jobs ────────────────────────────────────────────
//
// Drains the WhatsApp batch-analysis queue (see
// supabase/migrations/2026-09-13_analysis-jobs-queue.sql). Called every
// minute by pg_cron — NOT by vercel.json, whose cron the Hobby plan caps at
// once a DAY — and nudged directly by the webhook the moment a batch is
// queued so a small batch doesn't wait for the next tick.
//
// Safe to run concurrently with itself: claim_analysis_jobs uses FOR UPDATE
// SKIP LOCKED, so overlapping ticks take disjoint work rather than
// analysing (and billing for) the same product twice.
//
// Security: same Bearer CRON_SECRET contract as the cron routes, and
// fail-secure if the secret isn't configured — this endpoint can spend a
// seller's credits, so an unauthenticated caller must never reach it.

// How many products one tick will take on. Each analysis measured ~22.7s
// in production and they run concurrently here, so 3 fits inside
// maxDuration with real margin while keeping the Gemini burst to roughly a
// dozen calls. Raising this trades quota headroom for queue throughput —
// scheduling the cron more often is the safer lever.
const CLAIM_LIMIT = 3;

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[worker] CRON_SECRET is not set — refusing to run.");
    return new NextResponse("Server not configured", { status: 500 });
  }
  if (req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const jobs = await claimAnalysisJobs(CLAIM_LIMIT);
  if (jobs.length === 0) {
    return NextResponse.json({ claimed: 0, done: 0, failed: 0, batchesClosed: 0 });
  }

  console.info(`[worker] claimed ${jobs.length} analysis job(s)`);

  let done = 0;
  let failed = 0;

  // Concurrent: these are network-bound Gemini calls, and running them in
  // series would put even 3 products past this route's own 60s ceiling.
  await Promise.all(
    jobs.map(async (job) => {
      try {
        await runQueuedAnalysis(job);
        await markJobDone(job.id);
        done++;
      } catch (e) {
        // Released back to 'queued' with the attempt counted, so a
        // transient failure gets another go on the next tick rather than
        // costing the seller that product. claim_analysis_jobs retires it
        // to 'failed' once the attempts run out.
        const message = (e as Error).message ?? "unknown error";
        console.error(`[worker] job ${job.id} (listing ${job.listing_id}) failed: ${message}`);
        await markJobFailed(job.id, message);
        failed++;
      }
    }),
  );

  // Close out any batch whose last job just settled. Checked per distinct
  // batch, after every job above has been marked, so the settle check sees
  // the final state rather than racing its own siblings.
  const seen = new Map<string, AnalysisJob>();
  for (const job of jobs) seen.set(job.batch_id, job);

  let batchesClosed = 0;
  for (const [batchId, job] of Array.from(seen)) {
    try {
      if (!(await isBatchSettled(batchId))) continue;
      // Only one worker may send the closing messages — see
      // claimBatchFinalization.
      if (!(await claimBatchFinalization(job.phone_number))) continue;
      await finalizeBatch(batchId, job.phone_number, job.batch_size);
      batchesClosed++;
    } catch (e) {
      console.error(`[worker] finalizing batch ${batchId} failed: ${(e as Error).message}`);
    }
  }

  // Keep the queue draining without waiting for the next scheduled tick.
  // Only fires when this tick actually had work, so an empty queue can't
  // start a loop — and pg_cron still covers the case where this nudge is
  // cut short when the response returns.
  nudgeWorker();

  return NextResponse.json({ claimed: jobs.length, done, failed, batchesClosed });
}
