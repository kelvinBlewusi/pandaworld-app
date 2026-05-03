-- Phase 4A: Jumia OAuth connections table
-- Run in Supabase: Dashboard → SQL Editor → New query → Paste → Run

create table if not exists jumia_connections (
  id                  uuid primary key default gen_random_uuid(),
  user_id             text not null unique,      -- Clerk user ID (one connection per user)
  access_token        text not null,
  refresh_token       text,
  token_expires_at    timestamptz,               -- when access_token expires
  seller_id           text,                      -- Jumia seller/vendor ID
  seller_name         text,                      -- Display name from Jumia profile
  seller_email        text,
  store_name          text,                      -- e.g. "GEM MALL"
  status              text not null default 'active'
                        check (status in ('active', 'expired', 'revoked')),
  connected_at        timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Indexes
create index if not exists jumia_connections_user_id_idx on jumia_connections(user_id);

-- Auto-update updated_at
drop trigger if exists jumia_connections_updated_at on jumia_connections;
create trigger jumia_connections_updated_at
  before update on jumia_connections
  for each row execute function update_updated_at();

-- RLS
alter table jumia_connections enable row level security;
-- Service role bypasses RLS automatically (all access via server actions).
