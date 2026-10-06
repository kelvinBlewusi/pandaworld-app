-- ─── New-order alerts on WhatsApp ────────────────────────────────────────────
--
-- lib/whatsapp/order-alerts.ts polls each eligible seller's pending Jumia
-- orders (Jumia has no order webhooks) and alerts each order once. This table
-- remembers which orders were alerted, and when, for the 30-minute gap
-- between alerts. Service role only.

create table if not exists public.order_alerts (
  user_id      text        not null,
  order_id     text        not null,
  order_number text,
  alerted_at   timestamptz not null default now(),
  primary key (user_id, order_id)
);
create index if not exists order_alerts_user_alerted on public.order_alerts (user_id, alerted_at desc);
alter table public.order_alerts enable row level security;

-- Called from the every-minute job rather than a job of its own: pg_cron
-- logs two lines per run whatever it does (2026-09-29_one-every-minute-cron-
-- job.sql), and this adds none. Every 10 minutes (minute 5, 15, …), and only
-- while some seller has both WhatsApp linked and Jumia connected; the route
-- itself checks each one's pack.
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
  )
  select request_id from worker_calls
  union all
  select request_id from feed_calls
  union all
  select request_id from order_calls;
  $$
);
