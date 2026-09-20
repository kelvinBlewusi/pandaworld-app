/**
 * Queue operations for WhatsApp batch product analysis — the database half
 * of the background worker (see app/api/worker/analyze-jobs/route.ts for
 * the half that actually runs the analyses and talks to the seller).
 *
 * Deliberately holds NO messaging or AI logic: everything here is a small,
 * well-defined statement against analysis_jobs, so the worker's ordering
 * and crash-recovery behaviour can be reasoned about without dragging in
 * the chat state machine.
 *
 * See supabase/migrations/2026-09-13_analysis-jobs-queue.sql for why the
 * queue exists at all — in short, analysing a batch inside the WhatsApp
 * webhook raced Vercel's 60s kill, which capped batches at 5 and turned
 * "too many products" into a hard failure instead of a longer wait.
 */

import { createServerClient } from "@/lib/supabase/server";
import { appUrl } from "@/lib/whatsapp/app-url";

export interface AnalysisJob {
  id:           string;
  listing_id:   string;
  batch_id:     string;
  user_id:      string;
  phone_number: string;
  seq:          number | null;
  batch_size:   number;
  status:       "queued" | "running" | "done" | "failed";
  attempts:     number;
}

export interface EnqueueInput {
  listingId: string;
  seq:       number | null;
}

/**
 * Queue one job per product. Returns how many were actually enqueued —
 * fewer than requested means some listing already had an in-flight job
 * (the partial unique index in the migration), which is the duplicate
 * protection working, not an error.
 */
export async function enqueueAnalysisJobs(
  params: {
    batchId:     string;
    userId:      string;
    phoneNumber: string;
    batchSize:   number;
    listings:    EnqueueInput[];
  },
): Promise<number> {
  if (params.listings.length === 0) return 0;

  const db = createServerClient();

  // Skip anything that already has a job in flight, then plain-insert the
  // rest.
  //
  // NOT an upsert: the duplicate guard in the migration is a PARTIAL unique
  // index (only over queued/running rows, so a listing that finished can be
  // queued again later). Postgres will not use a partial index for ON
  // CONFLICT unless the statement repeats the index predicate, which
  // PostgREST's upsert cannot express — it failed in production with "there
  // is no unique or exclusion constraint matching the ON CONFLICT
  // specification", taking the whole batch down with it.
  const ids = params.listings.map((l) => l.listingId);
  const { data: existing, error: lookupError } = await db
    .from("analysis_jobs")
    .select("listing_id")
    .in("listing_id", ids)
    .in("status", ["queued", "running"]);

  if (lookupError) {
    console.error(`[analysis-queue] in-flight lookup failed for batch ${params.batchId}: ${lookupError.message}`);
    throw new Error(`Could not queue analysis: ${lookupError.message}`);
  }

  const inFlight = new Set((existing ?? []).map((r) => r.listing_id as string));
  const toInsert = params.listings.filter((l) => !inFlight.has(l.listingId));
  if (toInsert.length === 0) return 0;

  const { data, error } = await db
    .from("analysis_jobs")
    .insert(
      toInsert.map((l) => ({
        listing_id:   l.listingId,
        batch_id:     params.batchId,
        user_id:      params.userId,
        phone_number: params.phoneNumber,
        seq:          l.seq,
        batch_size:   params.batchSize,
      })),
    )
    .select("id");

  if (error) {
    // The partial index is still the real guard against a concurrent
    // double-enqueue; losing that race means the job is already queued,
    // which is the outcome we wanted anyway.
    if (error.code === "23505") {
      console.warn(`[analysis-queue] batch ${params.batchId} raced another enqueue — jobs already queued`);
      return 0;
    }
    console.error(`[analysis-queue] enqueue failed for batch ${params.batchId}: ${error.message}`);
    throw new Error(`Could not queue analysis: ${error.message}`);
  }
  return data?.length ?? 0;
}

/**
 * Run a Supabase call, retrying once after a short pause.
 *
 * Exported for tests — the retry policy is the load-bearing part of the
 * fix, not an implementation detail.
 *
 * PostgREST on this project intermittently answers with a 504 — its own
 * log says "Warp server error: Thread killed by timeout manager", and
 * Postgres itself is idle at the time (25/60 connections, no locks, no
 * slow queries), so it is the REST layer, not the database. Measured at
 * roughly 11% of worker ticks, and worse since the 3x fan-out put three
 * workers on the same instant.
 *
 * One retry is the right shape for that: a cold PostgREST thread almost
 * always answers the second time, and anything that doesn't is a real
 * outage that pg_cron's next tick will cover anyway. Retrying harder
 * would pile more load onto the thing that is already struggling.
 */
export async function withRetry<T>(
  label: string,
  run: () => PromiseLike<{ data: T | null; error: { message: string } | null }>,
): Promise<{ data: T | null; error: string | null }> {
  const first = await run();
  if (!first.error) return { data: first.data, error: null };

  console.warn(`[analysis-queue] ${label} failed (${first.error.message}) — retrying once`);
  await new Promise((resolve) => setTimeout(resolve, 400));

  const second = await run();
  if (!second.error) {
    console.info(`[analysis-queue] ${label} succeeded on retry`);
    return { data: second.data, error: null };
  }
  return { data: null, error: second.error.message };
}

export interface ClaimResult {
  jobs: AnalysisJob[];
  /** Non-null when the claim itself failed. NOT the same as an empty
   *  queue — see the note on claimAnalysisJobs. */
  error: string | null;
}

/**
 * Atomically claim up to `limit` jobs for this worker tick. Safe to call
 * concurrently — see claim_analysis_jobs in the migration (FOR UPDATE SKIP
 * LOCKED), which is what stops two overlapping ticks from analysing, and
 * billing for, the same product twice.
 *
 * Returns the failure rather than swallowing it. This used to log and
 * `return []`, which made a database timeout indistinguishable from "no
 * work to do" — to the worker, to its response body, and to anyone
 * reading net._http_response to check the queue was healthy. It reported
 * `claimed: 0` either way, so roughly one tick in nine silently did
 * nothing and looked exactly like an idle system.
 *
 * Retry safety: if the first attempt actually committed and only its
 * response was lost, the retry claims a DIFFERENT set and the first set
 * sits in 'running' with nobody working it. That is already handled —
 * claim_analysis_jobs reclaims anything whose locked_at has gone stale
 * (5 minutes), so the cost is a delay on those jobs, never a loss.
 */
export async function claimAnalysisJobs(limit: number): Promise<ClaimResult> {
  const db = createServerClient();
  const { data, error } = await withRetry("claim", () =>
    db.rpc("claim_analysis_jobs", { claim_limit: limit }),
  );

  if (error) {
    console.error(`[analysis-queue] claim failed after retry: ${error}`);
    return { jobs: [], error };
  }
  return { jobs: (data ?? []) as AnalysisJob[], error: null };
}

/**
 * Mark a finished job done. Returns false if it could not be recorded.
 *
 * This used to ignore its own result entirely. A dropped write here is
 * not cosmetic: the row stays 'running', goes stale after 5 minutes, gets
 * reclaimed, and the product is analysed a second time — and DEDUCTED FOR
 * a second time, since runQueuedAnalysis bills on success. At an 11%
 * PostgREST failure rate that is a live double-billing path, not a
 * theoretical one.
 */
export async function markJobDone(jobId: string): Promise<boolean> {
  const db = createServerClient();
  const { error } = await withRetry("markJobDone", () =>
    db
      .from("analysis_jobs")
      .update({ status: "done", error: null, updated_at: new Date().toISOString() })
      .eq("id", jobId)
      .select("id"),
  );

  if (error) {
    console.error(
      `[analysis-queue] could not mark job ${jobId} done (${error}) — it will be reclaimed as stale and re-analysed, double-charging the seller`,
    );
    return false;
  }
  return true;
}

/**
 * Release a job after a failed attempt. Back to 'queued' while retries
 * remain (claim_analysis_jobs retires it to 'failed' once attempts run
 * out), so a transient Gemini blip gets another go on the next tick
 * instead of costing the seller that product.
 *
 * A dropped write here is less costly than in markJobDone — the row is
 * already 'running' and stale-reclaim produces the retry we wanted
 * anyway — but it loses the error message, so it is still worth a retry
 * and a loud line.
 */
export async function markJobFailed(jobId: string, message: string): Promise<boolean> {
  const db = createServerClient();
  const { error } = await withRetry("markJobFailed", () =>
    db
      .from("analysis_jobs")
      .update({ status: "queued", error: message.slice(0, 500), updated_at: new Date().toISOString() })
      .eq("id", jobId)
      .select("id"),
  );

  if (error) {
    console.error(`[analysis-queue] could not release job ${jobId} (${error}) — falling back to stale reclaim`);
    return false;
  }
  return true;
}

/**
 * True when no job for this batch is still queued or running — i.e. this
 * worker just finished the last one and the batch is ready to be closed
 * out for the seller.
 */
export async function isBatchSettled(batchId: string): Promise<boolean> {
  const db = createServerClient();
  const { count, error } = await db
    .from("analysis_jobs")
    .select("id", { count: "exact", head: true })
    .eq("batch_id", batchId)
    .in("status", ["queued", "running"]);

  if (error) {
    console.warn(`[analysis-queue] settle check failed for batch ${batchId}: ${error.message}`);
    return false;
  }
  return (count ?? 0) === 0;
}

export interface SettledBatch {
  batch_id:     string;
  phone_number: string;
  batch_size:   number;
}

/**
 * Batches with zero queued/running jobs left, whose seller session is
 * still 'analyzing' — i.e. settled but never finalized.
 *
 * Exists because a job's terminal transition to 'failed' happens INSIDE
 * claim_analysis_jobs's own stale-reclaim retirement, as a side effect of
 * a claim attempt that finds attempts already exhausted. That row is
 * never handed back to the caller, so a settle-check keyed off "batch_ids
 * of jobs claimed this tick" never runs again for a batch whose last job
 * fails this way — confirmed live: a single-product batch whose one job
 * hit Vercel's 60s function timeout three times in a row sat in
 * whatsapp_sessions.state = 'analyzing' forever, with no failure notice
 * ever reaching the seller.
 *
 * Cheap and safe to call every tick, including one that claimed no new
 * work — that is exactly the tick an orphaned batch like this needs to be
 * caught on. claimBatchFinalization's own conditional UPDATE makes
 * finalizing the same batch twice, or racing another worker over it, a
 * no-op rather than a double-send. See the migration for why the DB
 * function itself orders most-recently-created batch first when several
 * are backlogged.
 */
export async function findUnfinalizedSettledBatches(): Promise<SettledBatch[]> {
  const db = createServerClient();
  const { data, error } = await withRetry("findUnfinalizedSettledBatches", () =>
    db.rpc("find_unfinalized_settled_batches"),
  );
  if (error) {
    console.warn(`[analysis-queue] settled-batch scan failed: ${error}`);
    return [];
  }
  return (data ?? []) as SettledBatch[];
}

/**
 * Win the right to close out a batch, exactly once.
 *
 * Two workers finishing the last two jobs of a batch can both see it
 * settled and both try to send the "🎉 Done drafting!" message. The
 * seller's session row is the natural lock: flipping it out of "analyzing"
 * is a single conditional UPDATE, so Postgres decides the winner. A worker
 * that gets no row back simply skips finalisation — someone else is
 * already doing it.
 *
 * Doubles as the state transition the seller needs anyway, which is why
 * finalizeBatch doesn't touch the session itself.
 */
export async function claimBatchFinalization(phoneNumber: string): Promise<boolean> {
  const db = createServerClient();
  const { data, error } = await db
    .from("whatsapp_sessions")
    .update({ state: "awaiting_confirmation", updated_at: new Date().toISOString() })
    .eq("phone_number", phoneNumber)
    .eq("state", "analyzing")
    .select("phone_number");

  if (error) {
    console.warn(`[analysis-queue] finalization claim failed for ${phoneNumber}: ${error.message}`);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

/**
 * Best-effort "there's work waiting" ping so a small batch doesn't sit
 * idle until the next pg_cron tick — without it a single-product draft
 * that used to finish inline in ~22s could wait a further minute for the
 * schedule to come round, which would read as a regression to the seller.
 *
 * Deliberately not awaited by callers and never throws: pg_cron remains
 * the guarantee, this is only latency. There is no waitUntil available on
 * this Next version, so the request may well be cut short when the webhook
 * returns — that's fine, it costs nothing and the next tick picks the work
 * up regardless.
 */
export function nudgeWorker(): void {
  const secret = process.env.CRON_SECRET;
  if (!secret) return;

  void fetch(`${appUrl()}/api/worker/analyze-jobs`, {
    method:  "POST",
    headers: { Authorization: `Bearer ${secret}` },
    signal:  AbortSignal.timeout(2_000),
  }).catch(() => {
    // pg_cron will pick the jobs up within the minute.
  });
}

/**
 * How long a freshly-enqueued job waits before claim_analysis_jobs will
 * hand it out.
 *
 * MUST match the settle_after constant in
 * supabase/migrations/2026-09-15_analysis-settle-window.sql — the database
 * enforces the rule, this is only how the worker knows how long to wait
 * for it. See that migration for why the window exists (an album's last
 * photos landing after the AI has already read the row).
 */
export const SETTLE_WINDOW_MS = 10_000;

/**
 * Milliseconds until the oldest queued job becomes claimable, or 0 if
 * there is nothing waiting on the settle window.
 *
 * Only worth asking after a claim came back empty, which is when "the
 * queue is idle" and "the queue has work that is a few seconds too young"
 * look identical to the worker — and getting that wrong costs a
 * single-product seller a full minute waiting for pg_cron's next tick,
 * which is exactly the regression nudgeWorker exists to prevent.
 *
 * Never throws and never blocks the tick: a failure here answers 0, which
 * simply means this tick ends as it would have before.
 */
export async function msUntilNextJobSettles(): Promise<number> {
  const db = createServerClient();
  const { data, error } = await db
    .from("analysis_jobs")
    .select("created_at")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1);

  if (error) {
    console.warn(`[analysis-queue] settle-window lookup failed: ${error.message}`);
    return 0;
  }
  const oldest = data?.[0]?.created_at as string | undefined;
  if (!oldest) return 0;

  const age = Date.now() - new Date(oldest).getTime();
  const remaining = SETTLE_WINDOW_MS - age;
  // Clamped: a clock skew between Postgres and this function must not turn
  // into an unbounded sleep inside a 60s route.
  return remaining > 0 ? Math.min(remaining, SETTLE_WINDOW_MS) : 0;
}
