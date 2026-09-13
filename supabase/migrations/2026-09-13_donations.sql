-- Donations table — records for the "Donate" flow that temporarily
-- replaces the extension dashboard's paid credit-pack purchases while
-- FREE_FOR_ALL_MODE (lib/billing/free-for-all.ts) is on. A donation
-- grants nothing back (no credits, no plan upgrade) — it's purely
-- goodwill support money, recorded here for our own accounting/thank-you
-- purposes. See app/api/donations/checkout/route.ts and the "donation"
-- branch in app/api/paystack/webhook/route.ts.
--
-- Apply via Supabase Dashboard -> SQL Editor -> New query -> paste -> Run.

CREATE TABLE IF NOT EXISTS donations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    text NOT NULL,
  amount_ghs numeric NOT NULL,
  reference  text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_donations_user_id ON donations (user_id);

COMMENT ON TABLE donations IS
  'One row per successful donation (Paystack transaction/initialize, type=donation metadata). Idempotent on reference — the webhook and any future /verify call can both fire safely.';
