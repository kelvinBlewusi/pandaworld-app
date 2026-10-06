-- A message from PandaWorld to one seller, shown in the extension panel
-- (GET /api/extension/account -> notices) and the dashboard's notification
-- bell (components/extension/shell.tsx) until they dismiss it. First used to
-- tell a seller that Polish images was unlocked for them (2026-10-06).
-- Added by hand in SQL; there is no page for it.
create table if not exists public.user_notices (
  id           uuid primary key default gen_random_uuid(),
  user_id      text not null,
  title        text not null,
  -- Plain text. *word* is shown bold; a blank line starts a new paragraph.
  body         text not null,
  created_at   timestamptz not null default now(),
  dismissed_at timestamptz
);

create index if not exists user_notices_open
  on public.user_notices (user_id, created_at desc)
  where dismissed_at is null;

-- Server only (the service role), like the credit ledger.
alter table public.user_notices enable row level security;
revoke all on public.user_notices from anon, authenticated;
