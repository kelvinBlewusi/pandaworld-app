-- ─── One every-minute job instead of two ─────────────────────────────────────
--
-- Supabase meters Logs Ingest (1 GB a cycle on this Free organization,
-- 82% used on 2026-09-29), and pg_cron writes a "cron job N starting" and
-- a "cron job N completed" line for every run: ~540 bytes each with
-- Supabase's metadata. cron.log_statement can't be switched off here
-- (postmaster setting). With analyze-jobs-worker and jumia-feed-poll both
-- running every minute that was 5,760 lines (~3 MB) a day, most of what
-- the project still logged once
-- 2026-09-28_cron-only-when-there-is-work.sql stopped the idle calls.
--
-- Same checks, same calls, one job: 'minute-workers'. Each half still only
-- calls Vercel when it has work (see that migration for the rules), and
-- the run's "N rows" is how many calls it made, 0 when idle.

select cron.unschedule('analyze-jobs-worker') where exists (select 1 from cron.job where jobname = 'analyze-jobs-worker');
select cron.unschedule('jumia-feed-poll')     where exists (select 1 from cron.job where jobname = 'jumia-feed-poll');
select cron.unschedule('minute-workers')      where exists (select 1 from cron.job where jobname = 'minute-workers');

select cron.schedule(
  'minute-workers',
  '* * * * *',
  $$
  with secret as materialized (
    select decrypted_secret as token from vault.decrypted_secrets where name = 'cron_secret'
  ),
  -- Analysis queue: queued or stale running jobs (one worker per 2, up to
  -- 3), or a settled batch still waiting for its closing message.
  workers as materialized (
    select greatest(
      least(3, ceil((
        select count(*) from public.analysis_jobs
        where status = 'queued' or (status = 'running' and locked_at < now() - interval '5 minutes')
      ) / 2.0)::int),
      case when exists (select 1 from public.find_unfinalized_settled_batches()) then 1 else 0 end
    ) as n
  ),
  worker_calls as materialized (
    select net.http_post(
      url     := 'https://pandaworldai.site/api/worker/analyze-jobs',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || secret.token)
    ) as request_id
    from secret, workers, generate_series(1, workers.n)
  ),
  -- Jumia feeds: while one is pending, every minute for its first 30
  -- minutes, every 10 after.
  feed_calls as materialized (
    select net.http_get(
      url     := 'https://pandaworldai.site/api/cron/jumia-feeds',
      headers := jsonb_build_object('Authorization', 'Bearer ' || secret.token)
    ) as request_id
    from secret
    where exists (
      select 1 from public.listings
      where status = 'pending_approval'
        and jumia_ref is not null
        and (updated_at > now() - interval '30 minutes' or extract(minute from now())::int % 10 = 0)
    )
  )
  select request_id from worker_calls
  union all
  select request_id from feed_calls;
  $$
);
