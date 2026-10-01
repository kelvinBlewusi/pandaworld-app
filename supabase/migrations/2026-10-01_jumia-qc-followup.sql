-- ─── Follow a listing past "live" until Jumia's quality check decides ───────
--
-- A feed that finishes without errors means Jumia CREATED the product, not
-- that it passed quality control. QC runs afterwards and can still reject:
-- on 2026-09-30 a Malta Guinness listing and a body lotion were both
-- announced "live" in WhatsApp, then rejected in Vendor Center ("Wrong
-- Category: Category mismatch: AI suggests Grocery / Beverages / Bottled
-- Beverages, Water & Drink Mixes / Soft Drinks …"), and nothing told the
-- seller. GET /catalog/products carries each product's qc status and
-- rejection reason; app/api/cron/jumia-feeds now reads it for the listings
-- below (lib/jumia/qc-followup.ts).
--
-- A listing is checked while its QC status isn't final: every few minutes
-- for its first 2 hours live, every 30 minutes until it's 3 days old, and
-- at least once whatever its age (so listings that went live before this
-- existed get one check). jumia_qc_checked_at paces it; updated_at can't,
-- since the listings_updated_at trigger moves it on every write.

alter table public.listings add column if not exists jumia_qc_checked_at timestamptz;

create or replace function public.qc_followup_candidates()
returns table (
  id                uuid,
  user_id           text,
  jumia_ref         text,
  title             text,
  whatsapp_batch_id text,
  whatsapp_seq      integer,
  sku               text,
  category_code     text,
  live_at           timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select l.id, l.user_id, l.jumia_ref, l.title, l.whatsapp_batch_id, l.whatsapp_seq, l.sku, l.category_code, o.live_at
  from listings l
  left join lateral (
    select max(f.created_at) as live_at
    from jumia_feed_outcomes f
    where f.listing_id = l.id and f.feed_id = l.jumia_ref and f.outcome = 'live'
  ) o on true
  where l.status = 'live'
    and l.jumia_ref is not null
    and coalesce(lower(l.jumia_qc_status), '') not in ('approved', 'rejected')
    and (
      l.jumia_qc_checked_at is null
      or (
        o.live_at > now() - interval '3 days'
        and l.jumia_qc_checked_at < now() - case
          when o.live_at > now() - interval '2 hours' then interval '4 minutes'
          else interval '30 minutes'
        end
      )
    )
$$;

revoke execute on function public.qc_followup_candidates() from public, anon, authenticated;
grant execute on function public.qc_followup_candidates() to service_role;

-- The 'minute-workers' job (2026-09-29_one-every-minute-cron-job.sql) now
-- also calls the feeds route while a listing is due a QC check.
select cron.alter_job(
  (select jobid from cron.job where jobname = 'minute-workers'),
  command := $cmd$
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
  )
  select request_id from worker_calls
  union all
  select request_id from feed_calls;
  $cmd$
);
