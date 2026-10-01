-- The held product's missing field the WhatsApp bot asked the seller for
-- ("Jumia needs its Weight (kg)"), as {"listingId": "...", "field":
-- "product_weight"}, so the reply is saved as that field. Null when no such
-- question is outstanding. See askForNextMissingValue in
-- lib/whatsapp/intake.ts and lib/whatsapp/missing-value.ts.
alter table public.whatsapp_sessions add column if not exists awaiting_value_for jsonb;
