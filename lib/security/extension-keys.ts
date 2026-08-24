"use server";

/**
 * PandaWorld API keys for the Chrome extension.
 *
 * Design (docs/chrome-extension-plan.md §9): the extension authenticates
 * with a key the seller generates on /extension/dashboard and pastes into
 * the extension side panel — NOT a Clerk session, since the extension calls
 * our API from Jumia's origin. The key only authorizes calls to
 * /api/extension/* — it can't touch billing or account endpoints.
 *
 * Key format: `pw_live_<keyId>_<secret>`
 *   - keyId: 12 hex chars, stored in plaintext — O(1) lookup.
 *   - secret: 32 url-safe base64 chars, high-entropy.
 *
 * Every seller gets exactly ONE fixed key (getOrCreateExtensionApiKey),
 * shown on /extension/dashboard behind a reveal/copy control — not a
 * generate-on-demand multi-key list. That means the secret has to be
 * redisplayable on every visit, so unlike a typical one-time-reveal API
 * key we store it in `key_secret` (plaintext) alongside `key_hash`
 * (sha256(secret + pepper)), which authenticateExtensionKey still uses
 * for verification. `key_secret` exists purely so the dashboard can show
 * the key again later — it plays no role in auth.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServerClient } from "@/lib/supabase/server";

const PREFIX = "pw_live_";
const MAX_ACTIVE_KEYS_PER_USER = 5;

export interface ExtensionApiKeyRow {
  id: string;
  keyId: string;
  name: string;
  suffix: string;         // last 4 chars of the secret, for display: "pw_live_…wxyz"
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
}

// ─── Hashing ──────────────────────────────────────────────────────────────────

/**
 * Pepper for the hash — defense-in-depth on top of the secret's own ~192
 * bits of entropy (an attacker with just the DB dump still can't verify
 * guesses without this). Falls back to a fixed dev-only string (with a
 * loud warning) so local dev / preview testing isn't blocked on setting
 * yet another env var — unlike token-crypto's ENCRYPTION_KEY, a missing
 * pepper here doesn't put existing user data at risk of undecryptability,
 * it only weakens a defense-in-depth layer, so we degrade rather than throw.
 */
let _warnedNoPepper = false;
function getPepper(): string {
  const pepper = process.env.EXTENSION_KEY_PEPPER;
  if (pepper && pepper.trim()) return pepper.trim();
  if (!_warnedNoPepper) {
    console.warn(
      "[extension-keys] EXTENSION_KEY_PEPPER is not set — using a fixed dev pepper. " +
        "Set a random value in Vercel env vars before public launch.",
    );
    _warnedNoPepper = true;
  }
  return "pandaworld-dev-pepper-set-EXTENSION_KEY_PEPPER-in-prod";
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(`${secret}:${getPepper()}`).digest("hex");
}

// ─── Generation ───────────────────────────────────────────────────────────────

interface GeneratedKey {
  fullKey: string;
  keyId:   string;
  secret:  string; // stored in key_secret so it can be redisplayed later
  hash:    string;
  suffix:  string;
}

function generateKey(): GeneratedKey {
  const keyId  = randomBytes(6).toString("hex");                    // 12 hex chars
  const secret = randomBytes(24).toString("base64url");             // 32 url-safe chars
  const fullKey = `${PREFIX}${keyId}_${secret}`;
  return { fullKey, keyId, secret, hash: hashSecret(secret), suffix: secret.slice(-4) };
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

function mapRow(r: Record<string, unknown>): ExtensionApiKeyRow {
  return {
    id:         r.id as string,
    keyId:      r.key_id as string,
    name:       r.name as string,
    suffix:     r.key_suffix as string,
    createdAt:  r.created_at as string,
    lastUsedAt: (r.last_used_at as string | null) ?? null,
    revokedAt:  (r.revoked_at as string | null) ?? null,
    expiresAt:  (r.expires_at as string | null) ?? null,
  };
}

/** List a user's keys, newest first. Never returns the hash. */
export async function listExtensionApiKeys(userId: string): Promise<ExtensionApiKeyRow[]> {
  const db = createServerClient();
  const { data, error } = await db
    .from("extension_api_keys")
    .select("id, key_id, name, key_suffix, created_at, last_used_at, revoked_at, expires_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) {
    console.error("[extension-keys] list failed:", error.message);
    return [];
  }
  return (data ?? []).map(mapRow);
}

/**
 * Create a new key for the user. Returns the full key ONCE — callers must
 * show it immediately and never persist it client-side beyond that.
 */
export async function createExtensionApiKey(
  userId: string,
  name = "Chrome Extension",
): Promise<{ fullKey: string; row: ExtensionApiKeyRow } | { error: string }> {
  const db = createServerClient();

  const { count } = await db
    .from("extension_api_keys")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("revoked_at", null);
  if ((count ?? 0) >= MAX_ACTIVE_KEYS_PER_USER) {
    return { error: `You can have at most ${MAX_ACTIVE_KEYS_PER_USER} active keys. Revoke one first.` };
  }

  const gen = generateKey();
  const { data, error } = await db
    .from("extension_api_keys")
    .insert({
      user_id:    userId,
      key_id:     gen.keyId,
      key_hash:   gen.hash,
      key_secret: gen.secret,
      key_suffix: gen.suffix,
      name:       name.slice(0, 80) || "Chrome Extension",
    })
    .select("id, key_id, name, key_suffix, created_at, last_used_at, revoked_at, expires_at")
    .single();

  if (error || !data) {
    console.error("[extension-keys] create failed:", error?.message);
    return { error: "Could not create the key — please try again." };
  }
  return { fullKey: gen.fullKey, row: mapRow(data) };
}

/**
 * Every seller gets exactly one fixed key — this is what the dashboard's
 * API-key card calls. Returns the seller's existing active key (rebuilt
 * from `key_id` + `key_secret`) if they have one, otherwise creates the
 * first one. A key from before the fixed-key model (key_secret NULL) can't
 * be redisplayed, so it's revoked and replaced rather than shown broken.
 */
export async function getOrCreateExtensionApiKey(
  userId: string,
): Promise<{ fullKey: string; row: ExtensionApiKeyRow } | { error: string }> {
  const db = createServerClient();

  const { data: existing, error } = await db
    .from("extension_api_keys")
    .select("id, key_id, key_secret, name, key_suffix, created_at, last_used_at, revoked_at, expires_at")
    .eq("user_id", userId)
    .is("revoked_at", null)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[extension-keys] getOrCreate lookup failed:", error.message);
    return { error: "Could not load your API key — please try again." };
  }

  if (existing?.key_secret) {
    return { fullKey: `${PREFIX}${existing.key_id}_${existing.key_secret}`, row: mapRow(existing) };
  }
  if (existing) {
    await db.from("extension_api_keys").update({ revoked_at: new Date().toISOString() }).eq("id", existing.id);
  }
  return createExtensionApiKey(userId);
}

/** Revoke the seller's current key(s) and issue a fresh fixed key. */
export async function regenerateExtensionApiKey(
  userId: string,
): Promise<{ fullKey: string; row: ExtensionApiKeyRow } | { error: string }> {
  const db = createServerClient();
  await db
    .from("extension_api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("user_id", userId)
    .is("revoked_at", null);
  return createExtensionApiKey(userId);
}

/** Revoke a key. Scoped to the owning user so one seller can't revoke another's. */
export async function revokeExtensionApiKey(userId: string, keyId: string): Promise<boolean> {
  const db = createServerClient();
  const { error, data } = await db
    .from("extension_api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("key_id", keyId)
    .is("revoked_at", null)
    .select("id");
  if (error) {
    console.error("[extension-keys] revoke failed:", error.message);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

// ─── Authentication (called from the extension endpoint) ────────────────────

export interface ExtensionAuthResult {
  ok:      true;
  userId:  string;
  keyId:   string;
}
export interface ExtensionAuthError {
  ok:    false;
  error: string; // safe to show the caller — never leaks hash/pepper details
}

/** Parse `Authorization: Bearer pw_live_<keyId>_<secret>`. */
function parseAuthHeader(header: string | null): { keyId: string; secret: string } | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = m ? m[1].trim() : header.trim();
  if (!token.startsWith(PREFIX)) return null;
  const rest = token.slice(PREFIX.length); // "<keyId>_<secret>"
  const idx = rest.indexOf("_");
  if (idx < 1) return null;
  return { keyId: rest.slice(0, idx), secret: rest.slice(idx + 1) };
}

/**
 * Validate an extension API key from an Authorization header. Updates
 * last_used_at on success (fire-and-forget — never blocks the response on
 * that write). Returns a safe, user-facing error string on failure.
 */
export async function authenticateExtensionKey(
  authHeader: string | null,
): Promise<ExtensionAuthResult | ExtensionAuthError> {
  const parsed = parseAuthHeader(authHeader);
  if (!parsed) {
    return { ok: false, error: "Missing or malformed API key. Paste your key from /extension/dashboard into the extension's Settings." };
  }

  const db = createServerClient();
  const { data, error } = await db
    .from("extension_api_keys")
    .select("user_id, key_hash, revoked_at, expires_at")
    .eq("key_id", parsed.keyId)
    .maybeSingle();

  if (error || !data) {
    return { ok: false, error: "Invalid API key." };
  }
  if (data.revoked_at) {
    return { ok: false, error: "This API key has been revoked. Generate a new one on /extension/dashboard." };
  }
  if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) {
    return { ok: false, error: "This API key has expired. Generate a new one on /extension/dashboard." };
  }

  const expected = Buffer.from(hashSecret(parsed.secret), "hex");
  const actual   = Buffer.from(String(data.key_hash), "hex");
  const valid = expected.length === actual.length && timingSafeEqual(expected, actual);
  if (!valid) {
    return { ok: false, error: "Invalid API key." };
  }

  // Fire-and-forget — don't let a slow write delay the autofill response.
  db.from("extension_api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("key_id", parsed.keyId)
    .then(undefined, () => {});

  return { ok: true, userId: data.user_id as string, keyId: parsed.keyId };
}

// ─── Usage log (for the dashboard's usage-stats section) ────────────────────

export async function logExtensionFillEvent(args: {
  userId: string;
  keyId: string | null;
  fieldsFilled: number;
  mock: boolean;
}): Promise<void> {
  const db = createServerClient();
  const { error } = await db.from("extension_fill_events").insert({
    user_id:       args.userId,
    key_id:        args.keyId,
    fields_filled: args.fieldsFilled,
    mock:          args.mock,
  });
  if (error) console.warn("[extension-keys] failed to log fill event:", error.message);
}

export interface ExtensionFillEventRow {
  id: string;
  createdAt: string;
  fieldsFilled: number;
  mock: boolean;
}

/**
 * Recent autofill activity for the "My listings" page. The extension writes
 * straight into Jumia's own form — we never learn the final listing (title,
 * price, etc.), only that a fill happened and how many fields it touched —
 * so this is an activity log, not a listings table.
 */
export async function listRecentFillEvents(userId: string, limit = 30): Promise<ExtensionFillEventRow[]> {
  const db = createServerClient();
  const { data, error } = await db
    .from("extension_fill_events")
    .select("id, created_at, fields_filled, mock")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.warn("[extension-keys] listRecentFillEvents failed:", error.message);
    return [];
  }
  return (data ?? []).map((r) => ({
    id: r.id as string,
    createdAt: r.created_at as string,
    fieldsFilled: r.fields_filled as number,
    mock: r.mock as boolean,
  }));
}

/** Count of autofills in the last N days, for the dashboard's usage stat. */
export async function countRecentFills(userId: string, days = 30): Promise<number> {
  const db = createServerClient();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { count, error } = await db
    .from("extension_fill_events")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", since);
  if (error) {
    console.warn("[extension-keys] countRecentFills failed:", error.message);
    return 0;
  }
  return count ?? 0;
}
