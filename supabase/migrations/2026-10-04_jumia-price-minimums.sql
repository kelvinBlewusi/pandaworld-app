-- Jumia's lowest allowed price per country, learned from its rejections
-- ("The Global Price [3] GHS must be equal or more than [8.81] GHS").
-- Read and written by lib/jumia/price-minimums.ts, server-side only.

create table if not exists public.jumia_price_minimums (
  country       text primary key,
  currency      text,
  min_price     numeric(14, 2) not null check (min_price > 0),
  -- The category of the rejection that named it: the rule names none, and
  -- is taken to be country-wide.
  category_code integer,
  last_error    text,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

alter table public.jumia_price_minimums enable row level security;

comment on table public.jumia_price_minimums is
  'Jumia''s lowest allowed price per country, from its own rejections. See lib/jumia/price-minimums.ts.';

-- Ghana's, from the first rejection that named it (2026-10-04).
insert into public.jumia_price_minimums (country, currency, min_price, category_code, last_error)
values ('GH', 'GHS', 8.81, 1000639, 'The Global Price [3] GHS must be equal or more than [8.81] GHS.')
on conflict (country) do nothing;
