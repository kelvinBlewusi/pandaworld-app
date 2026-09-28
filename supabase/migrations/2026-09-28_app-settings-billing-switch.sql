-- App-wide settings an admin changes at runtime, without a redeploy.
-- First (and so far only) key: billing_enabled — the switch between free
-- for everyone and charging credits (lib/billing/mode.ts, flipped from
-- /admin/billing). Replaces the FREE_FOR_ALL_MODE code constant.

create table if not exists public.app_settings (
  key        text        primary key,
  value      jsonb       not null,
  updated_at timestamptz not null default now(),
  updated_by text                              -- Clerk user id of the admin who last changed it
);

-- Starts off: everyone stays free until an admin switches billing on.
insert into public.app_settings (key, value)
values ('billing_enabled', 'false'::jsonb)
on conflict (key) do nothing;

-- Service-role only, like every other table here.
alter table public.app_settings enable row level security;

comment on table public.app_settings is
  'Runtime app settings changed from the admin pages. billing_enabled: see lib/billing/mode.ts.';
