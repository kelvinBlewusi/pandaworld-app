-- Phase 5A: Real Jumia category tree + per-category attribute schemas
-- Run in Supabase: Dashboard → SQL Editor → New query → Paste → Run

-- ── 1. Category tree ──────────────────────────────────────────────────────────
create table if not exists jumia_categories (
  code        integer      primary key,          -- Jumia numeric category code
  name        text         not null,             -- e.g. "Smartphones"
  path        text         not null,             -- e.g. "Phones & Tablets > Smartphones"
  parent_code integer      references jumia_categories(code),
  level       integer      not null default 1,   -- depth in tree (1 = root)
  is_leaf     boolean      not null default true, -- only leaf cats accept products
  synced_at   timestamptz  not null default now()
);

create index if not exists idx_jumia_categories_parent on jumia_categories(parent_code);
create index if not exists idx_jumia_categories_leaf   on jumia_categories(is_leaf);

comment on table jumia_categories is
  'Real Jumia category tree synced from GET /catalog/categories';

-- ── 2. Per-category attribute schemas ─────────────────────────────────────────
create table if not exists jumia_category_attributes (
  id              uuid        primary key default gen_random_uuid(),
  category_code   integer     not null references jumia_categories(code) on delete cascade,
  name            text        not null,   -- API field name, e.g. "ram"
  label           text        not null,   -- Display label, e.g. "RAM"
  type            text        not null,   -- "enum" | "string" | "number" | "boolean"
  allowed_values  text[]      default '{}',  -- valid values for enum fields
  required        boolean     not null default false,
  sort_order      integer     not null default 0,
  synced_at       timestamptz not null default now(),
  unique(category_code, name)
);

create index if not exists idx_jca_category_code on jumia_category_attributes(category_code);

comment on table jumia_category_attributes is
  'Per-category attribute schemas synced from GET /catalog/categories/{code}/attributes.
   These are the exact same fields shown in Jumia Vendor Center when listing manually.';
