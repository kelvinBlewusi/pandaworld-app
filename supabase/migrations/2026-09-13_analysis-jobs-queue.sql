-- Background queue for WhatsApp batch product analysis.
--
-- Why this exists: startBatchAnalysis used to run every product's analysis
-- concurrently INSIDE the WhatsApp webhook, which Vercel kills at 60s. One
-- product measured 22.7s in production, so the batch cap had to sit at 5
-- and anything that missed ANALYSIS_DEADLINE_MS reported "still finishing"
-- to the seller having produced nothing. Moving the work behind a queue
-- turns "too many products" from a hard failure into a longer wait, which
-- is the whole point — the per-request ceiling stops being the constraint.
--
-- Drained by /api/worker/analyze-jobs, which pg_cron calls every minute
-- (Vercel's Hobby plan caps its own cron at once a DAY, which is why the
-- schedule lives in Postgres rather than vercel.json).

create table if not exists analysis_jobs (
  id            uuid primary key default gen_random_uuid(),
  listing_id    uuid not null references listings(id) on delete cascade,
  batch_id      uuid not null,
  user_id       text not null,
  phone_number  text not null,
  seq           integer,
  batch_size    integer not null default 1,
  status        text not null default 'queued',
  attempts      integer not null default 0,
  locked_at     timestamptz,
  error         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint analysis_jobs_status_check
    check (status in ('queued', 'running', 'done', 'failed'))
);

-- The claim query's access path: oldest unfinished job first.
create index if not exists analysis_jobs_pending_idx
  on analysis_jobs (status, created_at)
  where status in ('queued', 'running');

-- Batch-completion checks ("is this the last one?") filter by batch.
create index if not exists analysis_jobs_batch_idx
  on analysis_jobs (batch_id);

-- One in-flight job per listing. Without this a double-tap, a WhatsApp
-- webhook redelivery, or a retry could enqueue the same product twice and
-- the seller would be charged twice for one draft.
create unique index if not exists analysis_jobs_one_inflight_per_listing
  on analysis_jobs (listing_id)
  where status in ('queued', 'running');

alter table analysis_jobs enable row level security;
-- No policies — only the service-role client (the worker route and the
-- WhatsApp webhook) ever touches this. Same posture as
-- jumia_category_sync_health and category_corrections.

-- Atomically hand a worker its next batch of jobs.
--
-- FOR UPDATE SKIP LOCKED is what makes this safe to call concurrently: two
-- overlapping worker ticks (a pg_cron run and the webhook's own nudge, say)
-- each get a disjoint set instead of both grabbing the same rows and
-- analysing — and billing — the same product twice.
--
-- Also recovers jobs whose worker died mid-run: a 'running' row whose
-- locked_at has gone stale is claimable again. Anything that has burned
-- through max_attempts is retired to 'failed' instead of retrying forever,
-- so a permanently-broken listing can't wedge its batch open.
create or replace function claim_analysis_jobs(
  claim_limit  integer,
  stale_after  interval default interval '5 minutes',
  max_attempts integer  default 3
)
returns setof analysis_jobs
language plpgsql
as $$
begin
  update analysis_jobs
  set status     = 'failed',
      error      = coalesce(error, 'Gave up after ' || max_attempts || ' attempts'),
      updated_at = now()
  where status = 'running'
    and locked_at < now() - stale_after
    and attempts >= max_attempts;

  return query
  with claimed as (
    select id
    from analysis_jobs
    where attempts < max_attempts
      and (
        status = 'queued'
        or (status = 'running' and locked_at < now() - stale_after)
      )
    order by created_at
    limit claim_limit
    for update skip locked
  )
  update analysis_jobs j
  set status     = 'running',
      locked_at  = now(),
      attempts   = j.attempts + 1,
      updated_at = now()
  from claimed
  where j.id = claimed.id
  returning j.*;
end;
$$;
