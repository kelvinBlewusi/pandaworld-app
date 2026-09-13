-- Category catalog freshness tracking — see app/api/cron/check-category-
-- freshness/route.ts. A single-row table (id is always 1) holding the
-- result of the most recent automated comparison between our cached
-- jumia_categories table and Jumia's live /catalog/categories count, so
-- the admin categories page can show a "this may be stale" warning
-- instead of silently trusting an unbounded-age local cache — sync was
-- previously admin-triggered only, with nothing checking whether it had
-- actually drifted from Jumia's current catalog.

create table if not exists jumia_category_sync_health (
  id           smallint primary key default 1,
  checked_at   timestamptz not null default now(),
  local_count  integer not null,
  live_count   integer not null,
  is_stale     boolean not null,
  error        text,
  constraint jumia_category_sync_health_single_row check (id = 1)
);

alter table jumia_category_sync_health enable row level security;
-- No policies defined — service role (the cron route + admin page's
-- server component) bypasses RLS automatically; no anon/authenticated
-- client has any access, which is correct for operational telemetry.
