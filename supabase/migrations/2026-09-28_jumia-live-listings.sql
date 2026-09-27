-- Listings Jumia accepted, per country: the category each one went live
-- in, and its title. The positive twin of jumia_unlistable_categories.
--
-- When the AI drafts a new product, categories that similar products
-- already went live in (same country) join its candidates, marked as
-- accepted by Jumia. A power bank that went live in "Portable Power Banks
-- & Battery Packs" means the next power bank gets that category offered
-- up front, instead of the AI rediscovering it after refused attempts.
--
-- Evidence that Jumia ACCEPTS a category, not that it's right: several
-- live listings sit in plainly wrong categories (a safety helmet under
-- "Plate Casters", a yoga mat under "Clinometers"). So these are only
-- ever candidates for the AI to judge, never applied directly. See
-- lib/jumia/live-listings.ts.
--
-- One row per listing (its latest live category). Written by
-- logFeedOutcome on a "live" outcome; read by runAutoAnalyze.

create table if not exists public.jumia_live_listings (
  listing_id    uuid        primary key,
  country       text        not null,
  category_code integer     not null,
  title         text        not null,
  went_live_at  timestamptz not null default now()
);

create index if not exists jumia_live_listings_country_idx
  on public.jumia_live_listings (country, went_live_at desc);

-- Service-role only, like every other table here.
alter table public.jumia_live_listings enable row level security;

comment on table public.jumia_live_listings is
  'Listings Jumia accepted (went live), per seller country: category + title. Categories similar products went live in are offered to the AI as candidates. See lib/jumia/live-listings.ts.';

-- Seed from listings already live.
insert into public.jumia_live_listings (listing_id, country, category_code, title, went_live_at)
select l.id,
       c.country,
       l.category_code::integer,
       l.title,
       coalesce(l.jumia_synced_at, l.updated_at, now())
from   public.listings l
join   public.jumia_connections c on c.user_id = l.user_id
where  l.status = 'live'
  and  c.country is not null
  and  l.title is not null
  and  l.category_code ~ '^[0-9]+$'
on conflict (listing_id) do nothing;
