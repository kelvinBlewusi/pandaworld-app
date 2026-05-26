-- Pending tier: the tier the user chose at /api/paystack/initialize
-- time, recorded BEFORE we redirect them to Paystack so verify and the
-- webhook can read it back as the authoritative source.
--
-- Why this column is needed:
--   Paystack Payment Pages drop the metadata URL param we attach, use
--   their own auto-generated references (T...), and may or may not
--   include paymentpage.slug in the verify response. That left our
--   resolver chain (slug → amount → metadata → reference → default)
--   with no reliable way to identify the tier when:
--     - Paystack page price was changed (amount-match breaks)
--     - paymentpage.slug not in the verify response
--
--   pending_tier is something WE write to OUR database before redirect.
--   It survives regardless of what Paystack does. Read by both
--   /api/paystack/verify and /api/paystack/webhook as the TOP-priority
--   tier resolver. Cleared after activation.
--
-- Run via Supabase Dashboard → SQL Editor → New query → paste → Run.

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS pending_tier text;

COMMENT ON COLUMN subscriptions.pending_tier IS
  'The tier the user chose at /api/paystack/initialize time, before being redirected to Paystack. Read back by /verify and /webhook as the authoritative tier source. Cleared (set to NULL) after the subscription is activated.';

-- Optional partial index — speeds up reads of "rows with pending intents".
-- Tiny because most rows have pending_tier=NULL.
CREATE INDEX IF NOT EXISTS idx_subscriptions_pending_tier
  ON subscriptions (user_id)
  WHERE pending_tier IS NOT NULL;
