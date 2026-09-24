import { NextRequest, NextResponse } from "next/server";
import {
  claimAnalysisJobs,
  markJobDone,
  markJobFailed,
  findUnfinalizedSettledBatches,
  claimBatchFinalization,
  msUntilNextJobSettles,
  nudgeWorker,
} from "@/lib/whatsapp/analysis-queue";
import { runQueuedAnalysis, finalizeBatch } from "@/lib/whatsapp/intake";
import { readGeminiTelemetry } from "@/lib/ai/quota-telemetry";
import { logAppError } from "@/lib/observability/errors";

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

// How many products one tick will take on. Lowered from 3 to 2 after the
// 2026-09-21 staging canary: a 3-product batch died with no per-product
// notice at all when one product's Gemini response threw mid-describe
// (see lib/ai/parse-ai-response.ts's hardening in this same
// change), which run inside one shared `await Promise.all(...)` in ONE
// Vercel invocation — a crash severe enough to take the whole invocation
// down with it (not just its own per-job try/catch) drags every OTHER
// concurrently-claimed job down too, with none of them reaching
// markJobDone/markJobFailed. Fewer concurrent jobs per tick means fewer
// products caught in that blast radius, and more of the 60s maxDuration
// budget per job if one product's Gemini call needs the full model-
// fallback ladder. maxDuration itself is left at 60 — this project's plan
// already runs it at what a Vercel Hobby function allows, so throughput is
// the lever available here, not duration. Raising this trades quota
// headroom and blast-radius safety for queue throughput — scheduling the
// cron more often is the safer way to buy more throughput back.
const CLAIM_LIMIT = 2;

/**
 * Close out every batch that has settled but never got a closing message —
 * see findUnfinalizedSettledBatches's own doc comment for why that can
 * happen even though every job in it has already reached a terminal
 * status. Deliberately NOT scoped to batch_ids of jobs claimed this tick:
 * that was the bug (a batch whose last job silently retires to 'failed'
 * inside claim_analysis_jobs is never claimed again, so it was never
 * checked again either) — this runs unconditionally, including on a tick
 * that claimed no new work at all.
 */
async function closeSettledBatches(): Promise<number> {
  const batches = await findUnfinalizedSettledBatches();
  let closed = 0;
  for (const b of batches) {
    try {
      // Only one worker may send the closing messages — see
      // claimBatchFinalization. Also what stops a backlog of several
      // orphaned batches for the same seller from all firing at once:
      // the first one to win this flips the session off 'analyzing', so
      // every later one in this same pass loses the race and is skipped.
      if (!(await claimBatchFinalization(b.phone_number))) continue;
      await finalizeBatch(b.batch_id, b.phone_number, b.batch_size);
      closed++;
    } catch (e) {
      console.error(`[worker] finalizing batch ${b.batch_id} failed: ${(e as Error).message}`);
    }
  }
  return closed;
}

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[worker] CRON_SECRET is not set — refusing to run.");
    return new NextResponse("Server not configured", { status: 500 });
  }
  if (req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  // claimError is reported separately from an empty claim on purpose: a
  // PostgREST timeout and "nothing to do" both used to surface as
  // `claimed: 0`, so a tick that silently accomplished nothing was
  // indistinguishable from an idle queue — including in
  // net._http_response, which is where the health of this worker is
  // actually read from.
  let { jobs, error: claimError } = await claimAnalysisJobs(CLAIM_LIMIT);

  // An empty claim has two very different causes now that jobs serve a
  // settle window (see 2026-09-15_analysis-settle-window.sql): the queue
  // is genuinely idle, or it holds work that is a few seconds too young.
  //
  // Only the second one is worth waiting for, and it is worth waiting for
  // precisely because of how this worker is triggered: the webhook nudges
  // it the instant a batch is queued. Returning empty from that nudge
  // would hand a single-product draft back to pg_cron's once-a-minute
  // tick — a minute of "drafting your product…" for work that was ready
  // in ten seconds, which is the regression nudgeWorker exists to stop.
  //
  // Bounded by the window itself and only ever entered on an idle tick,
  // so this cannot eat into the 60s budget of a tick that has real work.
  let settleWaitMs = 0;
  if (jobs.length === 0 && !claimError) {
    settleWaitMs = await msUntilNextJobSettles();
    if (settleWaitMs > 0) {
      // +250ms so the row is past the boundary rather than exactly on it.
      await new Promise((resolve) => setTimeout(resolve, settleWaitMs + 250));
      ({ jobs, error: claimError } = await claimAnalysisJobs(CLAIM_LIMIT));
    }
  }

  if (jobs.length === 0) {
    // An idle claim is exactly the tick an orphaned batch (see
    // closeSettledBatches) would otherwise never get checked on — nothing
    // claimed this tick means its batch_id would never even be looked at
    // under the old jobs-claimed-this-tick-only scoping.
    const batchesClosed = await closeSettledBatches();
    return NextResponse.json({
      claimed: 0, done: 0, failed: 0, batchesClosed,
      ...(settleWaitMs > 0 ? { settleWaitMs } : {}),
      ...(claimError ? { claimError } : {}),
      gemini: readGeminiTelemetry(),
    });
  }

  console.info(`[worker] claimed ${jobs.length} analysis job(s)`);

  let done = 0;
  let failed = 0;
  let unrecorded = 0;

  // Concurrent: these are network-bound Gemini calls, and running them in
  // series would put even 3 products past this route's own 60s ceiling.
  await Promise.all(
    jobs.map(async (job) => {
      try {
        await runQueuedAnalysis(job);
        // A job that ran but could not be marked done will be reclaimed
        // as stale and analysed — and billed — a second time. Counted so
        // that shows up in the response rather than only in a log line.
        if (await markJobDone(job.id)) done++;
        else unrecorded++;
      } catch (e) {
        // Released back to 'queued' with the attempt counted, so a
        // transient failure gets another go on the next tick rather than
        // costing the seller that product. claim_analysis_jobs retires it
        // to 'failed' once the attempts run out.
        const message = (e as Error).message ?? "unknown error";
        console.error(`[worker] job ${job.id} (listing ${job.listing_id}) failed: ${message}`);
        // analysis_jobs.error only ever holds the LATEST attempt's message —
        // a retry that later succeeds overwrites it, so it's current state,
        // not a trail. Logged here too so a listing that eventually went
        // fine (like this one) still leaves a permanent record that its
        // first attempt didn't — the "why did I see an error" question this
        // exists to answer.
        logAppError("worker-analyze-jobs", e, { jobId: job.id, listingId: job.listing_id, batchId: job.batch_id, phoneNumber: job.phone_number, attempt: job.attempts });
        await markJobFailed(job.id, message);
        failed++;
      }
    }),
  );

  // Close out any batch that has settled, including one whose last job
  // just finished above AND one whose last job silently retired to
  // 'failed' on some earlier tick without ever being claimed again — see
  // closeSettledBatches.
  const batchesClosed = await closeSettledBatches();

  // Keep the queue draining without waiting for the next scheduled tick.
  // Only fires when this tick actually had work, so an empty queue can't
  // start a loop — and pg_cron still covers the case where this nudge is
  // cut short when the response returns.
  nudgeWorker();

  // Gemini counters ride along in the response body on purpose. pg_net
  // stores every response in net._http_response, so this is queryable
  // straight from SQL — the same channel that proved the worker was
  // 404ing. peakInFlight is the number that decides whether CLAIM_LIMIT or
  // the cron fan-out can safely go up; quotaErrors > 0 means they can't.
  //
  //   select status_code, content::jsonb -> 'gemini'
  //   from net._http_response order by created desc limit 20;
  const gemini = readGeminiTelemetry();
  if (gemini.quotaErrors > 0) {
    console.warn(`[worker][QUOTA] ${gemini.quotaErrors} quota rejection(s) across ${gemini.calls} Gemini call(s), peak concurrency ${gemini.peakInFlight}`);
  }
  if (unrecorded > 0) {
    console.error(`[worker] ${unrecorded} job(s) completed but could not be marked done — expect stale reclaim and double charges`);
  }
  return NextResponse.json({
    claimed: jobs.length, done, failed, batchesClosed,
    ...(settleWaitMs > 0 ? { settleWaitMs } : {}),
    ...(unrecorded > 0 ? { unrecorded } : {}),
    gemini,
  });
}
