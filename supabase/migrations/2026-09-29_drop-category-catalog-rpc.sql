-- ─── Drop category_catalog() ────────────────────────────────────────────────
--
-- 2026-09-29_category-catalog-rpc.sql added this to load the whole category
-- catalog in one statement. Sorting and packing ~28k rows took 2–19s on
-- the free-plan database, and when two drafting runs started six loads at
-- once, five hit the statement timeout. Both runs overran Vercel's 60s
-- limit and a 3-product batch sat for 6 minutes.
--
-- lib/jumia/categories.ts now pages the table in primary-key order once per
-- server process, shares that load with concurrent callers, and sorts in
-- the app. Nothing calls this any more.

drop function if exists public.category_catalog();
