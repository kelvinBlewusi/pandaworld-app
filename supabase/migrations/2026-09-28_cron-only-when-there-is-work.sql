-- ─── Only wake Vercel when there is work ────────────────────────────────────
--
-- The Vercel Hobby plan includes 4 hours of Active CPU a month, and
-- the pg_cron jobs alone were using all of it: about 6,000 calls a day to
-- pandaworldai.site, nearly all of which found nothing to do (on 2026-09-28:
-- no queued jobs, no pending feeds, 254 calls in the hour).
--
-- Each job now asks Postgres first and only makes the HTTP call when there
-- is something for the route to do. The checks mirror what each route looks
-- for, so no work is skipped:
--
--   analyze-jobs-worker    queued jobs (including ones claim_analysis_jobs
--                          needs to retire) and stale running ones, or a
--                          settled batch that never got its closing message
--                          (find_unfinalized_settled_batches). One worker
--                          per CLAIM_LIMIT (2) jobs, up to the old 3.
--   jumia-feed-poll        a pending feed. Every minute while one was
--                          submitted in the last 30 minutes (Jumia usually
--                          answers within minutes), every 10 minutes after.
--                          A feed that isn't finished doesn't touch
--                          updated_at (refreshPendingFeedStatus), so it
--                          still says when the listing was submitted.
--   jumia-keepalive        a Self Authorization connection within 6 hours of
--                          expiring (RENEW_WITHIN_MS / isDueForRenewal in
--                          lib/jumia/keepalive.ts).
--   platform-health-check  hourly instead of every 5 minutes.
--
-- cron.alter_job keeps each job's id and run history. Nothing here holds a
-- secret: the commands only name the Vault lookup.

select cron.alter_job(
  job_id  := (select jobid from cron.job where jobname = 'analyze-jobs-worker'),
  command := $$
  with secret as (
    select decrypted_secret as token
    from vault.decrypted_secrets
    where name = 'cron_secret'
  ),
  work as (
    select count(*) as jobs
    from public.analysis_jobs
    where status = 'queued'
       or (status = 'running' and locked_at < now() - interval '5 minutes')
  ),
  workers as (
    select greatest(
      least(3, ceil(work.jobs / 2.0)::int),
      case when exists (select 1 from public.find_unfinalized_settled_batches()) then 1 else 0 end
    ) as n
    from work
  )
  select net.http_post(
    url     := 'https://pandaworldai.site/api/worker/analyze-jobs',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || secret.token
    )
  )
  from secret, workers, generate_series(1, workers.n);
  $$
);

select cron.alter_job(
  job_id  := (select jobid from cron.job where jobname = 'jumia-feed-poll'),
  command := $$
  select net.http_get(
    url     := 'https://pandaworldai.site/api/cron/jumia-feeds',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'
      )
    )
  )
  where exists (
    select 1
    from public.listings
    where status = 'pending_approval'
      and jumia_ref is not null
      and (
        updated_at > now() - interval '30 minutes'
        or extract(minute from now())::int % 10 = 0
      )
  );
  $$
);

select cron.alter_job(
  job_id  := (select jobid from cron.job where jobname = 'jumia-keepalive'),
  command := $$
  select net.http_post(
    url     := 'https://pandaworldai.site/api/worker/jumia-keepalive',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'
      )
    )
  )
  where exists (
    select 1
    from public.jumia_connections
    where auth_type = 'self'
      and status = 'active'
      and refresh_token is not null
      and (
        token_expires_at is null
        or token_expires_at <= now() + interval '6 hours'
        or refresh_token_expires_at is null
        or refresh_token_expires_at <= now() + interval '6 hours'
      )
  );
  $$
);

select cron.alter_job(
  job_id   := (select jobid from cron.job where jobname = 'platform-health-check'),
  schedule := '7 * * * *'
);
