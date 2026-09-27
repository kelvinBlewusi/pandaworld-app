-- Categories Jumia refuses to accept listings in, per country.
--
-- Jumia's category tree marks some categories as leaves (so they look
-- listable, and our is_leaf flag says so) that Jumia nonetheless rejects
-- with "You can't list products in this category. Please choose a
-- different (more specific) category and try again." Nothing recorded
-- this, so the AI kept picking the same dead categories for every seller,
-- and the fix-and-resubmit redraft only avoided the one category it had
-- just failed on — a power bank went from one dead category straight to
-- another (2026-09-27) while the working one was never tried.
--
-- Keyed by country because each Jumia country runs its own Vendor Center:
-- a category refused in Ghana may be fine in Nigeria. One rejection is
-- enough to block (the error names the category, not the product); an
-- admin can unblock a row from /admin/blocked-categories.
--
-- Written by lib/jumia/unlistable-categories.ts (via logFeedOutcome),
-- read by runAutoAnalyze to drop blocked codes from the AI's candidates.

create table if not exists public.jumia_unlistable_categories (
  country         text        not null,
  category_code   integer     not null,
  rejection_count integer     not null default 1,
  last_error      text,
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  primary key (country, category_code)
);

-- Service-role only, like every other table here.
alter table public.jumia_unlistable_categories enable row level security;

comment on table public.jumia_unlistable_categories is
  'Categories Jumia rejected with "can''t list products in this category", per seller country. Excluded from AI category candidates for that country. See lib/jumia/unlistable-categories.ts.';

-- jumia_feed_outcomes.country was left null by the rejection-recording
-- path (it never had the seller in scope). Backfill it from the seller's
-- own Jumia connection; logFeedOutcome now resolves it the same way for
-- new rows.
update public.jumia_feed_outcomes o
set    country = c.country
from   public.listings l
join   public.jumia_connections c on c.user_id = l.user_id
where  o.listing_id = l.id
  and  o.country is null
  and  c.country is not null;

-- Seed from history.
insert into public.jumia_unlistable_categories
  (country, category_code, rejection_count, last_error, first_seen_at, last_seen_at)
select o.country,
       o.category_code::integer,
       count(*),
       max(o.raw_error),
       min(o.created_at),
       max(o.created_at)
from   public.jumia_feed_outcomes o
where  o.outcome = 'rejected'
  and  o.raw_error ilike '%can''t list products in this category%'
  and  o.country is not null
  and  o.category_code ~ '^[0-9]+$'
group  by o.country, o.category_code
on conflict (country, category_code) do nothing;
