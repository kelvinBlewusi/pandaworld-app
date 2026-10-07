-- ─── Image polish in the chat (owner, 2026-10-07) ───────────────────────────
--
-- When a chat listing's notes ask for polished photos (lib/whatsapp/note-
-- intent.ts polish_images), or the seller sends "polish 2", four product
-- photos are made from theirs (lib/whatsapp/chat-polish.ts), at
-- POLISH_CREDIT_COST an image. polish_status: queued, running, done,
-- failed, skipped (not enough credits, no photos, already submitted).
-- original_images keeps the seller's own photos as they were.

alter table public.listings
  add column if not exists polish_status       text,
  add column if not exists polish_requested_at timestamptz,
  add column if not exists original_images     text[];

create index if not exists listings_polish_queued
  on public.listings (polish_requested_at)
  where polish_status in ('queued', 'running');
