-- ─── Get the database back under the Free Plan's 500 MB ─────────────────────
--
-- Applied 2026-09-29, when the database had reached 605 MB. Free Plan
-- projects can be switched to read-only above 500 MB, which would stop
-- listings, WhatsApp sessions and credits being saved. Afterwards: 188 MB.
--
--   jumia_categories  446 MB → 120 MB
--     - idx_jumia_categories_embedding (ivfflat, 277 MB) dropped. Every
--       live search passes dept_path (searchCategoriesByEmbeddingMulti),
--       and the planner can't use an ivfflat index under that filter, so
--       it hadn't been scanned since 2026-09-20. Each full category
--       re-sync rewrote every row and left another 3 KB copy of each
--       vector in it. A department-scoped search reads a few thousand rows
--       and takes ~0.2 s without it. If an unscoped search ever comes
--       back, an HNSW index is the one to add.
--     - jumia_categories_path_lower_idx dropped: never scanned since stats
--       began (2026-04-26); the search matches on path, not lower(path).
--     - VACUUM FULL to hand back the space dead vector copies held.
--   net._http_response  71 MB → <1 MB (VACUUM FULL). pg_net deletes old
--     responses itself, but the ~6,000 idle cron calls a day before
--     2026-09-28_cron-only-when-there-is-work.sql left the space behind.
--   cron.job_run_details  31 MB → 11 MB. pg_cron keeps every run forever;
--     a daily job now keeps one week.
--
-- VACUUM FULL can't run inside a migration's transaction, so it was run
-- separately:
--   vacuum full public.jumia_categories;
--   vacuum full net._http_response;
--   vacuum full cron.job_run_details;

drop index if exists public.idx_jumia_categories_embedding;
drop index if exists public.jumia_categories_path_lower_idx;

delete from cron.job_run_details where end_time < now() - interval '7 days';

select cron.schedule(
  'purge-cron-history',
  '23 4 * * *',
  $$ delete from cron.job_run_details where end_time < now() - interval '7 days' $$
);
