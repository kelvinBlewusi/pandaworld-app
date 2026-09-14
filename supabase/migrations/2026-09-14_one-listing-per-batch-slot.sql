-- One listing per (chat batch, position). Closes a race that produced a
-- separate listing per PHOTO.
--
-- WhatsApp delivers an album as several webhook messages within the same
-- second. handleAwaitingPhotos read the session, saw no listing yet for
-- the current product, and created one — so two photos of a single
-- product arriving together had both deliveries pass that check and both
-- create a listing. Confirmed live: two "4 Burner Gas ..." listings with
-- created_at 115 ms apart, one holding the seller's note and the other
-- an orphan with photos and nothing else.
--
-- The index is the part that actually closes it. Selecting first narrows
-- the window but cannot remove it; only a uniqueness constraint the
-- database enforces can, because the losing INSERT has to fail so the
-- caller knows to adopt the winner's listing instead.
--
-- Partial, so it constrains only chat-originated listings. Web listings
-- carry NULL in both columns and must stay unconstrained — in Postgres
-- NULLs never conflict, but being explicit here says the scope is
-- deliberate rather than incidental.

create unique index if not exists listings_whatsapp_batch_slot_uniq
  on public.listings (whatsapp_batch_id, whatsapp_seq)
  where whatsapp_batch_id is not null and whatsapp_seq is not null;
