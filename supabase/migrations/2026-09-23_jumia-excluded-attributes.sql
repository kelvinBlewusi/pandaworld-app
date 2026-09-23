-- Persistent memory of attributes Jumia's own schema endpoint lists for a
-- category but its real product-creation validation rejects as "not
-- visible for category" — a genuine mismatch on Jumia's side between
-- GET /catalog/categories/{code}/attributes and POST /feeds/products/create.
--
-- removeAttributesFromCache (lib/jumia/categories.ts) used to just DELETE
-- the offending rows from jumia_category_attributes once a live rejection
-- named them. That fixes the listing that hit the rejection, but the fix
-- didn't last: the very next cold-cache fetch for that category (a
-- DIFFERENT listing, a nightly resync, an admin re-sync) called
-- upsertAttributes with Jumia's own (still-wrong) schema response and
-- silently re-inserted the same attributes — the category regressed to
-- rejecting every listing filed there again, one at a time, forever.
-- Real incident, 2026-09-23: "Android Tablets"/"Android Phones" both
-- rejected on the very first push with "Attribute [X] is not visible for
-- category [Y]" for 7-8 attributes at once, with no prior fix cycle to
-- have caused it — Jumia's schema endpoint was simply wrong from the
-- start for these categories.
--
-- This table is the durable half of the fix: once an attribute is
-- confirmed not-visible for a category, upsertAttributes refuses to
-- re-insert it, for every future listing filed in that category — not
-- just the one whose rejection happened to surface it.
create table if not exists jumia_excluded_attributes (
  category_code integer not null,
  name          text not null,
  excluded_at   timestamptz not null default now(),
  primary key (category_code, name)
);

alter table jumia_excluded_attributes enable row level security;
-- No policies defined — same pattern as jumia_category_attributes itself:
-- only the service-role client (lib/jumia/categories.ts) ever reads or
-- writes this; no anon/authenticated client needs direct access.
