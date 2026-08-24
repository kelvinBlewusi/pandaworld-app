-- Adds a "fixed" API key model to extension_api_keys.
--
-- Why: the redesigned /extension/dashboard shows every seller a single,
-- persistent API key (masked, with a reveal/copy control) the moment they
-- land on the page — matching the "Your API Key" card pattern from
-- competitor extension dashboards — instead of a "generate a new key"
-- button-driven multi-key list. That means the secret must be retrievable
-- on every page load, not just shown once at creation, so it can no longer
-- be hash-only (see the original security notes in
-- 2026-08-23_extension-api-keys.sql, which this supersedes for new keys).
--
-- key_hash is kept and still used for auth verification (lib/security/
-- extension-keys.ts's authenticateExtensionKey keeps comparing hashes, not
-- the raw secret) — key_secret is additive, only for redisplaying the key
-- to its owner in the dashboard.
--
-- Apply via Supabase Dashboard → SQL Editor → New query → paste → Run.
-- Idempotent — re-running is a no-op.

ALTER TABLE extension_api_keys
  ADD COLUMN IF NOT EXISTS key_secret text;

COMMENT ON COLUMN extension_api_keys.key_secret IS
  'Plaintext secret portion of the key (the part after the last underscore in pw_live_<key_id>_<secret>). Lets the dashboard redisplay the full key on demand via getOrCreateExtensionApiKey(). Keys created before this migration have this NULL — the dashboard treats that as "no retrievable key" and issues a fresh one.';
