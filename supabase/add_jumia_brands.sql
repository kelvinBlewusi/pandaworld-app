-- Phase 5C: Jumia brand catalog cache
-- Run in Supabase: Dashboard → SQL Editor → New query → Paste → Run

create table if not exists jumia_brands (
  id        serial      primary key,
  code      integer     not null unique,   -- Jumia numeric brand code
  name      text        not null,          -- e.g. "Samsung"
  synced_at timestamptz not null default now()
);

-- Fast prefix search used by brand autocomplete (e.g. "Sam" → Samsung)
create index if not exists idx_jumia_brands_name_lower on jumia_brands(lower(name));

comment on table jumia_brands is
  'Jumia brand catalog synced from GET /catalog/brands (paginated).
   Used by resolveBrand() at push time and the brand autocomplete in the review form.
   Sync via POST /api/admin/jumia/sync-brands.';
