-- What the assistant remembers about each seller across their whole journey
-- (lib/whatsapp/seller-memory.ts): a short running summary, refreshed by the
-- AI every few of their messages. Server-only (service role), like the
-- message log it's made from.
create table if not exists seller_memory (
  user_id       text primary key,
  summary       text not null default '',
  since_refresh int  not null default 0,
  updated_at    timestamptz not null default now()
);
alter table seller_memory enable row level security;
