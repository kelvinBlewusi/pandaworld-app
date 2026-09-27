-- Ask the seller for the category IN CHAT when Jumia keeps refusing ours.
--
-- When a "You can't list products in this category" rejection repeats
-- after one automatic redraft, the bot used to hand the seller the editor
-- link. The seller can see which categories Vendor Center accepts and we
-- can't, so the bot now asks them instead (a list of suggestions, or a
-- typed category name) and switches the category and resubmits itself.
--
-- Holds the listing the bot has just asked about, so a typed reply can be
-- read as that product's category. Null whenever no such question is
-- outstanding. Same shape and lifecycle as awaiting_price_for (see
-- 2026-09-15_session-awaiting-price-for.sql).
alter table public.whatsapp_sessions
  add column if not exists awaiting_category_for uuid;

comment on column public.whatsapp_sessions.awaiting_category_for is
  'The listing the bot has just asked the seller to name a Jumia category '
  'for, after Jumia refused ours twice. A typed reply is only read as a '
  'category while this is set. See askSellerForCategory in '
  'lib/whatsapp/intake.ts.';
