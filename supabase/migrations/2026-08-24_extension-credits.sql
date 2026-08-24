-- Extension credits — a separate, never-expiring balance for the Chrome
-- extension's autofill flow, independent from the classic app's plan-based
-- monthly quota (subscriptions.listings_used_this_period / lib/billing/
-- quota.ts). Decision from Kelvin: new sign-ups get 5 free credits, one
-- autofill costs 2.5 credits, purchased credits never expire/reset.
--
-- extension_credits          — one row per user, current balance.
-- extension_credit_transactions — append-only ledger (grant / purchase /
--   deduction / refund). `reference` (Paystack transaction reference) has a
--   partial unique index so a retried webhook or a webhook+verify double-
--   fire on the same purchase can't double-credit — see
--   lib/billing/extension-credits.ts's creditPurchase().
--
-- Apply via Supabase Dashboard → SQL Editor → New query → paste → Run.
-- Idempotent — re-running is a no-op.

CREATE TABLE IF NOT EXISTS extension_credits (
  user_id    text PRIMARY KEY,               -- Clerk userId
  balance    numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE extension_credits IS
  'Current credit balance per user for the Chrome extension autofill flow. Provisioned lazily (5 free credits) the first time getOrCreateCreditBalance() sees a user — see lib/billing/extension-credits.ts.';

CREATE TABLE IF NOT EXISTS extension_credit_transactions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       text NOT NULL,
  type          text NOT NULL CHECK (type IN ('grant', 'purchase', 'deduction', 'refund')),
  amount        numeric NOT NULL,             -- positive for grant/purchase/refund, negative for deduction
  balance_after numeric NOT NULL,
  reference     text,                         -- Paystack transaction reference, for purchases
  description   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_extension_credit_tx_reference
  ON extension_credit_transactions (reference)
  WHERE reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_extension_credit_tx_user
  ON extension_credit_transactions (user_id, created_at DESC);

COMMENT ON TABLE extension_credit_transactions IS
  'Append-only ledger for extension_credits — one row per grant/purchase/deduction/refund. The partial unique index on reference is the idempotency guard for Paystack purchases.';
