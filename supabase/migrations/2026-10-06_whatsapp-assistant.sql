-- The WhatsApp assistant (lib/whatsapp/assistant.ts): free text after a
-- batch is drafted, understood by AI and carried out by our own code.
-- Piloted on admin accounts and the user ids in app_settings
-- `assistant_users` (owner, 2026-10-06).

-- A "Which product do you mean?" question the bot is waiting on: the
-- change the seller asked for and the products it could be about. Null
-- when none is outstanding; anything that isn't an answer drops it.
alter table public.whatsapp_sessions
  add column if not exists assistant_pending jsonb;

-- What sellers said and what the assistant made of it, to see where it
-- misunderstands during the pilot. Service-role only, like every table here.
create table if not exists public.whatsapp_assistant_log (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id    text        not null,
  stage      text        not null,           -- review | sent | idle
  message    text        not null,
  action     jsonb,                           -- the validated action, null when the AI call failed
  outcome    text                             -- what was done, or why not
);

create index if not exists whatsapp_assistant_log_created_idx on public.whatsapp_assistant_log (created_at desc);

alter table public.whatsapp_assistant_log enable row level security;

comment on table public.whatsapp_assistant_log is
  'Each message the WhatsApp assistant interpreted, with its action and outcome. See lib/whatsapp/assistant.ts.';
