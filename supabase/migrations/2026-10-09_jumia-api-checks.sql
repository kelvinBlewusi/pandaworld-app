-- ─── Daily checks of every Jumia read request the chat relies on ────────────
--
-- One row per check per run (lib/jumia/api-checks.ts), against the owner's own
-- shop: which request, whether it worked, how long it took, what it found.
-- Shown on /admin/jumia-api; a failure is sent to the owner on WhatsApp.
-- Service role only.

create table if not exists public.jumia_api_checks (
  id        bigserial primary key,
  run_id    uuid not null,
  run_at    timestamptz not null default now(),
  user_id   text not null,
  check_id  text not null,
  ok        boolean not null,
  skipped   boolean not null default false,
  ms        int not null default 0,
  detail    text
);
create index if not exists jumia_api_checks_run_at_idx on public.jumia_api_checks (run_at desc);
alter table public.jumia_api_checks enable row level security;

-- Every morning at 06:13 UTC (06:13 in Ghana).
select cron.unschedule('jumia-api-checks') where exists (select 1 from cron.job where jobname = 'jumia-api-checks');
select cron.schedule(
  'jumia-api-checks',
  '13 6 * * *',
  $$
  select net.http_post(
    url     := 'https://pandaworldai.site/api/worker/jumia-api-checks',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    timeout_milliseconds := 60000
  )
  $$
);
