-- A settle window before a queued analysis becomes claimable, and the
-- retirement of jobs that have exhausted their attempts (see the second
-- comment block in the body — that one is a permanent-stall bug).
--
-- THE PROBLEM, observed live on 2026-09-15 at 02:29 (seller 233550607231,
-- product 4 of a 4-product batch):
--
--   02:29:0x  "📸 Product 4: got it (2 photos)"
--   02:29:0x  seller taps "Done ✅"
--   02:29:0x  "🔍 Got everything for all 4 products — drafting them now"
--   02:29:0x  "📸 Product 4: got it (3 photos)"    ← still arriving
--   02:29:0x  "📸 Product 4: got it (4 photos)"
--   02:29:0x  "📸 Product 4: got it (5 photos)"
--   02:29:0x  "📸 Product 4: got it (6 photos)"
--
-- WhatsApp delivers an album as N independent webhook deliveries, and Meta
-- does not order them. A seller who taps "done" the moment the first
-- confirmation appears closes the product while four more photos are still
-- in the air. Those photos are not lost — append_listing_image is atomic
-- (2026-09-15_atomic-image-append.sql) and they all reached the row, so
-- Jumia got all six. But the enqueue fires on "done", the webhook nudges
-- the worker immediately, and the worker can claim and START READING the
-- listing within a second. The AI then describes a six-photo product from
-- whichever two photos had landed.
--
-- That is the quiet version of the failure, and the expensive one: nothing
-- errors, nobody is told, and the seller gets a confident description of
-- half their product.
--
-- THE FIX: a job is not claimable until it has sat in the queue for a few
-- seconds. The rest of an album lands well inside that window, so the
-- worker reads a settled row.
--
-- WHY HERE rather than in the enqueue: this is a correctness rule about
-- when work may START, and the claim is the only place every path to
-- starting work funnels through — pg_cron's ticks, the webhook's nudge,
-- the worker chaining into itself, and stale reclaim. A delay written into
-- the enqueue would be bypassed by all four.
--
-- The signature is deliberately UNCHANGED. Adding a settle_after parameter
-- would create a second overload next to the existing three-argument one,
-- and PostgREST's `rpc('claim_analysis_jobs', { claim_limit })` would then
-- be ambiguous — which fails the call, and with it every analysis on the
-- platform. The interval is a body constant instead.
--
-- Latency is preserved separately, in the worker: see
-- app/api/worker/analyze-jobs/route.ts, which waits out the remainder of
-- the window and claims once more rather than handing a single-product
-- draft back to the once-a-minute pg_cron tick.

create or replace function claim_analysis_jobs(
  claim_limit  integer,
  stale_after  interval default interval '5 minutes',
  max_attempts integer  default 3
)
returns setof analysis_jobs
language plpgsql
-- Re-stated on purpose: CREATE OR REPLACE FUNCTION replaces a function's
-- configuration settings along with its body, so the hardening applied in
-- 2026-09-15_lock-down-definer-functions.sql would silently be dropped if
-- this were left off.
set search_path = public, pg_temp
as $$
declare
  -- Long enough to cover a phone finishing an album upload, short enough
  -- that a seller sending one photo does not feel it. Measured: the six
  -- deliveries above spanned under four seconds end to end.
  settle_after constant interval := interval '10 seconds';
begin
  -- Retire anything that has burned through its attempts, so a
  -- permanently-broken listing can't wedge its batch open forever.
  --
  -- SECOND FIX IN THIS MIGRATION, and the more serious one. The retirement
  -- above used to require status = 'running'. But the only way a job burns
  -- an attempt is by FAILING, and markJobFailed (lib/whatsapp/
  -- analysis-queue.ts) releases a failed job back to 'queued' so the next
  -- tick retries it. So the third failure left the row sitting in
  -- 'queued' with attempts = 3, where:
  --
  --   * the claim below will not take it   (attempts < max_attempts)
  --   * this retirement will not retire it (status = 'running')
  --
  -- It stays there forever. And because isBatchSettled counts every
  -- queued-or-running job in the batch, that batch NEVER settles:
  -- claimBatchFinalization never fires, the seller's session never leaves
  -- 'analyzing', and every message they send from then on is answered
  -- with "⏳ Still drafting your products — hang tight." The only way out
  -- is for the seller to guess that *restart* exists.
  --
  -- Three transient Gemini failures on one product is all it takes. The
  -- fix is to retire on exhausted attempts whatever the status, which is
  -- what "gave up" was always supposed to mean.
  update analysis_jobs
  set status     = 'failed',
      error      = coalesce(error, 'Gave up after ' || max_attempts || ' attempts'),
      updated_at = now()
  where attempts >= max_attempts
    and (
      status = 'queued'
      or (status = 'running' and locked_at < now() - stale_after)
    );

  return query
  with candidates as (
    select id, user_rank, created_at
    from (
      select id,
             created_at,
             row_number() over (partition by user_id order by created_at, id) as user_rank
      from analysis_jobs
      where attempts < max_attempts
        -- The settle window. A stale 'running' row is minutes old by
        -- definition, so this only ever gates genuinely fresh work.
        and created_at <= now() - settle_after
        and (
          status = 'queued'
          or (status = 'running' and locked_at < now() - stale_after)
        )
    ) ranked
    order by user_rank, created_at, id
    -- Wide enough that concurrent workers don't collide into an empty
    -- claim; see 2026-09-14_fair-job-claiming.sql. Scales with claim_limit
    -- so raising that doesn't silently narrow the margin.
    limit greatest(claim_limit * 10, 50)
  ),
  locked as (
    select j.id
    from analysis_jobs j
    join candidates c on c.id = j.id
    order by c.user_rank, c.created_at, j.id
    limit claim_limit
    for update of j skip locked
  )
  update analysis_jobs j
  set status     = 'running',
      locked_at  = now(),
      attempts   = j.attempts + 1,
      updated_at = now()
  from locked
  where j.id = locked.id
  returning j.*;
end;
$$;
