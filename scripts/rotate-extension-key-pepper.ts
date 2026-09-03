/**
 * Re-hashes every extension API key's key_hash to match a NEW
 * EXTENSION_KEY_PEPPER value, so rotating the pepper doesn't lock out
 * every seller who's already generated a key.
 *
 * Why this is needed at all: lib/security/extension-keys.ts computes
 * key_hash = sha256(secret + ":" + pepper). If EXTENSION_KEY_PEPPER isn't
 * set in Vercel, getPepper() falls back to a fixed, checked-into-source
 * dev value — fine for local dev, not for public launch, since anyone who
 * can read this repo already knows it. But simply setting a real
 * EXTENSION_KEY_PEPPER in Vercel would silently invalidate every key_hash
 * already computed with the old (dev) pepper — every currently-issued key,
 * including your own, would start failing auth with no obvious cause.
 *
 * This is only possible without breaking existing keys because
 * key_secret (the plaintext secret half of the key) is ALSO stored,
 * purely so /extension/dashboard can redisplay the key later — see
 * supabase/migrations/2026-08-24_extension-api-keys-fixed-key.sql. That
 * means key_hash can be recomputed from key_secret with the new pepper
 * instead of forcing a mass key regeneration.
 *
 * Rows with no stored key_secret (issued before that migration) can't be
 * migrated this way — this script reports how many active (non-revoked)
 * keys fall into that bucket so you know if anyone needs to regenerate.
 *
 * SAFE ROLLOUT ORDER — do not swap these steps:
 *   1. Generate a new pepper yourself, e.g.: openssl rand -hex 32
 *      (don't paste the value anywhere it'll be logged or committed).
 *   2. Run this script with that value in EXTENSION_KEY_PEPPER, e.g.:
 *        EXTENSION_KEY_PEPPER=<value> npm run rotate-extension-key-pepper
 *      This updates every existing key_hash to match the new pepper —
 *      current keys keep working, nothing user-facing changes yet.
 *   3. ONLY AFTER the script reports success: set that SAME value as
 *      EXTENSION_KEY_PEPPER in Vercel's project env vars (Production),
 *      then redeploy.
 *   4. Verify: the "[extension-keys] EXTENSION_KEY_PEPPER is not set"
 *      warning should stop appearing in Vercel's runtime logs, and your
 *      own existing extension API key should still authenticate — that's
 *      the actual proof the rotation worked cleanly.
 *
 * Required env vars: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * (same as the rest of the app), plus EXTENSION_KEY_PEPPER (the NEW value
 * you're rotating to — this script never reads or needs the old one).
 */

import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const NEW_PEPPER = process.env.EXTENSION_KEY_PEPPER;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    "✗ Missing Supabase credentials. Set NEXT_PUBLIC_SUPABASE_URL and " +
    "SUPABASE_SERVICE_ROLE_KEY in .env.local or your shell environment.",
  );
  process.exit(1);
}
if (!NEW_PEPPER || !NEW_PEPPER.trim()) {
  console.error(
    "✗ EXTENSION_KEY_PEPPER is not set in this script's environment. Generate " +
    "one first (e.g. `openssl rand -hex 32`) and pass it here — this is the " +
    "NEW value you're rotating TO, the same one you'll set in Vercel next.",
  );
  process.exit(1);
}

function hashSecret(secret: string, pepper: string): string {
  return createHash("sha256").update(`${secret}:${pepper}`).digest("hex");
}

async function main() {
  const t0 = Date.now();
  const pepper = NEW_PEPPER!.trim();
  console.info("▶ Rotating extension_api_keys.key_hash to the new pepper…");

  const db = createClient(SUPABASE_URL!, SUPABASE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: rows, error } = await db
    .from("extension_api_keys")
    .select("id, key_secret")
    .not("key_secret", "is", null);

  if (error) {
    console.error("✗ Supabase query failed:", error.message);
    process.exit(2);
  }

  let migrated = 0;
  let failed = 0;
  for (const row of rows ?? []) {
    if (!row.key_secret) continue; // not expected given the query filter, but keep TS happy
    const newHash = hashSecret(row.key_secret, pepper);
    const { error: updateError } = await db
      .from("extension_api_keys")
      .update({ key_hash: newHash })
      .eq("id", row.id);
    if (updateError) {
      console.error(`✗ Failed to update key ${row.id}:`, updateError.message);
      failed++;
      continue;
    }
    migrated++;
  }

  // Active keys with no stored plaintext secret can't be re-hashed here —
  // their owners will need to regenerate from /extension/dashboard once
  // the new pepper is live in Vercel.
  const { count: unmigratable, error: countError } = await db
    .from("extension_api_keys")
    .select("id", { count: "exact", head: true })
    .is("key_secret", null)
    .is("revoked_at", null);

  console.info(`✓ Re-hashed ${migrated} key(s) in ${Date.now() - t0}ms.`);
  if (failed > 0) {
    console.error(`✗ ${failed} key(s) FAILED to update — check the errors above before proceeding to Vercel.`);
    process.exit(3);
  }
  if (!countError && unmigratable && unmigratable > 0) {
    console.warn(
      `⚠ ${unmigratable} active key(s) have no stored plaintext secret (issued before ` +
      `the "fixed key" migration) and could NOT be migrated — those sellers will see ` +
      `an invalid-key error after you set the new pepper and will need to regenerate ` +
      `their key from /extension/dashboard.`,
    );
  }
  console.info("Next: set this same EXTENSION_KEY_PEPPER value in Vercel's Production env vars, then redeploy.");
}

main().catch((e) => {
  console.error("✗ Unexpected error:", e);
  process.exit(99);
});
