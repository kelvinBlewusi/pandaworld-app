-- Listing-level sale price + date window, mirroring selling_price.
--
-- Before this, a sale price only existed on the `variants` table — fine
-- for a listing that already has variant rows, but a simple listing
-- drafted from a WhatsApp chat has NO variant row at all until the
-- seller visits the web editor (auto-analyze only creates variant rows
-- when it detects multiple AI variations). That meant a seller who typed
-- "sale price 100 from 20 September to 30 September" in chat had nowhere
-- for it to land, and pushProductsToJumia's zero-variant path
-- (buildBaseProduct in lib/jumia/api.ts) never included a sale price in
-- its payload at all.
--
-- These columns are the fallback every variant's own sale price/dates
-- resolve to when unset — the exact same pattern selling_price already
-- has via global_price (see mapListingToJumiaProducts's
-- `v.global_price ?? listing.selling_price`). Setting sale price once at
-- the listing level applies it to every variant "no matter the variant",
-- while a seller who wants a DIFFERENT sale price per variant can still
-- override it on that variant's own row via the web editor.
--
-- Run in Supabase: Dashboard -> SQL Editor -> New query -> Paste -> Run.
-- Idempotent — re-running is a no-op.

alter table listings
  add column if not exists sale_price      numeric,
  add column if not exists sale_start_date date,
  add column if not exists sale_end_date   date;
