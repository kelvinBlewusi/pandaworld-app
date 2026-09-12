-- WhatsApp chatbot, Stage 4: multi-product batches.
--
-- Lets a seller list several products in one WhatsApp conversation instead
-- of one listing per session: link -> "how many products?" -> photos+notes
-- for product 1, reply "done", repeat for each product -> one consolidated
-- review link once the batch is complete -> "submit" / "submit 2 4" / a
-- "2: change price to 150"-style edit, all still in chat.
--
-- whatsapp_sessions gains:
--   batch_id    groups every listing created during one such run.
--   batch_size  how many products the seller said they're listing (1-20).
--   batch_seq   which product number is currently being collected.
--
-- New state 'awaiting_count' is the fresh-session default -- the seller is
-- asked how many products before any photo is accepted. awaiting_photos
-- and awaiting_confirmation are unchanged in name but now operate within a
-- batch (a single-product batch, batch_size=1, behaves the same as the
-- original single-listing flow).
--
-- listings gains whatsapp_batch_id/whatsapp_seq so a batch's listings can
-- be fetched together, in order, from both the webhook (submit/edit-by-
-- number) and the new /extension/whatsapp-listings review page.
--
-- Run in Supabase: Dashboard -> SQL Editor -> New query -> Paste -> Run.
-- Idempotent -- re-running is a no-op.

alter table whatsapp_sessions drop constraint if exists whatsapp_sessions_state_check;
alter table whatsapp_sessions add constraint whatsapp_sessions_state_check
  check (state in ('awaiting_count', 'awaiting_photos', 'analyzing', 'awaiting_confirmation', 'error'));

alter table whatsapp_sessions alter column state set default 'awaiting_count';

alter table whatsapp_sessions add column if not exists batch_id   text;
alter table whatsapp_sessions add column if not exists batch_size int;
alter table whatsapp_sessions add column if not exists batch_seq  int;

alter table listings add column if not exists whatsapp_batch_id text;
alter table listings add column if not exists whatsapp_seq      int;

create index if not exists listings_whatsapp_batch_id_idx on listings(whatsapp_batch_id) where whatsapp_batch_id is not null;
