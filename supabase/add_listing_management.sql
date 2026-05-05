-- Post-listing management columns
-- Run in Supabase: Dashboard → SQL Editor → New query → Paste → Run

-- Stock quantity for simple (non-variant) listings
-- Variant listings use variants.quantity per row; this is the fallback for simple products
alter table listings
  add column if not exists quantity integer not null default 1;

-- Track in-flight update feeds separately from the original create feed (jumia_ref)
-- update_feed_ref  : feedId returned by POST /feeds/products/update
-- update_feed_status: 'pending' | 'done' | 'error'
alter table listings
  add column if not exists update_feed_ref    text null,
  add column if not exists update_feed_status text null;

comment on column listings.quantity            is 'Stock for simple (no-variant) listings. Default 1.';
comment on column listings.update_feed_ref     is 'feedId from most recent stock/price update feed.';
comment on column listings.update_feed_status  is 'Status of last update feed: pending | done | error.';
