-- ─── Run ONCE, by hand, in the Supabase SQL editor ──────────────────────────
--
-- NOT an auto-applied migration: it needs the real CRON_SECRET, which lives
-- in Vercel's env vars and deliberately isn't in this repo. Paste it into
-- step 1 below and run the file in the SQL editor.
--
-- Why the schedule lives in Postgres instead of vercel.json: Vercel's Hobby
-- plan caps its own cron at once a DAY. That is what left submitted
-- listings sitting at "pending Jumia review" for up to 24 hours, and it
-- would make the analysis queue useless (a batch would drain one tick per
-- day). pg_cron has no such cap.
--
-- Prerequisites, already applied by migration:
--   pg_cron 1.6.4, pg_net 0.20.0, supabase_vault 0.3.1
--
-- To verify afterwards:
--   select jobid, jobname, schedule, active from cron.job;
--   select * from cron.job_run_details order by start_time desc limit 20;

-- ── 1. Store the secret ─────────────────────────────────────────────────────
-- Kept in Vault rather than inlined into the cron command below, because
-- cron.job.command is readable by anyone who can read that table — a
-- pasted bearer token there would be sitting in plaintext for every DB user.
select vault.create_secret(
  'REPLACE_WITH_YOUR_CRON_SECRET',   -- ← the CRON_SECRET from Vercel
  'cron_secret',
  'Bearer token for /api/worker/* and /api/cron/* routes'
);

-- Re-running later? Vault rejects a duplicate name, so rotate with:
--   select vault.update_secret(
--     (select id from vault.secrets where name = 'cron_secret'),
--     'NEW_SECRET_VALUE'
--   );

-- ── 2. Drain the analysis queue every minute ────────────────────────────────
-- The worker also chains into itself while it has work and is nudged
-- directly by the webhook, so in practice a batch drains continuously and
-- this schedule is the safety net that catches anything dropped.
select cron.schedule(
  'analyze-jobs-worker',
  '* * * * *',
  $$
  select net.http_post(
    url     := 'https://pandaworldai.site/api/worker/analyze-jobs',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'
      )
    )
  );
  $$
);

-- ── 3. Poll Jumia feed statuses every minute ────────────────────────────────
-- Replaces the once-daily vercel.json entry as the real mechanism. That
-- entry can stay as a belt-and-braces backstop; this is what actually makes
-- a listing stop saying "pending" within a minute of Jumia finishing.
select cron.schedule(
  'jumia-feed-poll',
  '* * * * *',
  $$
  select net.http_get(
    url     := 'https://pandaworldai.site/api/cron/jumia-feeds',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'
      )
    )
  );
  $$
);

-- ── Undo ────────────────────────────────────────────────────────────────────
--   select cron.unschedule('analyze-jobs-worker');
--   select cron.unschedule('jumia-feed-poll');
