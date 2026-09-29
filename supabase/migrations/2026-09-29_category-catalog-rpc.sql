-- ─── The whole category catalog in one compact response ─────────────────────
--
-- lib/jumia/categories.ts used to page through jumia_categories 1,000 rows
-- at a time, twice per server process: once for the listable categories
-- and once for the full tree (they differ by one row). Every row repeated
-- all eight column names, so each copy was ~8.6 MB of JSON and each new
-- Vercel instance pulled ~17 MB of Supabase egress in 56 requests.
--
-- This returns the catalog once, as one JSON array of arrays in a fixed
-- column order: 5.6 MB in a single request. The app keeps one copy and
-- derives the listable subset from it.
--
-- Column order (lib/jumia/categories.ts, CatalogTuple):
--   code, name, path, parent_code, level, is_leaf, attribute_set_sid,
--   attribute_set_name
--
-- A function returning one json value isn't cut off by PostgREST's
-- max_rows, which is what forced the paging. Ordered by name like the old
-- reads, with code breaking ties so the order is stable.

create or replace function public.category_catalog()
returns json
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(
    json_agg(
      json_build_array(code, name, path, parent_code, level, is_leaf, attribute_set_sid, attribute_set_name)
      order by name, code
    ),
    '[]'::json
  )
  from jumia_categories;
$$;

-- Server-only, like the table itself (RLS gives anon and authenticated
-- nothing). Functions are executable by PUBLIC unless revoked.
revoke execute on function public.category_catalog() from public, anon, authenticated;
grant execute on function public.category_catalog() to service_role;
