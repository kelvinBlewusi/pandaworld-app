-- Phase 4B: Add shop_id to jumia_connections (needed for all Vendor API calls)
-- Run in Supabase: Dashboard → SQL Editor → New query → Paste → Run

alter table jumia_connections
  add column if not exists shop_id text;

comment on column jumia_connections.shop_id is 'Jumia Vendor API shopId — required for product creation and all feed calls';
