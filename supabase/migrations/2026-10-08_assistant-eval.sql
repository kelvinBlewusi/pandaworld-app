-- ─── The assistant's test set, run against the real AI ─────────────────────
--
-- One row per run of lib/evals/assistant-cases.ts (owner, 2026-10-08: "how do
-- we make sure that the next solution we offer for the problem does not
-- conflict the past solution"). Queued from /admin/assistant-tests (or by
-- inserting a row), worked through by app/api/worker/assistant-eval. Service
-- role only.

create table if not exists public.assistant_eval_runs (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  status       text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  model        text not null,
  note         text,
  total        int not null default 0,
  done         int not null default 0,
  passed       int not null default 0,
  passed_bare  int not null default 0,
  errors       int not null default 0,
  results      jsonb not null default '[]'::jsonb,
  locked_until timestamptz,
  finished_at  timestamptz
);
create index if not exists assistant_eval_runs_created_idx on public.assistant_eval_runs (created_at desc);
alter table public.assistant_eval_runs enable row level security;

-- Each minute, only while a run is waiting or under way.
select cron.unschedule('assistant-eval') where exists (select 1 from cron.job where jobname = 'assistant-eval');
select cron.schedule(
  'assistant-eval',
  '* * * * *',
  $$
  select net.http_post(
    url     := 'https://pandaworldai.site/api/worker/assistant-eval',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    )
  )
  where exists (select 1 from public.assistant_eval_runs where status in ('queued', 'running'))
  $$
);
