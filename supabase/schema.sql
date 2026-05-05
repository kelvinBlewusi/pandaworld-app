-- PandaWorld database schema
-- Run this in Supabase: Dashboard → SQL Editor → New query → Paste → Run

-- ─── Listings ────────────────────────────────────────────────────────────────
create table if not exists listings (
  id                  uuid primary key default gen_random_uuid(),
  user_id             text not null,           -- Clerk user ID
  sku                 text not null unique,
  title               text,
  description         text,
  highlights          text,
  brand               text,
  category_id         text,
  category_path       text,
  category_code       text,
  color               text,
  color_family        text,
  weight_kg           numeric(8,3),
  main_material       text,
  material_family     text,
  production_country  text,
  warranty_duration   text,
  warranty_type       text,
  warranty_text       text,
  warranty_address    text,
  model               text,
  product_line        text,
  size_l              numeric(8,2),
  size_w              numeric(8,2),
  size_h              numeric(8,2),
  certifications      text[] default '{}',
  youtube_id          text,
  images              text[] default '{}',
  status              text not null default 'draft'
                        check (status in ('draft','processing','pending_approval','live','failed')),
  selling_price       numeric(12,2),
  commission_rate     numeric(5,4),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ─── Variants ────────────────────────────────────────────────────────────────
create table if not exists variants (
  id              uuid primary key default gen_random_uuid(),
  listing_id      uuid not null references listings(id) on delete cascade,
  variation       text,
  seller_sku      text,
  gtin            text,
  quantity        integer not null default 1,
  global_price    numeric(12,2),
  sale_price      numeric(12,2),
  sale_start_date date,
  sale_end_date   date,
  created_at      timestamptz not null default now()
);

-- ─── Stores ──────────────────────────────────────────────────────────────────
create table if not exists stores (
  id              uuid primary key default gen_random_uuid(),
  user_id         text not null,
  name            text not null,
  marketplace     text not null default 'Jumia GH',
  seller_id       text,
  status          text not null default 'connected'
                    check (status in ('connected','disconnected','pending')),
  listings_count  integer not null default 0,
  created_at      timestamptz not null default now()
);

-- ─── Indexes ─────────────────────────────────────────────────────────────────
create index if not exists listings_user_id_idx on listings(user_id);
create index if not exists listings_status_idx  on listings(status);
create index if not exists variants_listing_idx on variants(listing_id);
create index if not exists stores_user_id_idx   on stores(user_id);

-- ─── Auto-update updated_at ──────────────────────────────────────────────────
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists listings_updated_at on listings;
create trigger listings_updated_at
  before update on listings
  for each row execute function update_updated_at();

-- ─── Row Level Security ───────────────────────────────────────────────────────
alter table listings enable row level security;
alter table variants  enable row level security;
alter table stores    enable row level security;

-- Service role bypasses RLS automatically (used by server actions).
-- Anon/authenticated JWT access is intentionally blocked — all reads/writes
-- go through server actions with Clerk auth check.
