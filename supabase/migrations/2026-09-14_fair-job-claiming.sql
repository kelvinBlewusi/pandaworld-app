-- Fair (round-robin) claiming for the analysis queue.
--
-- THE PROBLEM: claim_analysis_jobs ordered strictly by created_at. That is
-- textbook head-of-line blocking. A seller who queues 20 products at
-- 10:00:00 owns every worker slot until their batch drains; a second
-- seller who sends ONE product at 10:00:05 waits behind all 20.
--
-- Measured on the real ordering (CLAIM_LIMIT 3, ~25s per tick):
--
--   FIFO   tick 1 = A-1, A-2, A-3   → seller B's only product runs in
--                                     tick 7, about 3 minutes in
--   fair   tick 1 = A-1, B-1, A-2   → seller B's only product runs first
--                                     tick, about 25 seconds in
--
-- Seller A finishes at the same time either way. Nothing is slowed down;
-- the waiting is just shared out instead of falling entirely on whoever
-- arrived second. The per-user hourly rate limit never helped here — it
-- bounds one seller's total, not their share of a queue everybody shares.
--
-- THE FIX: rank each seller's jobs among their own (row_number partitioned
-- by user_id), then order by that rank before created_at. Every active
-- seller gets their 1st job before anyone gets their 2nd.
--
-- WHY THE CANDIDATE SET IS OVER-FETCHED: Postgres forbids FOR UPDATE in a
-- query that uses window functions, so the ranking has to happen in a
-- separate CTE from the locking. That costs the property the old
-- single-scan query got for free — SKIP LOCKED continuing past locked rows
-- to fill the limit. Two workers computing the same narrow candidate list
-- would both target the same rows and the loser would claim nothing at all
-- while real work sat queued. Over-fetching a wide candidate window and
-- applying the LIMIT at the locking step restores it: the loser skips the
-- contended rows and fills up from further down the same fair ordering.
-- This matters more now that several workers run per tick, not one.

create or replace function claim_analysis_jobs(
  claim_limit  integer,
  stale_after  interval default interval '5 minutes',
  max_attempts integer  default 3
)
returns setof analysis_jobs
language plpgsql
as $$
begin
  -- Unchanged: retire anything that has burned through its attempts, so a
  -- permanently-broken listing can't wedge its batch open forever.
  update analysis_jobs
  set status     = 'failed',
      error      = coalesce(error, 'Gave up after ' || max_attempts || ' attempts'),
      updated_at = now()
  where status = 'running'
    and locked_at < now() - stale_after
    and attempts >= max_attempts;

  return query
  with candidates as (
    select id, user_rank, created_at
    from (
      select id,
             created_at,
             row_number() over (partition by user_id order by created_at, id) as user_rank
      from analysis_jobs
      where attempts < max_attempts
        and (
          status = 'queued'
          or (status = 'running' and locked_at < now() - stale_after)
        )
    ) ranked
    order by user_rank, created_at, id
    -- Wide enough that concurrent workers don't collide into an empty
    -- claim; see the note above. Scales with claim_limit so raising that
    -- doesn't silently narrow the margin.
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

-- The ranking window partitions by user_id and orders by created_at, so
-- give it an index that matches. The existing analysis_jobs_pending_idx
-- (status, created_at) can't serve the partition.
create index if not exists analysis_jobs_fair_claim_idx
  on analysis_jobs (user_id, created_at, id)
  where status in ('queued', 'running');
