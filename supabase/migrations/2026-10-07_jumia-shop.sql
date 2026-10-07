-- A seller's live Jumia shop on WhatsApp (lib/jumia/shop.ts,
-- lib/whatsapp/shop.ts, lib/whatsapp/shop-notices.ts; owner, 2026-10-07).

-- Their whole Jumia catalog, one row per product (variation), with its
-- status, QC, price and stock in their own country. Read from Jumia when the
-- assistant needs it and the copy is over 3 hours old.
create table if not exists public.jumia_products (
  user_id            text        not null,
  product_sid        text        not null,
  set_sid            text,
  seller_sku         text        not null,
  name               text        not null,
  variation          text,
  brand              text,
  category_code      text,
  product_created_at text,
  status             text,
  visible            boolean,
  qc_status          text,
  qc_reason          text,
  price              numeric,
  sale_price         numeric,
  sale_start         text,
  sale_end           text,
  currency           text,
  image_url          text,
  stock              numeric,
  synced_at          timestamptz not null default now(),
  primary key (user_id, product_sid)
);
create index if not exists jumia_products_user_sku_idx on public.jumia_products (user_id, seller_sku);
alter table public.jumia_products enable row level security;

-- When each seller's catalog was last read.
create table if not exists public.jumia_catalog_syncs (
  user_id   text primary key,
  synced_at timestamptz not null,
  products  integer not null default 0
);
alter table public.jumia_catalog_syncs enable row level security;

-- A change to a live product the seller asked for on WhatsApp: proposed
-- (pending, waiting for their tap), sent (a feed Jumia is applying), then
-- done or failed. Also the record of what was changed, by whom and when.
create table if not exists public.jumia_product_changes (
  id          uuid primary key default gen_random_uuid(),
  user_id     text        not null,
  product_sid text,
  seller_sku  text,
  name        text,
  change      jsonb       not null,
  candidates  jsonb,
  status      text        not null default 'pending',
  feed_id     text,
  error       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists jumia_product_changes_user_idx on public.jumia_product_changes (user_id, created_at desc);
create index if not exists jumia_product_changes_sent_idx on public.jumia_product_changes (status) where status = 'sent';
alter table public.jumia_product_changes enable row level security;

-- What each seller has been told once: an order's new status
-- ("order:<id>:DELIVERED"), a paid payout ("payout:<statement>"), and the
-- time of the last of each kind of check.
create table if not exists public.shop_notices (
  user_id    text        not null,
  kind       text        not null,
  ref        text        not null,
  created_at timestamptz not null default now(),
  primary key (user_id, kind, ref)
);
alter table public.shop_notices enable row level security;
