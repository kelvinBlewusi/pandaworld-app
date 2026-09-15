-- Ask for a missing price IN CHAT instead of sending the seller to the web.
--
-- "No price" is the commonest reason a drafted product never reaches
-- Jumia. In one real 10-product session on 2026-09-15, five of the ten
-- were blocked on it: every one had photos, a title, a category and a
-- brand, and every one needed the seller to leave WhatsApp, open the
-- review page and type a number. Three of those five had actually STATED
-- their price in the note ("110 ghs sold in singles", a bare "210" on its
-- own line) — those are fixed in lib/whatsapp/batch.ts's extractPrice.
-- The remaining two simply never said one, and this column is for them.
--
-- Holds the listing the bot has just asked about, so a bare "150" can be
-- read as that product's price without guessing. Null whenever no such
-- question is outstanding — which is the normal state, and what every
-- non-price reply resets it to.
alter table public.whatsapp_sessions
  add column if not exists awaiting_price_for uuid;

comment on column public.whatsapp_sessions.awaiting_price_for is
  'The listing the bot has just asked the seller for a price for, in chat. '
  'A bare number is only read as a price while this is set. See '
  'askForNextMissingPrice in lib/whatsapp/intake.ts.';
