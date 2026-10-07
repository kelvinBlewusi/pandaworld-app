-- ─── The polish worker in the every-minute job ──────────────────────────────
--
-- app/api/worker/polish-images polishes chat listings whose notes asked for
-- it (lib/whatsapp/chat-polish.ts). It's nudged when one is queued; this
-- calls it each minute while any waits, or a run was cut off (running for
-- more than 5 minutes), so a lost nudge doesn't leave a product waiting.
-- The rest of 'minute-workers' is as in 2026-10-06_order-alerts.sql.

select cron.unschedule('minute-workers') where exists (select 1 from cron.job where jobname = 'minute-workers');

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
  -- minutes, every 10 after. Also while a live listing is due a QC check
  -- (qc_followup_candidates paces those itself).
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
    or exists (select 1 from public.qc_followup_candidates())
  ),
  -- Order alerts: every 10 minutes while a seller could get one.
  order_calls as materialized (
    select net.http_post(
      url     := 'https://pandaworldai.site/api/worker/order-alerts',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || secret.token)
    ) as request_id
    from secret
    where extract(minute from now())::int % 10 = 5
      and exists (
        select 1 from public.whatsapp_connections w
        join public.jumia_connections j on j.user_id = w.user_id and j.status <> 'revoked'
      )
  ),
  -- Chat polish: while a listing's photos wait, or a run was cut off.
  polish_calls as materialized (
    select net.http_post(
      url     := 'https://pandaworldai.site/api/worker/polish-images',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || secret.token)
    ) as request_id
    from secret
    where exists (
      select 1 from public.listings
      where polish_status = 'queued'
         or (polish_status = 'running' and updated_at < now() - interval '5 minutes')
    )
  )
  select request_id from worker_calls
  union all
  select request_id from feed_calls
  union all
  select request_id from order_calls
  union all
  select request_id from polish_calls;
  $$
);
