-- Persist every resolved Jumia feed-item outcome — live, rejected, or
-- blocked before it ever left the building — so the next "fix a rejection
-- class" pass has the actual live error string and payload shape to write
-- a regression test against, instead of relying on whoever happened to be
-- watching the chat when it happened. See CONTRIBUTING.md.
--
-- Write-only telemetry, same pattern as category_corrections
-- (2026-09-13_category-corrections.sql): nothing reads this yet, but every
-- row is a candidate __tests__ fixture. Written by lib/jumia/feed-outcomes.ts.
create table if not exists jumia_feed_outcomes (
  id                   uuid primary key default gen_random_uuid(),
  listing_id           uuid references listings(id) on delete cascade,
  feed_id              text,
  seller_sku           text,
  country              text,
  category_code        text,
  outcome              text not null check (outcome in ('live', 'rejected', 'blocked_locally')),
  raw_error            text,
  payload_fingerprint  text,
  created_at           timestamptz not null default now()
);

create index if not exists jumia_feed_outcomes_listing_id_idx
  on jumia_feed_outcomes (listing_id);
create index if not exists jumia_feed_outcomes_fingerprint_idx
  on jumia_feed_outcomes (payload_fingerprint);

alter table jumia_feed_outcomes enable row level security;
-- No policies defined — only the service-role client (lib/jumia/push-listing.ts)
-- ever writes or reads this; no anon/authenticated client needs direct
-- access.

-- Carries the fingerprint computed at push time through to the async feed
-- resolution in refreshPendingFeedStatus, which only has the listing row
-- (not the original push call's variants) to work from.
alter table listings
  add column if not exists jumia_payload_fingerprint text;

comment on column listings.jumia_payload_fingerprint is
  'fingerprintListingContent() of the title/description/brand/category/'
  'attributes/variants at the last push attempt. Compared on the next '
  'push to tell "same content, still rejected" apart from "content '
  'changed, new rejection" — see lib/jumia/feed-outcomes.ts.';
