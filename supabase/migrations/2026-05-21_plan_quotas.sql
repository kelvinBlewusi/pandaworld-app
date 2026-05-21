-- Tiered subscription quotas — adds the columns we need to track
-- per-period (monthly) usage of listings + image polishes.
--
-- Why this migration:
--   Before: plan = "free" | "pro". Free was a LIFETIME 5-listing cap;
--   Pro was unlimited. Image polish was ungated.
--
--   After: plan = "free" | "starter" | "pro" | "business".
--   Every paid tier has a monthly listing quota AND monthly image-polish
--   quota that resets at period_start + 30 days. Admin override (env-var
--   based, see lib/billing/admin.ts) bypasses quotas entirely without
--   needing a database flag — so we don't need an `is_legacy` /
--   `is_admin` column here.
--
-- Read order downstream (lib/billing/quota.ts):
--   1. SELECT plan, period_start, listings_used_this_period, ...
--   2. If now() > period_start + 30d → reset counters + bump period_start
--   3. Return { used, limit, allowed } from the (possibly reset) row
--
-- Apply via the Supabase SQL editor or `supabase db push`. Idempotent —
-- safe to re-run; uses IF NOT EXISTS and conditional updates.

-- ── 1. Quota tracking columns ──────────────────────────────────────────────
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS listings_used_this_period integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS polishes_used_this_period integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS period_start              timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN subscriptions.listings_used_this_period IS
  'Monthly listing creations consumed in the current billing period. Reset by lib/billing/quota.ts when now() > period_start + 30d.';
COMMENT ON COLUMN subscriptions.polishes_used_this_period IS
  'Monthly image-polish (PhotoRoom + Gemini rebuild) calls consumed in the current billing period.';
COMMENT ON COLUMN subscriptions.period_start IS
  'Start of the current quota window. Bumped forward 30 days when usage resets.';

-- ── 2. Widen the plan CHECK constraint to allow the new tier names ─────────
-- Drop the old constraint (whatever it was called) and create a fresh
-- one that allows all 4 tier ids. Using a stable name so future
-- migrations can drop it the same way.
ALTER TABLE subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_plan_check;

ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_plan_check
  CHECK (plan IN ('free', 'starter', 'pro', 'business'));

-- ── 3. Indexes ─────────────────────────────────────────────────────────────
-- The daily cron sweep filters on (status, period_start) to find rows
-- whose period has rolled over. Partial index keeps it tiny.
CREATE INDEX IF NOT EXISTS idx_subscriptions_period_reset
  ON subscriptions (period_start)
  WHERE status = 'active';
