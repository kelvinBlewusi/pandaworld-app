-- Phase 4B: Track Jumia direct-push state on listings
-- Run in Supabase: Dashboard → SQL Editor → New query → Paste → Run

alter table listings
  add column if not exists jumia_ref        text,        -- Jumia product/feed ID returned on submission
  add column if not exists jumia_error      text,        -- last error from Jumia API
  add column if not exists jumia_synced_at  timestamptz; -- timestamp of last successful push

comment on column listings.jumia_ref       is 'Jumia product or feed reference ID from direct API push';
comment on column listings.jumia_error     is 'Last error message returned by Jumia API';
comment on column listings.jumia_synced_at is 'Timestamp of last successful push to Jumia API';
