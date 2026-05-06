-- Per-store Jumia category + attribute cache
-- Run in Supabase SQL Editor if you want per-store category isolation.
-- The existing jumia_categories / jumia_category_attributes tables are shared
-- across all users; these per-store tables allow each store to have its own
-- synced category tree (useful for multi-region sellers).

create table if not exists jumia_categories_cache (
  id          uuid        primary key default gen_random_uuid(),
  store_id    uuid        references jumia_connections(id) on delete cascade,
  category_id text        not null,
  name        text        not null,
  path        text,                -- "Electronics > Mobile Phones > Smartphones"
  is_leaf     boolean     default false,
  attribute_set_sid text,
  last_synced timestamptz default now(),
  unique (store_id, category_id)
);

create index if not exists idx_jcc_store_leaf
  on jumia_categories_cache (store_id, is_leaf);

create table if not exists jumia_category_attributes_cache (
  id             uuid        primary key default gen_random_uuid(),
  store_id       uuid        references jumia_connections(id) on delete cascade,
  category_id    text        not null,
  attribute_name text        not null,
  attribute_type text,               -- text | number | select | multiselect
  is_mandatory   boolean     default false,
  options        jsonb,              -- for select/multiselect fields
  last_synced    timestamptz default now(),
  unique (store_id, category_id, attribute_name)
);

create index if not exists idx_jcac_store_cat
  on jumia_category_attributes_cache (store_id, category_id);
