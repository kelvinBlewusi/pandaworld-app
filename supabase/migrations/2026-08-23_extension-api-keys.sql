-- Chrome extension API keys + usage log.
--
-- Why this migration:
--   The Jumia Vendor Center autofill extension (docs/chrome-extension-plan.md)
--   authenticates with a PandaWorld-issued API key the seller generates on
--   /extension/dashboard and pastes into the extension — NOT a Clerk session,
--   since the extension runs against Jumia's origin. This table is that key
--   store, plus a lightweight event log the dashboard reads for usage stats.
--
-- Security notes (see lib/security/extension-keys.ts):
--   - We NEVER store the raw key. Format is `pw_live_<key_id>_<secret>`.
--     `key_id` is stored in plaintext for O(1) lookup; only sha256(secret) is
--     persisted in `key_hash`. The full key is shown to the seller exactly
--     once, at creation time, then discarded server-side.
--   - `key_suffix` (last 4 chars of the secret) is stored so the dashboard
--     can show "pw_live_...wxyz" without ever re-displaying the real key.
--   - A key is scoped to autofill only — it cannot reach billing or account
--     endpoints — enforced in application code, not by this schema.
--
-- Apply via Supabase Dashboard → SQL Editor → New query → paste → Run.
-- Idempotent — re-running is a no-op.

CREATE TABLE IF NOT EXISTS extension_api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      text NOT NULL,               -- Clerk userId (same as subscriptions.user_id)
  key_id       text NOT NULL UNIQUE,         -- public lookup id, e.g. 12 hex chars
  key_hash     text NOT NULL,                -- sha256(secret + pepper), hex
  key_suffix   text NOT NULL,                -- last 4 chars of the secret, for display only
  name         text NOT NULL DEFAULT 'Chrome Extension',
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz,
  expires_at   timestamptz
);

CREATE INDEX IF NOT EXISTS idx_extension_api_keys_user
  ON extension_api_keys (user_id)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE extension_api_keys IS
  'API keys for the PandaWorld Chrome extension. Sellers generate these on /extension/dashboard and paste them into the extension side panel. Never stores the raw key — only key_id (lookup) and key_hash (sha256 of the secret). See lib/security/extension-keys.ts.';

-- ─── Usage log ────────────────────────────────────────────────────────────────
--
-- One row per autofill call. Lets the dashboard show "N autofills this
-- period" without touching the `subscriptions` counters (those track the
-- shared listing quota — see lib/billing/quota.ts — this table is purely
-- for the extension-specific activity view).

CREATE TABLE IF NOT EXISTS extension_fill_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       text NOT NULL,
  key_id        text,                        -- extension_api_keys.key_id, no FK (key may be revoked/deleted later)
  fields_filled integer NOT NULL DEFAULT 0,
  mock          boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_extension_fill_events_user_created
  ON extension_fill_events (user_id, created_at DESC);

COMMENT ON TABLE extension_fill_events IS
  'One row per extension autofill call — powers the "usage" section of /extension/dashboard. Not the billing meter (that is subscriptions.listings_used_this_period, incremented via lib/billing/quota.ts incrementUsage()).';
