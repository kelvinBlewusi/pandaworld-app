-- More of the Jumia API in the assistant (owner, 2026-10-07: "do all").
--
-- jumia_products.jumia_sku: Jumia's own SKU for the seller's country
-- (businessClients[].sku in GET /catalog/products). Jumia's warehouse calls
-- (GET /consignment-stock, POST /consignment-order) take it, not the
-- seller's SKU.
alter table public.jumia_products add column if not exists jumia_sku text;

-- Delivery orders into Jumia's warehouse made from chat, and their
-- "shipped" updates: offered (pending), then done, cancelled or failed on
-- the seller's tap (wh:<id> / whno:<id>, lib/whatsapp/shop-insights.ts).
-- Jumia has no call to read one back, so this is also the seller's record.
create table if not exists public.jumia_warehouse_orders (
  id              uuid primary key default gen_random_uuid(),
  user_id         text not null,
  action          text not null check (action in ('create', 'ship')),
  status          text not null default 'pending' check (status in ('pending', 'done', 'cancelled', 'failed')),
  products        jsonb,
  shipping_date   date,
  po_number       text,
  tracking_number text,
  carrier         text,
  error           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists jumia_warehouse_orders_user_idx on public.jumia_warehouse_orders (user_id, created_at desc);
alter table public.jumia_warehouse_orders enable row level security;
comment on table public.jumia_warehouse_orders is
  'Delivery orders into Jumia''s warehouse made in chat (and marking them shipped). Service role only.';
