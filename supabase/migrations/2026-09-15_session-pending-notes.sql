-- Hold a seller's note that arrived BEFORE the photo it belongs to.
--
-- WhatsApp does not guarantee the order of separate webhook deliveries,
-- and a photo carries far more payload than a line of text. Confirmed
-- live: a seller sent a photo and its notes together; the text was
-- handled first, found no listing for that product yet, and
-- handleAwaitingPhotos dropped it on the floor —
--
--   if (notes && listingId) await applyNotes(listingId, notes);
--
-- — then answered "Send at least one photo for product 2 first". The
-- photo landed a moment later and drafted with no price, no variants and
-- no sale window. The seller had typed all three.
--
-- Parking the note here means the later photo can flush it, so arrival
-- order stops deciding whether a seller's instructions survive. One text
-- column rather than a queue: a second note before the photo is the
-- seller correcting themselves, and appending is what they'd expect.

alter table public.whatsapp_sessions
  add column if not exists pending_notes text;

comment on column public.whatsapp_sessions.pending_notes is
  'Seller note received before this product had a listing to attach it to. Flushed and cleared the moment one exists.';
