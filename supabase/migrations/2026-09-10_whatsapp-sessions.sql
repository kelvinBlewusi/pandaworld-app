-- WhatsApp chatbot, Stage 3: conversation state.
--
-- One row per linked phone number, tracking where that seller is in the
-- photo-intake -> analyze -> confirm loop:
--
--   awaiting_photos        default once linked. Incoming images get
--                          uploaded and appended to a draft listing (created
--                          on the first photo); other text is stored as
--                          free-text seller context for the AI.
--   analyzing              seller replied "done" — the auto-analyze
--                          pipeline is running for listing_id.
--   awaiting_confirmation  a draft summary was sent back; the seller is
--                          reviewing/finishing it (in-app for now — see
--                          lib/whatsapp/intake.ts, Stage 4 will let this
--                          happen entirely in chat).
--   error                  something failed hard enough that we punt back
--                          to a clean slate on the next message.
--
-- last_message_id records the most recently processed WhatsApp message id
-- (wamid) so a Meta webhook retry (same delivery resent because we didn't
-- ack fast enough) doesn't re-run analysis or double-charge a Gemini call.
--
-- Run in Supabase: Dashboard -> SQL Editor -> New query -> Paste -> Run.
-- Idempotent — re-running is a no-op.

create table if not exists whatsapp_sessions (
  phone_number    text primary key,
  user_id         text not null,
  state           text not null default 'awaiting_photos'
                    check (state in ('awaiting_photos', 'analyzing', 'awaiting_confirmation', 'error')),
  listing_id      uuid references listings(id) on delete set null,
  last_message_id text,
  updated_at      timestamptz not null default now()
);

create index if not exists whatsapp_sessions_user_id_idx on whatsapp_sessions(user_id);

drop trigger if exists whatsapp_sessions_updated_at on whatsapp_sessions;
create trigger whatsapp_sessions_updated_at
  before update on whatsapp_sessions
  for each row execute function update_updated_at();

alter table whatsapp_sessions enable row level security;
-- Service role bypasses RLS automatically (all access via server actions/routes).
