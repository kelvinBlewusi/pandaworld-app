-- WhatsApp chatbot, Stage 1: account linking.
--
-- Two tables:
--   whatsapp_link_codes — short-lived, single-use codes generated from
--     Settings → Integrations. The seller taps a wa.me deep link that
--     pre-fills "LINK-<code>" as the first message; the webhook matches it
--     back to the user who generated it. Stored as PLAINTEXT (unlike
--     extension_api_keys' hashed secrets) deliberately: this is a ~15-minute,
--     single-use linking nonce, not a long-lived bearer credential, so the
--     extra hashing machinery buys nothing here.
--   whatsapp_connections — the resulting link: one row per phone number,
--     pointing at the PandaWorld user (Clerk ID) it's linked to. A user can
--     link multiple numbers; a number can only ever link to one user.
--
-- Run in Supabase: Dashboard → SQL Editor → New query → Paste → Run.
-- Idempotent — re-running is a no-op.

create table if not exists whatsapp_link_codes (
  code        text primary key,             -- e.g. "A1B2C3D4"
  user_id     text not null,                -- Clerk user ID that generated this code
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);

create index if not exists whatsapp_link_codes_user_id_idx on whatsapp_link_codes(user_id);

create table if not exists whatsapp_connections (
  id            uuid primary key default gen_random_uuid(),
  user_id       text not null,              -- Clerk user ID
  phone_number  text not null unique,       -- E.164, e.g. "+233241234567"
  display_name  text,                       -- WhatsApp profile name, if Meta sends one
  linked_at     timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists whatsapp_connections_user_id_idx on whatsapp_connections(user_id);

drop trigger if exists whatsapp_connections_updated_at on whatsapp_connections;
create trigger whatsapp_connections_updated_at
  before update on whatsapp_connections
  for each row execute function update_updated_at();

alter table whatsapp_link_codes enable row level security;
alter table whatsapp_connections enable row level security;
-- Service role bypasses RLS automatically (all access via server actions/routes).
