-- WhatsApp chatbot: connect Jumia entirely from chat.
--
-- A brand-new seller who links WhatsApp before ever connecting Jumia on the
-- web now gets walked through it right there: create the app in Jumia
-- Vendor Center, paste the Client ID + Client Secret in chat (credentials
-- get validated + saved the same way the web onboarding form does — see
-- lib/jumia/credentials.ts), then tap a one-time link to finish the
-- OAuth consent step in a browser (that part genuinely can't happen inside
-- WhatsApp — Jumia's own login/approve screen requires one). The listing
-- flow (awaiting_count) only unlocks once that OAuth step actually
-- completes, via app/api/jumia/callback/route.ts.
--
-- New whatsapp_sessions states:
--   awaiting_jumia_credentials  waiting for "Client ID" + "Client Secret"
--                               (pasted together or one message each —
--                               pending_app_id holds the first one while
--                               waiting for the second).
--   awaiting_jumia_oauth        credentials saved; waiting for the seller
--                               to tap the one-time connect link and
--                               approve in Jumia Vendor Center.
--
-- jumia_connect_tokens is the one-time link's backing store — same shape
-- and reasoning as whatsapp_link_codes (see 2026-09-10_whatsapp-connections.sql):
-- a short-lived, single-use, unguessable nonce delivered over a channel
-- (the seller's own linked WhatsApp number) already tied to their account.
-- It only ever triggers a redirect to Jumia's OWN login/consent page — it
-- doesn't grant access to anything in PandaWorld by itself, so it can
-- safely stand in for a Clerk session on a device the seller isn't
-- actively logged into.
--
-- Run in Supabase: Dashboard -> SQL Editor -> New query -> Paste -> Run.
-- Idempotent -- re-running is a no-op.

alter table whatsapp_sessions drop constraint if exists whatsapp_sessions_state_check;
alter table whatsapp_sessions add constraint whatsapp_sessions_state_check
  check (state in (
    'awaiting_jumia_credentials', 'awaiting_jumia_oauth',
    'awaiting_count', 'awaiting_photos', 'analyzing', 'awaiting_confirmation', 'error'
  ));

alter table whatsapp_sessions add column if not exists pending_app_id text;

create table if not exists jumia_connect_tokens (
  token      text primary key,
  user_id    text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz
);

create index if not exists jumia_connect_tokens_user_id_idx on jumia_connect_tokens(user_id);

alter table jumia_connect_tokens enable row level security;
-- Service role bypasses RLS automatically (all access via server actions/routes).
