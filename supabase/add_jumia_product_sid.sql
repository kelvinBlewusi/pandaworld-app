-- Track Jumia productSid + qc.status per listing.
--
-- Per Jumia API docs (Retrieve Feed Details endpoint):
--   "To perform an update of newly created products, you need to get the
--    products data at least once, from which you will get 2 valuable
--    information: (1) the productSid needed for the update, (2) the qc.status."
--
--   "you can only update the stock, price, status of products that have
--    qc.status approved at least once."
--
-- Without these we can't do post-creation updates (price changes, stock,
-- enable/disable). The cron at /api/cron/jumia-feeds populates them when a
-- feed transitions to DONE/live.

alter table listings
  add column if not exists jumia_product_sid  text,
  add column if not exists jumia_qc_status    text,
  add column if not exists jumia_product_map  jsonb;

create index if not exists idx_listings_jumia_qc_status
  on listings (jumia_qc_status)
  where jumia_qc_status is not null;

comment on column listings.jumia_product_sid  is 'Jumia internal product UUID (productSid). Required for product update calls. NULL until QC has run on the feed.';
comment on column listings.jumia_qc_status    is 'qc.status from Jumia: approved | pending | rejected. Only "approved" allows stock/price/status updates.';
comment on column listings.jumia_product_map  is 'For multi-variant listings: { [sellerSku]: { sid, qc } }';
