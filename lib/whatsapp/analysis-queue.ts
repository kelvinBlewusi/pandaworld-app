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
  const { data, error } = await db
    .from("analysis_jobs")
    .upsert(
      params.listings.map((l) => ({
        listing_id:   l.listingId,
        batch_id:     params.batchId,
        user_id:      params.userId,
        phone_number: params.phoneNumber,
        seq:          l.seq,
        batch_size:   params.batchSize,
      })),
      // The unique index only covers in-flight rows, so a listing that was
      // analysed before (status done/failed) can legitimately be queued
      // again — ignoreDuplicates makes the in-flight collision a no-op
      // rather than failing the whole insert for the rest of the batch.
      { onConflict: "listing_id", ignoreDuplicates: true },
    )
    .select("id");

  if (error) {
    console.error(`[analysis-queue] enqueue failed for batch ${params.batchId}: ${error.message}`);
    throw new Error(`Could not queue analysis: ${error.message}`);
  }
  return data?.length ?? 0;
}

/**
 * Atomically claim up to `limit` jobs for this worker tick. Safe to call
 * concurrently — see claim_analysis_jobs in the migration (FOR UPDATE SKIP
 * LOCKED), which is what stops two overlapping ticks from analysing, and
 * billing for, the same product twice.
 */
export async function claimAnalysisJobs(limit: number): Promise<AnalysisJob[]> {
  const db = createServerClient();
  const { data, error } = await db.rpc("claim_analysis_jobs", { claim_limit: limit });
  if (error) {
    console.error(`[analysis-queue] claim failed: ${error.message}`);
    return [];
  }
  return (data ?? []) as AnalysisJob[];
}

export async function markJobDone(jobId: string): Promise<void> {
  const db = createServerClient();
  await db
    .from("analysis_jobs")
    .update({ status: "done", error: null, updated_at: new Date().toISOString() })
    .eq("id", jobId);
}

/**
 * Release a job after a failed attempt. Back to 'queued' while retries
 * remain (claim_analysis_jobs retires it to 'failed' once attempts run
 * out), so a transient Gemini blip gets another go on the next tick
 * instead of costing the seller that product.
 */
export async function markJobFailed(jobId: string, message: string): Promise<void> {
  const db = createServerClient();
  await db
    .from("analysis_jobs")
    .update({ status: "queued", error: message.slice(0, 500), updated_at: new Date().toISOString() })
    .eq("id", jobId);
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
