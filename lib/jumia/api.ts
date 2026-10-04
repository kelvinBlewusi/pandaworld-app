/**
 * Jumia Vendor API — product API helpers (server-only)
 *
 * API base:  https://vendor-api.jumia.com
 * Spec:      https://vendorcenter.jumia.com/api-docs/  (GPM & GOP API)
 * Postman:   https://www.postman.com/jumiagandalf/jumia-vendor-api
 *
 * Rate limit: 200 req/min, max 4 req/sec
 *
 * Product creation is ASYNC:
 *   POST /feeds/products/create  →  { feedId: "<uuid>" }
 *   GET  /feeds/{feedId}         →  feed status (poll until DONE/ERROR)
 */

import { createServerClient } from "@/lib/supabase/server";
import { columnFor, readAttributeValue, aliasesForColumn, type MappedColumn } from "@/lib/jumia/attribute-mapping";
import { preflightAttributes, summarisePreflight, snapToAllowedWithSynonyms, type PreflightNote } from "@/lib/jumia/preflight";
import { refreshAccessToken, JumiaTokenError, JUMIA_API_BASE } from "@/lib/jumia/oauth";
import { mockCategories } from "@/lib/mock/categories";
import { findBrandExact } from "@/lib/jumia/brands";
import { stripBrandFromTitle } from "@/lib/ai/jumia-content-policy";
import { encrypt, decrypt } from "@/lib/security/token-crypto";
import { getCategoryAttributes, getVariantAxes, getCategoryByCode, fetchAttributesFromJumia, upsertAttributes, type JumiaCategoryAttribute } from "@/lib/jumia/categories";
import { isFashionCategory } from "@/lib/jumia/fashion-category";
import { assertListingReady } from "@/lib/jumia/listing-ready";
import type { ListingRow, VariantRow } from "@/lib/supabase/types";
import { loadLearnedRestrictedWords } from "@/lib/jumia/learned-restricted-words";

// ─── Country → ISO 4217 currency code ────────────────────────────────────────
//
// Exported so lib/whatsapp/batch.ts's price/sale-price extraction can parse
// a seller's chat note in THEIR shop's currency instead of the hardcoded
// GH₵/cedis patterns it started with — PandaWorld lists Jumia sellers across
// Africa, not just Ghana. Keep this the single source of truth for the
// mapping; getValidJumiaCredentials below and extractPrice/extractSalePrice
// both key off it.
export const COUNTRY_CURRENCY: Record<string, string> = {
  GH: "GHS",
  NG: "NGN",
  KE: "KES",
  EG: "EGP",
  MA: "MAD",
  SN: "XOF",
  CI: "XOF",
  TZ: "TZS",
  UG: "UGX",
};

export const DEFAULT_JUMIA_COUNTRY = "GH";

/** Short display form for chat copy ("GH₵150", "₦2,000") — distinct from
 *  the ISO code COUNTRY_CURRENCY resolves, which Jumia's own API needs
 *  verbatim. Falls back to the ISO code itself for a currency with no
 *  common short symbol. */
export const CURRENCY_SYMBOL: Record<string, string> = {
  GHS: "GH₵",
  NGN: "₦",
  KES: "KSh",
  EGP: "E£",
  MAD: "MAD",
  XOF: "CFA",
  TZS: "TSh",
  UGX: "USh",
};

export function currencySymbol(currencyCode: string): string {
  return CURRENCY_SYMBOL[currencyCode] ?? currencyCode;
}

/** The everyday spoken name of a currency unit ("cedis", "naira",
 *  "shillings") for chat copy like "reply with the number in {name}" —
 *  distinct from CURRENCY_SYMBOL, which is the printed short form. */
const CURRENCY_NAME_WORD: Record<string, string> = {
  GHS: "cedis",
  NGN: "naira",
  KES: "shillings",
  EGP: "pounds",
  MAD: "dirhams",
  XOF: "CFA francs",
  TZS: "shillings",
  UGX: "shillings",
};

export function currencyNameWord(currencyCode: string): string {
  return CURRENCY_NAME_WORD[currencyCode] ?? currencyCode;
}

/** currency → country. Only used where a currency code is on hand and a
 *  country is needed (e.g. picking a currency-symbol pattern for chat price
 *  parsing) — ambiguous for a shared currency (XOF: Senegal vs Ivory Coast),
 *  so it resolves to whichever country lists it first above. Prefer
 *  reading country directly (getValidJumiaCredentials) whenever it's on
 *  hand instead of round-tripping through this. */
export function countryForCurrency(currency: string): string {
  const hit = Object.entries(COUNTRY_CURRENCY).find(([, c]) => c === currency);
  return hit?.[0] ?? DEFAULT_JUMIA_COUNTRY;
}

// ─── Token refresh ──────────────────────────────────────────────────────────

/**
 * Jumia's documented refresh-error codes that mean the connection is
 * really, definitively dead — the refresh_token itself has been revoked
 * or was never valid for this client. Anything else (a network error, a
 * timeout, a 5xx, an error code we don't recognise) is treated as
 * transient: the access token might still have a few minutes of life
 * left, and the next call — this cron tick, the next page load — gets
 * another chance. Getting this wrong in the strict direction is what
 * turned "Jumia had a bad moment" into "reconnect your account", every
 * single day, for every seller.
 */
const DEFINITIVE_AUTH_DEATH_CODES = new Set(["invalid_grant", "invalid_token", "unauthorized_client"]);

export function isDefinitiveAuthDeath(status: number, code: string | undefined, description?: string): boolean {
  if (code && DEFINITIVE_AUTH_DEATH_CODES.has(code)) return true;
  // The application itself is gone: deleted in Vendor Center. Jumia says so
  // as a 400 "server_error — client not found" (seen live 2026-10-04), which
  // no retry can fix. Read as transient, the stored access token kept
  // working until it expired and then every push failed with no word to the
  // seller that they had to reconnect.
  return /client not found/i.test(description ?? "");
}

const REFRESH_LOCK_POLL_MS     = 400;
const REFRESH_LOCK_MAX_WAIT_MS = 4_000;
const REFRESH_LOCK_STALE_AFTER = "30 seconds";

/**
 * The ONE place a Jumia connection's access token is ever refreshed —
 * getValidJumiaCredentials, the feed-poll cron, and the connection health
 * check all route through this instead of each calling refreshAccessToken
 * inline.
 *
 * Two things every inline refresh got wrong on its own:
 *
 * 1. Wrong credentials. A seller's refresh_token is bound to THEIR OWN
 *    Vendor Center application (app_id/app_secret) — refreshAccessToken
 *    falls back to this platform's own JUMIA_CLIENT_ID/SECRET when no
 *    client is passed, which Jumia's auth server rejects outright for a
 *    token issued to a different client. Every caller now has to pass the
 *    connection's own app_id/app_secret — there is no safe default.
 *
 * 2. Racing rotations. Jumia rotates the refresh_token on every successful
 *    refresh and invalidates the previous one (its own "Refresh Token Best
 *    Practices"). Two callers noticing the same expiring token at once —
 *    the cron, a page load's health check, an in-flight push — and both
 *    refreshing independently each get back a DIFFERENT new refresh_token;
 *    whichever write loses persists a token Jumia has already thrown away,
 *    and the connection dies for good the next time it's needed. The
 *    claim_jumia_refresh_lock() row lock (see the migration) makes only
 *    one of them actually call Jumia; the rest wait for it to finish and
 *    reuse what it got.
 */
export async function refreshJumiaConnection(
  db:                ReturnType<typeof createServerClient>,
  userId:            string,
  refreshTokenPlain: string,
  appId:             string | undefined,
  appSecret:         string | undefined,
): Promise<{ accessToken: string; tokenExpiresAt: string }> {
  const { data: claimedRows, error: claimError } = await db.rpc("claim_jumia_refresh_lock", {
    p_user_id:    userId,
    p_stale_after: REFRESH_LOCK_STALE_AFTER,
  });
  if (claimError) {
    console.warn(`[Jumia refresh] lock claim failed for ${userId}: ${claimError.message}`);
  }
  const won = !claimError && Array.isArray(claimedRows) && claimedRows.length > 0;

  if (!won) {
    // Someone else is already refreshing this connection — wait for them
    // rather than racing a second refresh that would invalidate whichever
    // rotated refresh_token loses.
    const deadline = Date.now() + REFRESH_LOCK_MAX_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, REFRESH_LOCK_POLL_MS));
      const { data: row } = await db
        .from("jumia_connections")
        .select("access_token, token_expires_at, refresh_locked_at, status")
        .eq("user_id", userId)
        .maybeSingle();
      if (!row) break;
      if (row.status === "needs_reconnect") throw new Error("JUMIA_RECONNECT_REQUIRED");
      const stillLocked = row.refresh_locked_at
        && Date.now() - new Date(row.refresh_locked_at as string).getTime() < 30_000;
      const hasHeadroom = row.token_expires_at
        && new Date(row.token_expires_at as string).getTime() > Date.now() + 60_000;
      if (!stillLocked && hasHeadroom) {
        return {
          accessToken:    decrypt(row.access_token as string),
          tokenExpiresAt: row.token_expires_at as string,
        };
      }
    }
    // Gave up waiting rather than hang forever — fail open into our own
    // refresh attempt below. A redundant refresh is wasteful, not unsafe,
    // on its own; the loss only happens when two refreshes land AT ONCE,
    // which the lock already prevented for whichever call won it.
  }

  try {
    const fresh = await refreshAccessToken(refreshTokenPlain, appId, appSecret);
    const tokenExpiresAt = new Date(Date.now() + fresh.expires_in * 1000).toISOString();
    const { error: writeError } = await db.from("jumia_connections").update({
      access_token:      encrypt(fresh.access_token),
      // Always store whatever Jumia returned — never fall back to the old
      // refresh_token. Jumia has already invalidated it as part of this
      // same rotation, so keeping it around just means the NEXT refresh
      // fails with a definitive, unrecoverable error.
      refresh_token:      fresh.refresh_token ? encrypt(fresh.refresh_token) : null,
      // When the new refresh token lapses — what /api/worker/jumia-keepalive
      // renews ahead of (Self Authorization apps only; null otherwise).
      refresh_token_expires_at: fresh.refresh_expires_in
        ? new Date(Date.now() + fresh.refresh_expires_in * 1000).toISOString()
        : null,
      token_expires_at:    tokenExpiresAt,
      status:              "active",
      refresh_locked_at:   null,
      updated_at:          new Date().toISOString(),
    }).eq("user_id", userId);
    if (writeError) {
      // A refreshed token we failed to persist is worse than not
      // refreshing at all — every later read decrypts the OLD row and
      // may retry with a refresh_token Jumia has already rotated away.
      console.error(`[Jumia refresh] got a fresh token for ${userId} but the DB write failed: ${writeError.message}`);
      throw new Error(`JUMIA_REFRESH_PERSIST_FAILED: ${writeError.message}`);
    }
    return { accessToken: fresh.access_token, tokenExpiresAt };
  } catch (e) {
    await db.from("jumia_connections").update({ refresh_locked_at: null }).eq("user_id", userId);

    if (e instanceof JumiaTokenError && isDefinitiveAuthDeath(e.status, e.code, e.description)) {
      console.error(`[Jumia refresh] definitive auth death for ${userId}: ${e.message}`);
      await markNeedsReconnect(db, userId);
      throw new Error("JUMIA_RECONNECT_REQUIRED");
    }
    // Transient: network error, timeout, 5xx, or an error we don't
    // recognise as definitive. Status is left untouched on purpose.
    console.warn(`[Jumia refresh] transient failure for ${userId}: ${(e as Error).message}`);
    throw new Error("JUMIA_REFRESH_TRANSIENT");
  }
}

// ─── Token + shopId retrieval ─────────────────────────────────────────────────

export async function getValidJumiaCredentials(userId: string): Promise<{
  accessToken: string;
  shopId:      string;
  currency:    string;
  country:     string;
}> {
  const db = createServerClient();

  const { data: conn, error } = await db
    .from("jumia_connections")
    .select("access_token, refresh_token, token_expires_at, status, shop_id, app_id, app_secret, country")
    .eq("user_id", userId)
    .maybeSingle();

  if (error || !conn)            throw new Error("JUMIA_NOT_CONNECTED");
  if (conn.status === "revoked") throw new Error("JUMIA_NOT_CONNECTED");

  // "credential_auth" is the sentinel stored when credentials were saved but
  // the seller hasn't yet completed the OAuth authorization code flow.
  // It's a literal string, not an encrypted token, so we check before decrypt.
  if (conn.access_token === "credential_auth") {
    throw new Error("JUMIA_OAUTH_REQUIRED");
  }

  // Decrypt — handles both encrypted ("enc:v1:...") and legacy plaintext
  // rows transparently. Plaintext rows get re-encrypted on the next
  // refresh (the write paths below + the OAuth callback both encrypt),
  // so the table heals itself over time without a one-shot migration.
  let accessToken = decrypt(conn.access_token as string);
  const refreshTokenPlain = conn.refresh_token ? decrypt(conn.refresh_token as string) : null;

  const expiresAtMs  = conn.token_expires_at ? new Date(conn.token_expires_at as string).getTime() : 0;
  const needsRefresh = !conn.token_expires_at || Date.now() >= expiresAtMs - 5 * 60 * 1000;

  if (needsRefresh) {
    if (!refreshTokenPlain) {
      await markNeedsReconnect(db, userId);
      throw new Error("JUMIA_RECONNECT_REQUIRED");
    }
    // Always attempted, even when status already reads needs_reconnect —
    // a refresh_token can outlive a single earlier failure (Jumia's own
    // refresh tokens run ~1 year vs. the access token's much shorter
    // life), so a past network blip or a lost lock race must never
    // permanently block a refresh_token that still works.
    const appId     = (conn.app_id     ?? undefined) as string | undefined;
    const appSecret = conn.app_secret ? decrypt(conn.app_secret as string) : undefined;
    const fresh     = await refreshJumiaConnection(db, userId, refreshTokenPlain, appId, appSecret);
    accessToken = fresh.accessToken;
  } else if (conn.status === "needs_reconnect") {
    // The token still has headroom, but a PAST refresh already hit a
    // definitive failure — that's the one case with nothing left to try
    // short of the seller reauthorising.
    throw new Error("JUMIA_RECONNECT_REQUIRED");
  }

  let shopId = (conn.shop_id ?? "") as string;
  if (!shopId) shopId = await fetchAndStoreShopId(userId, accessToken, db);
  if (!shopId) throw new Error("JUMIA_NO_SHOP_ID");

  const country  = (conn.country ?? DEFAULT_JUMIA_COUNTRY) as string;
  const currency = COUNTRY_CURRENCY[country] ?? "GHS";

  return { accessToken, shopId, currency, country };
}

/**
 * Mark a connection as needing reconnect. Called only on a DEFINITIVE
 * auth failure — see isDefinitiveAuthDeath — never on a network error, a
 * timeout, or a 5xx. The UI watches for this status and shows a
 * persistent banner directing the seller to /onboarding/connect.
 */
export async function markNeedsReconnect(
  userIdOrDb: string | ReturnType<typeof createServerClient>,
  userIdArg?: string
) {
  // Two call shapes for ergonomics:
  //   markNeedsReconnect(userId)
  //   markNeedsReconnect(db, userId)
  let db: ReturnType<typeof createServerClient>;
  let userId: string;
  if (typeof userIdOrDb === "string") {
    db = createServerClient();
    userId = userIdOrDb;
  } else {
    db = userIdOrDb;
    userId = userIdArg!;
  }
  const { error } = await db.from("jumia_connections").update({
    status:     "needs_reconnect",
    updated_at: new Date().toISOString(),
  }).eq("user_id", userId);
  if (error) {
    // Confirmed live, 2026-09-20: this write silently failed for EVERY
    // connection for months — the table's check constraint didn't allow
    // this value at all, and nothing here ever looked at the result.
    // Loud now on purpose; see the migration that fixed the constraint.
    console.error(`[Jumia] markNeedsReconnect failed to persist for ${userId}: ${error.message}`);
  }
}

/**
 * Test whether an arbitrary error / response status from a Jumia API call
 * indicates an OAuth problem (401 / 403). Used by route handlers to
 * decide whether to mark the connection needs_reconnect.
 */
// ─── Connection health check (server-side, with cache) ──────────────────────
//
// Used by app/(main)/layout.tsx to detect "seller deleted their OAuth app
// on the Jumia side" — which used to take up to an hour to surface
// (token kept working until refresh time) and could happen silently
// even with the client-side ReconnectBanner because the banner only
// fires after the page mounts, by which point the seller has already
// seen content they shouldn't.
//
// Probe strategy: hit /shops first (cheapest, most resilient endpoint
// requiring a live token). If that 401s, mark the row as
// needs_reconnect and return false. Result is cached per-userId for
// 60 seconds so we don't make a Jumia API call on every single page
// navigation — only the first one in each cache window.
//
// Cache is per-Vercel-function-instance; lost on cold starts. Same
// trade-off as the in-memory rate limiter (lib/rate-limit.ts) —
// acceptable for the first wave of users, can swap to Vercel KV
// later if cold-start churn becomes an issue.

interface HealthCacheEntry {
  ok:        boolean;
  checkedAt: number;
}
const HEALTH_CACHE_TTL_MS = 60_000;
const healthCache = new Map<string, HealthCacheEntry>();

export async function verifyJumiaConnection(
  userId: string,
): Promise<{ ok: boolean; reason?: string }> {
  // Honour cache — skip the Jumia round-trip when we just checked.
  const cached = healthCache.get(userId);
  if (cached && Date.now() - cached.checkedAt < HEALTH_CACHE_TTL_MS) {
    return { ok: cached.ok };
  }

  const db = createServerClient();

  // Quick DB pre-check. needs_reconnect / revoked rows don't need a
  // Jumia call — we already know they're broken.
  const { data: conn } = await db
    .from("jumia_connections")
    .select("status, access_token")
    .eq("user_id", userId)
    .maybeSingle();

  if (!conn) {
    healthCache.set(userId, { ok: false, checkedAt: Date.now() });
    return { ok: false, reason: "not_connected" };
  }
  if (conn.status === "needs_reconnect" || conn.status === "revoked") {
    healthCache.set(userId, { ok: false, checkedAt: Date.now() });
    return { ok: false, reason: conn.status };
  }
  if (conn.access_token === "credential_auth") {
    // Credential row exists but OAuth hasn't completed yet — this
    // isn't a "broken connection", it's an in-progress one. Don't
    // redirect from layout for these; the onboarding flow handles
    // them. Cache as ok so the layout doesn't keep retrying.
    healthCache.set(userId, { ok: true, checkedAt: Date.now() });
    return { ok: true };
  }

  // Resolve a valid access token. getValidJumiaCredentials handles
  // auto-refresh and marks needs_reconnect on its own if refresh fails.
  let accessToken: string;
  try {
    const creds = await getValidJumiaCredentials(userId);
    accessToken = creds.accessToken;
  } catch (e) {
    const msg = (e as Error).message;
    healthCache.set(userId, { ok: false, checkedAt: Date.now() });
    if (msg === "JUMIA_RECONNECT_REQUIRED") return { ok: false, reason: "needs_reconnect" };
    if (msg === "JUMIA_OAUTH_REQUIRED")     return { ok: false, reason: "oauth_required" };
    return { ok: false, reason: "error" };
  }

  // Probe a live Jumia endpoint. /shops needs the token to be both
  // valid AND tied to a still-existing OAuth app — the exact failure
  // mode the seller hit when they deleted their app on the Jumia side.
  try {
    const res = await fetch(`${JUMIA_API_BASE}/shops`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      signal:  AbortSignal.timeout(8_000),
    });
    if (res.status === 401 || res.status === 403) {
      console.warn(`[Jumia health] /shops returned ${res.status} for user ${userId} — flipping needs_reconnect`);
      await markNeedsReconnect(db, userId);
      healthCache.set(userId, { ok: false, checkedAt: Date.now() });
      return { ok: false, reason: "needs_reconnect" };
    }
    // 5xx and network errors are NOT treated as bad credentials — we
    // don't kick the seller out for transient Jumia hiccups. Return
    // ok and cache so we don't probe again right away.
    healthCache.set(userId, { ok: true, checkedAt: Date.now() });
    return { ok: true };
  } catch {
    // Network failure → don't punish the seller; cache ok briefly.
    healthCache.set(userId, { ok: true, checkedAt: Date.now() });
    return { ok: true };
  }
}

/** Clear the health cache for a user — call after reconnect succeeds. */
export function clearJumiaHealthCache(userId: string): void {
  healthCache.delete(userId);
}

export function isJumiaAuthError(status: number | undefined, body: unknown): boolean {
  if (status === 401 || status === 403) return true;
  if (typeof body === "object" && body !== null) {
    const b = body as Record<string, unknown>;
    const msg = String(b.error ?? b.message ?? "").toLowerCase();
    if (msg.includes("unauthor") || msg.includes("invalid_grant") || msg.includes("invalid_token")) return true;
  }
  return false;
}

async function fetchAndStoreShopId(
  userId:      string,
  accessToken: string,
  db:          ReturnType<typeof createServerClient>
): Promise<string> {
  // Official endpoint: GET /shops
  try {
    const res = await fetch(`${JUMIA_API_BASE}/shops`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (res.ok) {
      const data = await res.json();
      console.info("[Jumia API] /shops response:", JSON.stringify(data).slice(0, 200));
      const list = Array.isArray(data) ? data : (data.shops ?? data.data ?? data.content ?? []);
      const shop = list[0];
      const id   = shop?.id ?? shop?.shopId ?? shop?.shop_id ?? "";
      if (id) {
        await db.from("jumia_connections").update({
          shop_id:    String(id),
          store_name: shop?.name ?? shop?.shopName ?? null,
          updated_at: new Date().toISOString(),
        }).eq("user_id", userId);
        console.info("[Jumia API] Stored shopId:", id);
        return String(id);
      }
    } else {
      console.warn("[Jumia API] GET /shops failed:", res.status, await res.text().catch(() => ""));
    }
  } catch (e) {
    console.warn("[Jumia API] GET /shops error:", (e as Error).message);
  }
  return "";
}

// ─── Brand lookup ─────────────────────────────────────────────────────────────

// Jumia special brand codes:
const BRAND_GENERIC_NON_FASHION = { code: 1045133, name: "Generic" };
const BRAND_GENERIC_FASHION     = { code: 1039426, name: "Fashion" };

/**
 * Resolve a brand name to a Jumia { code, name } pair.
 *
 * Resolution order:
 *   1. Local `jumia_brands` DB cache  (fast, no network)
 *   2. Live Jumia Catalog API          (fallback before first sync)
 *   3. Generic brand code — Fashion for a Fashion category, plain Generic
 *      otherwise (last resort)
 *
 * `categoryHint` is whatever category text the caller has on hand
 * (category_path is fine — this never needs a resolved code) so the last
 * resort can tell a Fashion listing from anything else. BRAND_GENERIC_FASHION
 * used to be declared and never referenced: every unresolved brand fell back
 * to plain "Generic", including shoes, bags and watches, which is its own
 * rejection class on Jumia ("Product category doesn't allow Generic brand").
 */
export async function resolveBrand(
  accessToken:  string,
  brandName:    string | null,
  categoryHint: string | null = null,
): Promise<{ code: number; name: string }> {
  const genericFallback = isFashionCategory(categoryHint) ? BRAND_GENERIC_FASHION : BRAND_GENERIC_NON_FASHION;

  if (!brandName) return genericFallback;

  // ── 1. Local DB (fast path) ──────────────────────────────────────────────
  try {
    const cached = await findBrandExact(brandName);
    if (cached) return { code: cached.code, name: cached.name };
  } catch {
    // Table not created yet or DB error — fall through
  }

  // ── 2. Live Jumia API ────────────────────────────────────────────────────
  try {
    const url = `${JUMIA_API_BASE}/catalog/brands?name=${encodeURIComponent(brandName)}&criteria=EQUALS_IGNORE_CASE`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (res.ok) {
      const data  = await res.json();
      const list  = Array.isArray(data) ? data : (data.brands ?? data.content ?? []);
      const match = list[0];
      if (match?.code) {
        return { code: Number(match.code), name: match.name ?? brandName };
      }
    }
  } catch {
    // non-fatal
  }

  // ── 3. Generic fallback (Fashion or plain, per categoryHint) ─────────────
  //
  // Returns the FALLBACK's own name ("Generic"/"Fashion"), not the
  // original unresolved brandName — a real, live bug: sending Generic's
  // code alongside the original (unrecognised or restricted) brand name
  // text meant Jumia's own QC, which validates the brand NAME independent
  // of the code (see this function's doc comment: "Product category
  // doesn't allow Generic brand" already proves Jumia inspects the name),
  // saw the identical restricted brand again and rejected it again — a
  // seller tapping "Fix & resubmit" on an unlistable brand saw no change
  // at all, because the one field Jumia actually checks never changed.
  return genericFallback;
}

// ─── Category code resolution ─────────────────────────────────────────────────

function resolveCategoryCode(listing: ListingRow): { code: number; name: string } {
  // Try listing.category_code (set by AI during generation)
  if (listing.category_code) {
    const parsed = parseInt(listing.category_code, 10);
    if (!isNaN(parsed) && parsed > 0) {
      const cat = mockCategories.find((c) => c.code === listing.category_code);
      return { code: parsed, name: cat?.name ?? listing.category_path ?? listing.category_code };
    }
  }

  // Try matching category_path against mock categories
  if (listing.category_path) {
    const cat = mockCategories.find(
      (c) => c.path === listing.category_path || c.name === listing.category_path
    );
    if (cat) {
      const parsed = parseInt(cat.code, 10);
      if (!isNaN(parsed)) return { code: parsed, name: cat.name };
    }
  }

  // Try category_id as numeric code
  if (listing.category_id) {
    const parsed = parseInt(listing.category_id, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return { code: parsed, name: listing.category_path ?? listing.category_id };
    }
  }

  // No numeric code anywhere. Fail loudly — the push route's validation
  // should have caught this; if we reach here, refuse to send code: 0
  // (which Jumia silently drops and produces the cryptic "category
  // can't be used for listing" error).
  throw new Error(
    "JUMIA_NO_CATEGORY_CODE: Listing has no valid numeric category. " +
    "Open the listing and pick a category from the drawer."
  );
}

// ─── Attribute builder ────────────────────────────────────────────────────────

interface JumiaAttribute {
  name:         string;
  value:        string;
  translations: never[];
}

// Attribute names that Jumia treats as PER-VARIANT axes, NOT listing-level
// metadata. When the seller fills these in the Product Specification form
// (because they appear in the per-category schema), we must NOT spray the
// listing-level value across every variant — that produces duplicates and
// Jumia rejects the feed with "Product with variation [X] already exists
// in parent sku [Y]".
//
// Each per-variant attribute is injected from variant.variation in
// mapListingToJumiaProducts, so each product carries its own unique value.
const PER_VARIANT_ATTRIBUTE_NAMES = new Set<string>(["variation"]);

/**
 * dynamic_attributes keys that duplicate a field the PRODUCT object
 * already carries. Never sent as attributes — see buildAttributes.
 *
 * Measured across live listings: of the 14 column-mapped names that
 * actually appear in dynamic_attributes, 12 are already harmless because
 * a static add() above claims the name first and the dedup guard drops
 * the copy. Only these two slipped through, on 28 listings each.
 */
const PRODUCT_LEVEL_ATTRIBUTE_NAMES = new Set([
  "description", "product_description",   // → product.description
  "name", "product_name", "title",        // → product.name
]);

/**
 * Every schema-required name the product carries OUTSIDE its attribute
 * list, so the pre-flight's required check doesn't report them missing.
 *
 * Jumia marks name, description and variation required on effectively
 * every category; all three are sent, just not as attributes. Without
 * this the required check fired three false positives on every push and
 * could never be trusted as a gate — only as a log line, which is all it
 * was until a real "product_weight is missing" rejection got through it.
 */
const CARRIED_OUTSIDE_ATTRIBUTES: string[] = [
  ...Array.from(PRODUCT_LEVEL_ATTRIBUTE_NAMES),
  ...Array.from(PER_VARIANT_ATTRIBUTE_NAMES),
];

/**
 * Which spelling of a column-backed field THIS category's schema actually
 * declares. Jumia uses different attribute names for the same logical
 * field across categories (color/colour, weight/weight_kg/product_weight,
 * warranty/warranty_text/product_warranty, …) — sending the wrong one
 * doesn't just fail to match a nicer name, it gets the whole attribute
 * dropped by preflightAttributes as "not visible for category" and the
 * value is lost, even though the category genuinely accepts that field
 * under its own name.
 *
 * `defaultName` is tried first (preserves today's behaviour whenever the
 * schema uses the name already hardcoded here or the schema is empty/
 * unknown), then every other known alias for `column`, in the order
 * declared in ATTRIBUTE_TO_COLUMN. Falls back to `defaultName` if the
 * schema declares none of them — preflightAttributes still reports that
 * correctly as "not_in_schema" for a category that truly doesn't accept
 * the field at all.
 */
function resolveAttrName(schema: JumiaCategoryAttribute[], defaultName: string, column: MappedColumn): string {
  if (schema.length === 0) return defaultName;
  const bySchema = new Set(schema.map((f) => f.name.toLowerCase()));
  if (bySchema.has(defaultName.toLowerCase())) return defaultName;
  for (const alias of aliasesForColumn(column)) {
    if (bySchema.has(alias.toLowerCase())) return alias;
  }
  return defaultName;
}

function buildAttributes(
  listing: ListingRow,
  schema: JumiaCategoryAttribute[],
  /** Collects every change made on the way out, already phrased for a
   *  seller, so the caller can TELL them. Silent repair is still repair
   *  happening behind their back. */
  noteSink?: string[],
  /** Collects the RAW preflight notes (with their .reason tag), for a
   *  caller that needs to tell "dropped, push would still succeed"
   *  (truncated, snapped_enum, rounded_number) apart from "dropped, and
   *  Jumia would have rejected the whole feed over it" (decimal_mismatch_
   *  blocked, invalid_enum, invalid_number) — see assessListingPushReadiness
   *  in lib/whatsapp/readiness.ts. noteSink's own describeAdjustments()
   *  output already collapses that distinction into seller-facing prose,
   *  which is right for a human but not enough for Ready/Held logic. */
  preflightNoteSink?: PreflightNote[],
): JumiaAttribute[] {
  const attrs: JumiaAttribute[] = [];
  const requiredNames = new Set(
    schema.filter((f) => f.required).map((f) => f.name.toLowerCase()),
  );

  const add = (name: string, value: string | null | undefined) => {
    if (value != null && value !== "") {
      attrs.push({ name, value: String(value), translations: [] });
    }
  };

  add(resolveAttrName(schema, "color",              "color"),              listing.color);
  add(resolveAttrName(schema, "color_family",       "color_family"),       listing.color_family);
  add(resolveAttrName(schema, "main_material",      "main_material"),      listing.main_material);
  add(resolveAttrName(schema, "material_family",    "material_family"),    listing.material_family);
  add(resolveAttrName(schema, "model",              "model"),              listing.model);
  add(resolveAttrName(schema, "product_line",       "product_line"),       listing.product_line);
  add(resolveAttrName(schema, "production_country", "production_country"), listing.production_country);
  add(resolveAttrName(schema, "warranty_duration",  "warranty_duration"),  listing.warranty_duration);
  add(resolveAttrName(schema, "warranty_type",      "warranty_type"),      listing.warranty_type);
  add(resolveAttrName(schema, "warranty_address",   "warranty_address"),   listing.warranty_address);
  add(resolveAttrName(schema, "product_warranty",   "warranty_text"),      listing.warranty_text);
  add(resolveAttrName(schema, "youtube_id",         "youtube_id"),         listing.youtube_id);
  add(resolveAttrName(schema, "short_description",  "highlights"),         listing.highlights);
  add("manufacturer_txt",   listing.brand);

  if (listing.weight_kg != null) {
    add(resolveAttrName(schema, "product_weight", "weight_kg"), `${listing.weight_kg} kg`);
  }

  // Some categories declare length/width/height as three SEPARATE
  // attributes (their own required-ness, their own number type) rather
  // than one free-text "product_measures" field. Collapsing into the
  // combined string unconditionally meant those categories never received
  // size_l/size_w/size_h under their own names — Jumia rejected
  // "product_measures" as not visible for the category AND separately
  // reported size_l/size_w/size_h missing, for a value the seller had
  // actually supplied. Prefer whichever shape this category's schema
  // actually declares; only fall back to the combined field when none of
  // the three individual names are present (including when the schema is
  // empty/unknown, matching prior behaviour exactly).
  const dimensionNames = {
    size_l: schema.length > 0 ? aliasesForColumn("size_l").find((n) => schema.some((f) => f.name.toLowerCase() === n.toLowerCase())) : undefined,
    size_w: schema.length > 0 ? aliasesForColumn("size_w").find((n) => schema.some((f) => f.name.toLowerCase() === n.toLowerCase())) : undefined,
    size_h: schema.length > 0 ? aliasesForColumn("size_h").find((n) => schema.some((f) => f.name.toLowerCase() === n.toLowerCase())) : undefined,
  };
  if (dimensionNames.size_l || dimensionNames.size_w || dimensionNames.size_h) {
    if (dimensionNames.size_l && listing.size_l != null) add(dimensionNames.size_l, String(listing.size_l));
    if (dimensionNames.size_w && listing.size_w != null) add(dimensionNames.size_w, String(listing.size_w));
    if (dimensionNames.size_h && listing.size_h != null) add(dimensionNames.size_h, String(listing.size_h));
  } else {
    const measures = [
      listing.size_l != null ? `L: ${listing.size_l} cm` : null,
      listing.size_w != null ? `W: ${listing.size_w} cm` : null,
      listing.size_h != null ? `H: ${listing.size_h} cm` : null,
    ].filter(Boolean).join(" × ");
    if (measures) add("product_measures", measures);
  }

  if (listing.certifications?.length) {
    add(resolveAttrName(schema, "certifications", "certifications"), listing.certifications.join(", "));
  }

  // Merge in category-specific dynamic attributes (AI-detected + seller-edited)
  // These are the real Jumia attribute field names (e.g. ram, operating_system, network)
  const dynAttrs = listing.dynamic_attributes as Record<string, string> | null;
  if (dynAttrs) {
    for (const [name, dynValue] of Object.entries(dynAttrs)) {
      if (dynValue != null && String(dynValue).trim() !== "") {
        // Skip per-variant attribute names — those get injected per-product
        // in mapListingToJumiaProducts using each variant's own value.
        if (PER_VARIANT_ATTRIBUTE_NAMES.has(name.toLowerCase())) continue;
        // Skip anything the product object already carries at top level —
        // description and name. auto-analyze writes a SECOND copy of each
        // into dynamic_attributes whenever the category schema happens to
        // define an attribute of that name (plain text where the column
        // holds rich HTML, in description's case). Sending both means
        // Jumia receives two contradictory values for one product, and an
        // attribute the category may not declare risks the exact
        // "Attribute [x] is not visible for category [y]" rejection that
        // has already failed pushes here.
        if (PRODUCT_LEVEL_ATTRIBUTE_NAMES.has(name.toLowerCase())) continue;

        // Every other column-mapped name: send the COLUMN, not the
        // dynamic_attributes copy. The column is what the editors write
        // and what the seller sees, so a copy can only ever be equal or
        // stale — a seller who corrects the colour would otherwise have
        // the old one pushed. Today the dedup guard below already makes
        // this a no-op for the twelve names a static add() claims first;
        // it matters for any column-mapped attribute a future category
        // schema introduces without one.
        const columnBacked = columnFor(name);
        let value = columnBacked ? readAttributeValue(listing, name) : String(dynValue);

        // An empty COLUMN used to drop the attribute outright, taking the
        // value we already hold in dynamic_attributes with it. For an
        // optional attribute that costs one field. For a REQUIRED one it
        // costs the whole product: Jumia answers "The column
        // [product_weight] is missing from the file" and throws away
        // every product in the feed — which is exactly what happened to
        // three listings, one of them with "product_weight": "1.3"
        // sitting in dynamic_attributes the entire time.
        //
        // Scoped to required attributes on purpose. Where the column is
        // optional, empty can be a deliberate clearing by the seller, and
        // resurrecting a stale AI copy would overrule them. A required
        // field has no valid empty state, so there is nothing to overrule.
        if (columnBacked && value.trim() === "" && requiredNames.has(name.toLowerCase())) {
          value = String(dynValue);
        }
        if (value.trim() === "") continue;
        // Don't duplicate attributes already set above
        if (!attrs.find((a) => a.name === name)) {
          attrs.push({ name, value, translations: [] });
        }
      }
    }
  }

  // Validate the whole payload against the category's own schema before it
  // leaves — see lib/jumia/preflight.ts. This supersedes the enum-only
  // sanitiser that used to run here, and closes the hole that cost three
  // of the seven rejections on record: an attribute the category does not
  // DECLARE was passed through untouched, and Jumia answered "Attribute
  // [color_family] is not visible for category [Laptops]" and threw away
  // the whole feed.
  //
  // Also upgrades the enum handling from drop-on-mismatch to
  // snap-then-drop, so a casing or plural near-miss is corrected rather
  // than silently losing the seller an attribute they did supply.
  const preflight = preflightAttributes(attrs, schema, {
    carriedElsewhere: CARRIED_OUTSIDE_ATTRIBUTES,
  });
  const summary = summarisePreflight(preflight);
  if (summary) {
    console.info(`[Jumia preflight] ${summary} — ${preflight.notes.map((n) => `${n.attribute}: ${n.detail}`).join("; ")}`);
  }
  if (noteSink) noteSink.push(...describeAdjustments(preflight.notes));
  if (preflightNoteSink) preflightNoteSink.push(...preflight.notes);
  return preflight.attributes.map((a) => ({ name: a.name, value: a.value, translations: [] }));
}

// ─── Payload mapping ──────────────────────────────────────────────────────────

/** Translated string field — Jumia uses { value, translations: [] } shape */
function t(value: string) {
  return { value, translations: [] as never[] };
}

/**
 * Fallback for a variant row that's missing its own typed `variation` —
 * fixed on purpose, see mapListingToJumiaProducts's doc comment on why
 * this must never be a detected colour.
 */
const MISSING_VARIANT_VARIATION = "Default";

/**
 * Is this colour string a single colour, or a list of them?
 *
 * A single-SKU product takes its detected colour as its `variation` label,
 * which is strictly more useful to a buyer than the literal "Default" —
 * but only while the colour names ONE thing. When the AI sees a product
 * photographed in several colourways it stores them all
 * ("Black, Silver, White"), and that string went straight out as the
 * variation of a single SKU. Observed live on 2026-09-15: a pair of
 * headphones shipped to Jumia as one product whose variation read
 * "Black, Silver, White" — a label no buyer can choose from, on a listing
 * that only ever had one SKU behind it.
 *
 * A list means the seller has variants they have not set up yet, not a
 * name for this one. "Default" is the honest answer there, and it leaves
 * the real colours visible in the colour attribute where they belong.
 */
function isSingleColour(value: string): boolean {
  if (!value) return false;
  // "&" sits in the character class rather than the word-boundary
  // alternation: \b& never matches, since & is not a word character.
  return !/[,/|&]|\band\b/i.test(value);
}

/**
 * Snap a variation label to the category's own variant-axis spelling ("Grey"
 * -> "Gray" when "Gray" is the allowed option) and refuse to ship a
 * comma/slash-joined list as one SELECTION value — real rejection:
 * "Attribute [variation] with invalid value [Grey]" (axis declared "Gray",
 * not "Grey") and "Attribute [color_family] with invalid value
 * [Yellow,Red,Orange,White,Blue]" (five stocked colours sent as one string).
 *
 * `variantAxes` is the category's own is_variant attribute set (see
 * getVariantAxes in lib/jumia/categories.ts) — the same isSingleColour rule
 * color_family already got is applied here too, now checked against the
 * category's real allowed spellings instead of shipped as typed.
 */
/** Snap a variation value to the category's own variant-axis spelling —
 *  shared tail of both resolvers below. snapToAllowedWithSynonyms (see
 *  lib/jumia/preflight.ts) covers both a casing/plural near-miss and a
 *  British/American spelling pair ("Grey" -> "Gray") in one call, and is
 *  the same function the draft-time reconciliation in auto-analyze.ts and
 *  preflightAttributes' own enum check use — one shared table so the
 *  three cannot drift on which spelling pairs they know about. A no-op
 *  when no axis data is available. */
function snapVariationSpelling(trimmed: string, allowed: string[], noteSink?: string[]): string {
  if (allowed.length === 0) return trimmed;

  const snapped = snapToAllowedWithSynonyms(trimmed, allowed);
  if (snapped && snapped !== trimmed) {
    noteSink?.push(`variation "${trimmed}" corrected to "${snapped}"`);
    return snapped;
  }
  return trimmed;
}

/**
 * The variation to send when there's nothing to go on: no colour the
 * seller stated themselves, no persisted variant row — just a single-SKU
 * product with nothing distinguishing it. Every listing defaults to this
 * rather than a guessed colour or the meaningless literal "Default",
 * unless the seller actually said what the variant is (see
 * buildBaseProduct's doc comment on the seller-notes gate).
 *
 * Jumia's own Vendor Center offers "..." as a genuine, selectable
 * placeholder in every variant-axis dropdown for exactly this "nothing to
 * pick" situation (the same convention reconcileDraftVariation and
 * resolveColorFallbackVariation already rely on below), so that ships
 * whenever the category's axis is unrestricted or explicitly lists "..."
 * as one of its own options. A category whose axis is a closed list that
 * does NOT offer "..." has nothing safe to send without seller input —
 * held via `blockers` rather than guessing one of the category's
 * unrelated options.
 */
function resolveDefaultVariation(
  variantAxes: JumiaCategoryAttribute[],
  blockers?:   string[],
): string {
  const allowed = variantAxes.flatMap((a) => a.allowed_values ?? []);
  if (allowed.length === 0 || allowed.includes("...")) return "...";

  const shown = allowed.length > 8
    ? `${allowed.slice(0, 8).join(", ")}, and ${allowed.length - 8} more`
    : allowed.join(", ");
  blockers?.push(
    `This category needs a variation picked from its own stocked options (${shown}) — mention it in your listing notes, or pick one in the editor.`,
  );
  return "...";
}

/**
 * The base (zero-variant) product's OWN variation, derived from a colour
 * the SELLER stated themselves — see buildBaseProduct's doc comment on why
 * this is only ever called with a seller-specified colour, never an
 * AI-guessed one. Keeps isSingleColour's broad separator check
 * (comma/slash/pipe/&/"and") because this value comes from a COLOUR
 * column specifically, where a joined string overwhelmingly means multiple
 * colourways, not a composite label — unlike a variant row's own typed
 * value (see resolveVariantRowVariation below), which routinely legitimately
 * joins several DIFFERENT attributes ("8GB / 128GB / Navy").
 *
 * Same local hold as resolveVariantRowVariation, and for the identical
 * reason: a category whose variant axis is something OTHER than colour
 * (sizes, lengths in inches, capacities) can never accept a colour value no
 * matter how it's spelled. Real rejection this closed, live, back when this
 * fallback ran on every AI-guessed colour rather than only a seller-stated
 * one: a Baby Carrier with zero persisted variant rows shipped "Blue" as
 * its variation into a category whose axis is entirely shoe/strap lengths
 * in inches — "Attribute [variation] with invalid value [Blue]".
 */
function resolveColorFallbackVariation(
  rawColor:    string,
  variantAxes: JumiaCategoryAttribute[],
  noteSink?:   string[],
  blockers?:   string[],
): string {
  const trimmed = rawColor.trim();
  if (!trimmed || !isSingleColour(trimmed)) return resolveDefaultVariation(variantAxes, blockers);

  const allowed = variantAxes.flatMap((a) => a.allowed_values ?? []);
  const snapped = snapVariationSpelling(trimmed, allowed, noteSink);

  // Same "nothing matched" test as resolveVariantRowVariation: an axis
  // that declares options, none of which is this colour even after
  // synonym/spelling snapping.
  if (
    allowed.length > 0 &&
    snapped === trimmed &&
    !allowed.some((a) => a.toLowerCase() === trimmed.toLowerCase())
  ) {
    // Same fallback reconcileDraftVariation uses at draft time — Jumia's
    // own Vendor Center offers "..." as a genuine, accepted placeholder
    // for exactly this category shape (confirmed live: a Baby Carrier in
    // a "Backpacks & Carriers" category whose entire axis is inch/letter
    // sizes, no colour option at all, so a colour-derived guess can NEVER
    // match here no matter how many times it's redrafted). Unlike
    // resolveVariantRowVariation's block, THIS value was never typed by a
    // seller — it's the automatic colour fallback for a zero-variant
    // product — so there's no seller-facing dropdown to send them to fix
    // it in; holding the push here just repeats the identical block on
    // every redraft. Only takes this path when the category actually
    // offers "..." as one of its own options; otherwise still holds the
    // push, since there is nothing safe to send.
    if (allowed.includes("...")) {
      noteSink?.push(`variation "${trimmed}" isn't one of this category's stocked options — sent as "..." instead`);
      return "...";
    }
    const shown = allowed.length > 8
      ? `${allowed.slice(0, 8).join(", ")}, and ${allowed.length - 8} more`
      : allowed.join(", ");
    blockers?.push(
      `Variation "${trimmed}" isn't one of this category's stocked options (${shown}) — pick one of those, or use the editor if you genuinely stock a new one.`,
    );
  }

  return snapped;
}

/**
 * A variant ROW's own typed `variation` value. Deliberately does NOT apply
 * isSingleColour's broad separator check — a variant's variation label is
 * routinely a composite of several DIFFERENT attributes joined by "/"
 * ("8GB / 128GB / Navy"), which isSingleColour misreads as a list of
 * alternatives for one attribute and would wrongly discard.
 *
 * Only refuses a value when it can PROVE it's several stocked options
 * joined into one: every comma-separated part matches one of the axis's
 * own allowed values. Real rejection this closes: "Attribute [color_family]
 * with invalid value [Yellow,Red,Orange,White,Blue]" — five distinct,
 * individually-valid colours sent as one string.
 *
 * When the axis DOES declare allowed values and the typed one is neither
 * an exact/near match NOR provably a joined list, this now HOLDS the push
 * (via `blockers`) rather than shipping the unmatched value as typed. Real
 * rejection this closes, live and repeated: "Attribute [variation] with
 * invalid value [Navy Blue]" — "Navy Blue" was never in the category's own
 * colour list, and "Fix & resubmit" kept redrafting and resubmitting the
 * identical value because nothing local ever checked it against the axis.
 * Naming the actual stocked options up front is strictly more useful to
 * the seller than a rejection Jumia won't explain further.
 */
function resolveVariantRowVariation(
  raw:         string,
  fallback:    string,
  variantAxes: JumiaCategoryAttribute[],
  noteSink?:   string[],
  blockers?:   string[],
): string {
  const trimmed = raw.trim();
  if (!trimmed) return fallback;

  const allowed = variantAxes.flatMap((a) => a.allowed_values ?? []);
  if (allowed.length > 0) {
    const parts = trimmed.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1 && parts.every((p) => allowed.some((a) => a.toLowerCase() === p.toLowerCase()))) {
      noteSink?.push(
        `"${trimmed}" lists more than one stocked option — Jumia's variation is a single value, so it went as "${fallback}"; split them into separate variants`,
      );
      return fallback;
    }
  }

  const snapped = snapVariationSpelling(trimmed, allowed, noteSink);

  // snapVariationSpelling only changes the value when it found a match —
  // an unchanged result plus "not literally in the allowed list" means
  // nothing matched at all (as opposed to already being a correct,
  // unchanged value).
  if (
    allowed.length > 0 &&
    snapped === trimmed &&
    !allowed.some((a) => a.toLowerCase() === trimmed.toLowerCase())
  ) {
    const shown = allowed.length > 8
      ? `${allowed.slice(0, 8).join(", ")}, and ${allowed.length - 8} more`
      : allowed.join(", ");
    blockers?.push(
      `Variation "${trimmed}" isn't one of this category's stocked options (${shown}) — pick one of those, or use the editor if you genuinely stock a new one.`,
    );
  }

  return snapped;
}

/**
 * Reconcile an AI-drafted variant's variation LABEL against the category's
 * own variant axis, at DRAFT time — before it ever reaches a push.
 *
 * The "Describe" pass (lib/actions/ai.ts) invents variation labels ("13.3
 * inch", "Silver") purely from what's visible in the photos, before the
 * category — and therefore its variant-axis schema — is even resolved. A
 * category whose axis is a closed list (screen sizes, shoe lengths) can
 * reject ANY value that isn't literally one of its own options, no matter
 * how it's spelled — the exact failure resolveVariantRowVariation already
 * guards against at push time, just too late to avoid a rejection round
 * trip and a confusing edit for the seller.
 *
 * Real Jumia behaviour, confirmed live in Vendor Center for exactly this
 * shape of category: its own Variation dropdown offers "..." as a
 * selectable, accepted placeholder alongside the real options — a seller
 * unsure which one applies can defer the choice rather than being forced
 * to guess. Mirroring that convention here means a draft that can't be
 * confidently placed in the category's own list still lands editable and
 * pushable, instead of shipping a free-text guess Jumia will reject.
 *
 * - No axis restriction at all (allowed_values empty) → the AI's label is
 *   kept exactly as drafted; free text is genuinely fine here.
 * - The label matches one of the axis's own options (exactly, or after the
 *   same casing/plural/spelling-synonym snap resolveVariantRowVariation
 *   already applies) → snapped to the category's own spelling.
 *   Otherwise → "..." rather than the AI's unmatched guess.
 */
export function reconcileDraftVariation(
  rawLabel:    string,
  variantAxes: JumiaCategoryAttribute[],
): string {
  const trimmed = rawLabel.trim();
  if (!trimmed) return trimmed;

  const allowed = variantAxes.flatMap((a) => a.allowed_values ?? []);
  if (allowed.length === 0) return trimmed;

  const snapped = snapVariationSpelling(trimmed, allowed);
  const matched = snapped !== trimmed || allowed.some((a) => a.toLowerCase() === trimmed.toLowerCase());
  if (matched) return snapped;

  console.info(`[Jumia draft-variation] "${trimmed}" isn't one of this category's stocked options — drafted as "..." instead`);
  return "...";
}

/**
 * The exact three-part rule Jumia enforces on salePrice: value AND both
 * dates present together, end date not already past, start before end, sale
 * price below the regular price. `JSON.stringify` silently drops `undefined`
 * keys, so a payload built with `startAt: listing.sale_start_date ??
 * undefined` and no end date used to ship as `{"value": X}` — Jumia's own
 * rejection for that shape: "Attribute [Product.Price.SalePrice.StartAt]
 * with invalid value [null]." Returning undefined here omits the whole
 * `salePrice` key rather than ever sending a partial one.
 */
function buildSalePriceField(
  value:        number | null | undefined,
  startAt:      string | null | undefined,
  endAt:        string | null | undefined,
  sellingPrice: number | null | undefined,
  noteSink?:    string[],
): { value: number; startAt: string; endAt: string } | undefined {
  if (value == null) return undefined;

  if (!startAt || !endAt) {
    noteSink?.push(`sale price ${value} wasn't sent — Jumia requires both a start and end date and only the price was set; add the dates and resubmit`);
    return undefined;
  }

  const start = new Date(startAt);
  const end   = new Date(endAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    noteSink?.push(`sale price ${value} wasn't sent — its start/end date didn't parse as a date`);
    return undefined;
  }
  if (end.getTime() <= Date.now()) {
    noteSink?.push(`sale price ${value} wasn't sent — its end date is already in the past`);
    return undefined;
  }
  if (start.getTime() >= end.getTime()) {
    noteSink?.push(`sale price ${value} wasn't sent — its start date isn't before its end date`);
    return undefined;
  }
  if (sellingPrice != null && value >= sellingPrice) {
    noteSink?.push(`sale price ${value} wasn't sent — it isn't lower than the regular price (${sellingPrice})`);
    return undefined;
  }

  return { value, startAt, endAt };
}

export type JumiaProduct = ReturnType<typeof buildBaseProduct>;

function buildBaseProduct(
  listing: ListingRow,
  brand: { code: number; name: string },
  currency: string,
  schema: JumiaCategoryAttribute[] = [],
  noteSink?: string[],
  variantAxes: JumiaCategoryAttribute[] = [],
  blockers?: string[],
  preflightNoteSink?: PreflightNote[],
) {
  const category   = resolveCategoryCode(listing);
  const images     = (listing.images ?? [])
    .filter(Boolean)
    .map((url, i) => ({ url, primary: i === 0 }));

  // Push-time brand-in-title safety net.
  //
  // Jumia rejects any listing whose title contains the resolved brand
  // name ("Product name contains Brand name [X]"). This catches the
  // edge case where the title was OK against whatever brand the AI
  // returned, but the seller manually picked a different brand later
  // (e.g. AI saw no logo → brand "Generic"; seller picked "Orium"
  // because they know what it is; but title was already "ORIUM
  // OR-1003 Electric Rice Cooker"). Strip against the CURRENT push
  // brand here so the push always satisfies the rule, regardless of
  // when the brand was set.
  const rawTitle      = listing.title ?? "";
  const cleanedTitle  = stripBrandFromTitle(rawTitle, brand.name);
  if (cleanedTitle !== rawTitle.trim() && brand.name.toLowerCase() !== "generic") {
    console.info(
      `[jumia push] stripped brand "${brand.name}" from title — was "${rawTitle.trim()}", now "${cleanedTitle}".`,
    );
    // Jumia rejects a title repeating the brand, so stripping it is
    // required — but the seller kept seeing their own title in the editor
    // and never learnt that a different one went out. Required is not the
    // same as invisible.
    noteSink?.push(`the brand "${brand.name}" was removed from the title — Jumia rejects titles that repeat it, so it went as "${cleanedTitle}"`);
  }
  const safeTitle = cleanedTitle || rawTitle.trim();

  // Jumia requires `variation` to be non-empty even for products without
  // variants. Their error: "The variation 'variation' value has to be
  // filled in order to create a Product."
  //
  // This is the base product's OWN variation — used as-is only when the
  // listing has zero variant rows (a genuinely simple, single-SKU
  // product). Every listing defaults to "..." here (see
  // resolveDefaultVariation) — the same one-SKU-unless-stated default the
  // "Describe" pass now applies to whether it drafts variant rows at all
  // (lib/actions/ai.ts) — no matter what colour the AI thinks it sees in
  // the photos, or what category this is. `color`/`color_family` only
  // drive this value when the SELLER stated it themselves: a note like
  // "the colour is navy" gets verified and written back with
  // field_confidence.color.source === "seller-required" (see
  // auto-analyze.ts's note-intent/note-assertion handling), which is the
  // one signal here that distinguishes an actual seller statement from an
  // AI guess at what's in the photo. An AI-guessed colour used to drive
  // this unconditionally, which routinely produced a specific-sounding
  // variation ("Blue") the seller never confirmed they stock in exactly
  // that shade — and, when the category's variant axis was something else
  // entirely (sizes, lengths), a guaranteed rejection (see
  // resolveColorFallbackVariation's doc comment).
  //
  // This must NOT be reused as the fallback for a VARIANT that's missing
  // its own typed variation (see mapListingToJumiaProducts below) — that
  // path keeps a hardcoded "Default" literal on purpose: sharing this
  // colour string across multiple variants of the same parent used to
  // silently mask seller mistakes and made several variants collide on
  // the same value when colour was combined (e.g. "black and green"),
  // which Jumia dedup-rejected. The push route validates upstream (empty
  // variation → 422) so the seller is told to type a label instead.
  const sellerStatedColor = listing.field_confidence?.color?.source === "seller-required"
    ? (listing.color ?? "").trim()
    : "";
  const defaultVariation = sellerStatedColor
    ? resolveColorFallbackVariation(sellerStatedColor, variantAxes, noteSink, blockers)
    : resolveDefaultVariation(variantAxes, blockers);

  // Match Jumia Postman spec exactly:
  //   POST /feeds/products/create
  //   { name: {value, translations[]}, description: {value, translations[]},
  //     parentSku, sellerSku, variation, brand: {code, name}, category: {code, name},
  //     images: [{url, primary}], price: {value, currency, salePrice?},
  //     stock, attributes: [{name, value, translations[]}],
  //     barcodeEan, additionalCategories: [{code, name}] }
  // Note on barcode field name: Jumia's docs disagree with themselves.
  // - The schema reference (PDF page 4) uses `gtinBarcode`
  // - The Postman request sample uses `barcodeEan`
  // - Live API accepts `barcodeEan`
  // We send BOTH so we're safe regardless of which the live endpoint
  // actually validates. Unknown fields are ignored by Jumia.
  return {
    name:        t(safeTitle),
    description: t(listing.description ?? ""),
    parentSku:   listing.sku,
    sellerSku:   listing.sku,
    variation:   defaultVariation,
    brand,
    category,
    images,
    price: {
      value:    listing.selling_price ?? 0,
      currency,
      // A listing-level sale price (see migration
      // 2026-09-13_listing-sale-price.sql) — the only sale price a
      // genuinely simple, zero-variant product can carry, since there's
      // no variant row for one to live on. mapListingToJumiaProducts's
      // per-variant path below falls back to this same listing-level
      // value too, so a sale price set once applies no matter the
      // variant. buildSalePriceField omits the key entirely unless value
      // AND both dates are present and valid — see its doc comment.
      ...(() => {
        const salePrice = buildSalePriceField(
          listing.sale_price, listing.sale_start_date, listing.sale_end_date,
          listing.selling_price, noteSink,
        );
        return salePrice ? { salePrice } : {};
      })(),
    },
    stock:       listing.quantity ?? 1,
    attributes:  buildAttributes(listing, schema, noteSink, preflightNoteSink),
    barcodeEan:  "",
    gtinBarcode: "",      // schema reference uses this name; harmless duplicate
    // additionalCategories: DEPRECATED per official spec (PDF page 5).
    // Do not send.
  };
}

/**
 * Map a listing + variants → array of Jumia product objects.
 * Pass the resolved brand (from resolveBrand()) to avoid duplicate API calls.
 */
export function mapListingToJumiaProducts(
  listing:  ListingRow,
  variants: VariantRow[],
  brand:    { code: number; name: string },
  currency: string = "GHS",
  // Optional — when given, universal/dynamic attribute values that aren't
  // one of this category's own allowed_values get dropped/trimmed before
  // ever reaching Jumia (see lib/jumia/preflight.ts). Omitted by callers
  // that don't have it handy (scripts, tests) — attributes pass through
  // unchecked in that case, same as before this existed.
  categoryAttributeSchema: JumiaCategoryAttribute[] = [],
  /** Optional sink for changes made on the way out — see buildAttributes. */
  noteSink?: string[],
  /** Optional — the category's own is_variant attribute set (see
   *  getVariantAxes), used to snap a variation value to its declared
   *  spelling and refuse a multi-value string as one SELECTION. Omitted by
   *  callers that don't have it handy — variation values pass through with
   *  only the isSingleColour check, same as before this existed. */
  variantAxes: JumiaCategoryAttribute[] = [],
  /** Optional sink for reasons the push must be HELD rather than sent —
   *  see resolveVariantRowVariation. Unlike noteSink, a non-empty blockers
   *  array means the caller must not push the resulting products. */
  blockers?: string[],
  /** See buildAttributes — raw preflight notes for a caller that needs to
   *  tell a merely-dropped attribute apart from one that would have sunk
   *  the whole push. */
  preflightNoteSink?: PreflightNote[],
): JumiaProduct[] {
  // blockers only when base.variation will actually ship: with real
  // variant rows present, base is built (for its other shared fields) but
  // its OWN variation is deliberately discarded below in favour of each
  // variant's typed value — blocking on it here would hold a push over a
  // colour fallback nothing ever sends.
  const base = buildBaseProduct(
    listing, brand, currency, categoryAttributeSchema, noteSink, variantAxes,
    variants.length ? undefined : blockers, preflightNoteSink,
  );

  if (!variants.length) {
    // No persisted variants → one product entry using the listing's own
    // SKU. base.variation uses the colour fallback (see buildBaseProduct).
    // Log so we can tell when this path fires unexpectedly (e.g. when the
    // seller TYPED a variation but it didn't make it into the variants
    // table for some reason).
    console.info(
      `[Jumia mapping] No variant rows — sending 1 product, ` +
      `parentSku=${base.parentSku}, variation=${JSON.stringify(base.variation)} (from base fallback)`,
    );
    return [base];
  }

  // With variants: one entry per variant; ALL share the same parentSku so
  // Jumia treats them as variants of a single parent product (not separate
  // listings). `variation` must be a non-empty descriptive string AND
  // unique within the parent. Two layers carry it:
  //
  //   1. The top-level `variation` field on the product object.
  //   2. The `variation` entry inside the `attributes` array — Jumia's
  //      uniqueness check on (parentSku, variation) actually reads from
  //      THIS, not the top-level field. So when listing.dynamic_attributes
  //      contains a single shared "variation" value (e.g. seller filled
  //      the schema's required "Variation" field with the overall name),
  //      Jumia sees every variant carrying the SAME attribute value and
  //      dedup-rejects all but one.
  //
  // We strip the shared "variation" out of buildAttributes (above) and
  // inject the per-variant value here, so each product's attributes
  // array carries its own unique label.
  //
  // BUT the literal name "variation" is only Jumia's linking field, not
  // necessarily its dedup key: PER_VARIANT_ATTRIBUTE_NAMES (lib/jumia/api.ts)
  // only ever treats "variation" as per-variant, yet a category's REAL
  // is_variant attribute is very often named something else entirely —
  // "size" for clothing/shoes, "capacity" for appliances, etc. (getVariantAxes
  // is what actually resolves the category's true axis). Confirmed live,
  // 2026-09-23 (category 1013693, sandals): the axis is named "size", not
  // "variation" — this category's schema has no "variation" attribute at
  // all. Real payload sent for parentSku PA-MUDIF5R5's 4 variants, size
  // values 40/41/42/43: the STATIC listing-level `size` attribute (cloned
  // from base.attributes below) stayed at one value across all four, since
  // the letter-size-only regex this used to be scoped to (XS/S/M/L/XL/…)
  // never matches a numeric shoe size — so Jumia saw four variants all
  // claiming the same size and rejected three of them as duplicates,
  // "Duplicate Variation ... and variation [42]".
  //
  // The general fix: use variantAxes (the category's own real schema, not
  // a guessed value-shape pattern) to find which attribute(s) the category
  // ACTUALLY declares as its variant axis, and always overwrite those with
  // this variant's own resolved value — whatever that axis is named and
  // whatever shape its values take.
  const variantAxisNames = new Set(variantAxes.map((a) => a.name.toLowerCase()));
  const products = variants.map((v) => {
    // Deliberately NOT base.variation here — base.variation may now be a
    // detected colour (see buildBaseProduct), and sharing that across
    // multiple variants missing their own typed value would silently
    // collide/dedup-reject exactly the way this fallback used to. Keep a
    // fixed literal instead; a real missing-variation case should surface
    // as this warning, not a plausible-looking colour string.
    const rawVariation = v.variation?.trim() || MISSING_VARIANT_VARIATION;
    if (!v.variation?.trim()) {
      console.warn(
        `[Jumia mapping] Variant ${v.id} has no variation — falling back to ` +
        `${JSON.stringify(MISSING_VARIANT_VARIATION)}. ` +
        `This shouldn't happen if the seller typed a value — investigate the save path.`,
      );
    }
    // Axis-spelling discipline for a variant's own typed value — see
    // resolveVariantRowVariation's doc comment on why this is intentionally
    // less aggressive than the base product's colour-only fallback above.
    const variation = resolveVariantRowVariation(rawVariation, MISSING_VARIANT_VARIATION, variantAxes, noteSink, blockers);
    return {
      ...base,
      sellerSku:  v.seller_sku ?? `${listing.sku}-${v.id.slice(0, 4)}`,
      parentSku:  listing.sku,
      variation,
      barcodeEan: v.gtin ?? "",
      price: {
        value:     v.global_price ?? listing.selling_price ?? 0,
        currency,
        // Falls back to the listing-level sale price/dates when this
        // variant has none of its own — same "set once, applies no
        // matter the variant" fallback global_price already gets from
        // selling_price above. A variant that WAS given its own sale
        // price (e.g. via the web editor) still overrides it.
        // buildSalePriceField omits the key entirely unless value AND both
        // dates are present and valid — see its doc comment.
        ...(() => {
          const salePrice = buildSalePriceField(
            v.sale_price       ?? listing.sale_price,
            v.sale_start_date  ?? listing.sale_start_date,
            v.sale_end_date    ?? listing.sale_end_date,
            v.global_price     ?? listing.selling_price,
            noteSink,
          );
          return salePrice ? { salePrice } : {};
        })(),
      },
      stock: v.quantity ?? 1,
      // Per-variant attributes: clone the listing-level attributes and
      // prepend a unique `variation` entry. Listing-level attributes
      // already had "variation" stripped in buildAttributes.
      //
      // Overwrite every attribute the category's OWN schema declares as
      // its variant axis (variantAxisNames, above) so it matches THIS
      // variant — not just an attribute literally named "size" holding a
      // clothing letter size. A numeric shoe size, a capacity, or any
      // other axis name gets the identical per-variant treatment, since
      // the thing that makes an attribute "the variant axis" is the
      // category's own schema (is_variant: true), never the shape of the
      // value itself.
      attributes: [
        { name: "variation", value: variation, translations: [] as never[] },
        ...base.attributes.map((a) => {
          if (!variantAxisNames.has(a.name.toLowerCase())) return a;
          return { ...a, value: variation };
        }),
      ],
    };
  });

  // Summary log: confirms what Jumia receives so we can diff against what
  // the seller saw on screen.
  const summary = products.map((p) => ({
    parentSku: p.parentSku,
    sellerSku: p.sellerSku,
    variation: p.variation,
    stock:     p.stock,
    price:     p.price.value,
  }));
  console.info(
    `[Jumia mapping] Sending ${products.length} variant(s) under parentSku=${listing.sku}:`,
    JSON.stringify(summary),
  );

  return products;
}

// ─── Jumia API call ───────────────────────────────────────────────────────────

/**
 * Schema-required attributes that no product in the feed carries a value
 * for, by their human labels ("Weight (kg)"), for a message a seller can
 * act on.
 *
 * Reads the FINAL payload rather than the listing, so it sees exactly
 * what Jumia will see — after the pre-flight has dropped, snapped and
 * trimmed, and after each variant's own `variation` has been injected.
 * Checking the listing instead would be checking a different thing from
 * the one being sent, which is how the gap this closes opened in the
 * first place.
 *
 * An empty schema means the fetch failed, not that the category declares
 * nothing — it blocks nothing, exactly as the pre-flight doesn't.
 */
function missingRequiredFor(
  products: ReturnType<typeof mapListingToJumiaProducts>,
  schema:   JumiaCategoryAttribute[],
): JumiaCategoryAttribute[] {
  if (schema.length === 0 || products.length === 0) return [];

  const carried = new Set(CARRIED_OUTSIDE_ATTRIBUTES.map((n) => n.toLowerCase()));
  const present = new Set<string>();
  for (const product of products) {
    for (const attr of product.attributes) {
      if (String(attr.value ?? "").trim() !== "") present.add(attr.name.toLowerCase());
    }
  }

  return schema.filter((f) => f.required
    && !present.has(f.name.toLowerCase())
    && !carried.has(f.name.toLowerCase()));
}

/**
 * Turn the pre-flight's notes into sentences a seller can act on.
 *
 * Only what the seller can actually act on, which is a narrower set than
 * "everything that changed":
 *
 *   snapped_enum   a spelling correction to the exact string Jumia
 *                  accepts. The value survives; only its casing moved.
 *   line_breaks    a formatting equivalence — a <br> renders as the line
 *                  the seller typed.
 *   not_in_schema  the field is not in this category's schema, so the
 *                  editor never rendered it either. Nothing the seller
 *                  can see changed, and this one is the reason the filter
 *                  exists at all: the payload sprays a fixed set of
 *                  universal fields (colour, warranty, country, product
 *                  line...) at every listing, so a category declaring
 *                  none of them produces TWENTY of these on a perfectly
 *                  good push. A list that long on every submit is a list
 *                  sellers learn to scroll past, which would cost the two
 *                  below their only chance of being read.
 *
 * What is left is content the seller CAN see in the editor and that Jumia
 * did not receive as written.
 */
function describeAdjustments(notes: PreflightNote[]): string[] {
  const out: string[] = [];
  for (const n of notes) {
    if (n.reason === "invalid_enum") {
      out.push(`${n.label}: ${n.detail}, so it wasn't sent`);
    } else if (n.reason === "truncated") {
      out.push(`${n.label} was ${n.detail}`);
    } else if (n.reason === "decimal_mismatch_blocked") {
      out.push(`${n.label}: ${n.detail}`);
    }
  }
  return out;
}

export interface JumiaPushResult {
  success:   boolean;
  jumia_ref: string | null;  // feedId — poll GET /feeds/{id} for status
  raw:       unknown;
  error?:    string;
  /**
   * Set when the payload was refused locally and NOTHING was sent to
   * Jumia. The caller must not record this as a Jumia rejection — no feed
   * exists, the listing was never submitted, and the seller can fix the
   * named fields and submit normally.
   */
  blocked?:  "missing_required";
  /** Schema-required attribute labels that were empty, for the message. */
  missing?:  string[];
  /**
   * What the pre-flight CHANGED on the way out, in the seller's terms.
   *
   * These repairs were always happening and were only ever written to a
   * log line. That means a seller could type a value, submit, and have
   * something else reach Jumia with no way to find out — a colour snapped
   * to the schema's spelling, an attribute dropped because the category
   * doesn't declare it, a description trimmed to a length cap. Reporting
   * them is the difference between a system that corrects you and one
   * that corrects you behind your back.
   */
  adjustments?: string[];
}

/** Exactly what a push would send, without sending it. */
export interface JumiaPayloadBuild {
  products:        JumiaProduct[];
  /** Phrased for a seller — see describeAdjustments. */
  adjustments:     string[];
  /** Schema-required attribute labels with no value, by their Jumia label. */
  missingRequired: string[];
  /** The same fields as schema entries, for asking the seller for them
   *  (askForNextMissingValue in lib/whatsapp/intake.ts). */
  missingRequiredAttributes: JumiaCategoryAttribute[];
  /** Set when the payload could not be built at all (no valid category). */
  error?:          string;
  /** Every preflight note, RAW (with its .reason tag) rather than
   *  stringified — a caller deciding Ready vs Held (assessListingPushReadiness,
   *  lib/whatsapp/readiness.ts) needs to tell "dropped but harmless"
   *  (truncated, snapped_enum, rounded_number) apart from "dropped, and
   *  the real push would have failed over it" (decimal_mismatch_blocked,
   *  invalid_enum, invalid_number) — `adjustments` alone can't make that
   *  distinction once it's been turned into prose. */
  preflightNotes:  PreflightNote[];
}

/**
 * Build the feed payload — the whole of a push except the POST.
 *
 * Extracted so a PREVIEW can show the seller the real thing rather than a
 * reconstruction. Two code paths producing "what Jumia gets" would drift,
 * and a preview that drifts is worse than none: it would be believed.
 * pushProductsToJumia calls this and then sends the result, so what the
 * preview renders and what Jumia receives are the same object by
 * construction.
 */
export async function buildJumiaPayload(
  accessToken: string,
  listing:     ListingRow,
  variants:    VariantRow[],
  currency:    string = "GHS",
  countryCode: string = DEFAULT_JUMIA_COUNTRY,
): Promise<JumiaPayloadBuild> {
  const brand = await resolveBrand(accessToken, listing.brand, listing.category_path);

  // Cheap local DB reads, no Jumia call — see the note in the push below.
  let schema: JumiaCategoryAttribute[] = [];
  let variantAxes: JumiaCategoryAttribute[] = [];
  let categoryResolved = false;
  let resolvedCode = 0;
  try {
    const { code } = resolveCategoryCode(listing);
    categoryResolved = true;
    resolvedCode = code;
    [schema, variantAxes] = await Promise.all([
      getCategoryAttributes(code),
      getVariantAxes(code),
    ]);
  } catch {
    // No valid category — mapListingToJumiaProducts reports it properly.
  }

  // A cache miss here doesn't mean this category is broken — it means
  // NOBODY has ever pushed to it before (getCategoryAttributes is a pure
  // cache read; nothing populates it in the background). Confirmed live,
  // 2026-09-20: three products in one batch failed here purely because
  // their categories (Drilling Hammers, Moisturizers, Standing Fans) had
  // never been selected by any listing before, while the auto-analyze
  // pipeline's OWN on-demand fetch-and-cache (lib/actions/auto-analyze.ts)
  // had no access token to use at draft time — the seller's Jumia
  // connection was mid-reconnect that same session. One live fetch here,
  // same as auto-analyze already does, means a category doesn't have to
  // wait for the seller to notice and manually re-pick it.
  if (categoryResolved && schema.length === 0 && resolvedCode) {
    try {
      const catRow = await getCategoryByCode(resolvedCode);
      if (catRow?.attribute_set_sid) {
        const fresh = await fetchAttributesFromJumia(accessToken, catRow.attribute_set_sid);
        if (fresh.length > 0) {
          await upsertAttributes(resolvedCode, fresh);
          schema = fresh;
          variantAxes = fresh.filter((a) => a.is_variant);
        }
      }
    } catch (e) {
      console.warn(`[Jumia push] on-demand schema fetch failed for category ${resolvedCode}: ${(e as Error).message}`);
    }
  }

  // Fail closed rather than pass every attribute through unchecked.
  // preflightAttributes treats schema.length===0 as "we never successfully
  // fetched one" and deliberately doesn't drop anything in that case — the
  // right call for a validator that must never cost a seller an attribute
  // Jumia would have accepted. But that same leniency is wrong at the PUSH
  // boundary: a category we resolved a code for but have no cached schema
  // for means every enum, decimal-places and required check below is
  // skipped, and real rejections happened exactly this way in production —
  // "Attribute [color_family] with invalid value [Yellow,Red,Orange,White,
  // Blue]" went out unvalidated because this category's schema hadn't
  // synced. Refusing to push is recoverable (the seller waits for the sync
  // or nudges it); shipping unvalidated attributes and letting Jumia
  // discover the problem is not — it costs the whole feed. Reached only
  // when the on-demand fetch just above also came up empty (e.g. Jumia
  // itself is unreachable right now).
  if (categoryResolved && schema.length === 0) {
    return {
      products: [], adjustments: [], missingRequired: [], missingRequiredAttributes: [], preflightNotes: [],
      error: "JUMIA_NO_SCHEMA: This category's attribute list hasn't synced yet, so nothing can be validated before sending — try again in a moment, or open the category picker to re-select it and force a re-sync.",
    };
  }

  const adjustments: string[] = [];
  const blockers: string[] = [];
  const preflightNotes: PreflightNote[] = [];
  try {
    const products = mapListingToJumiaProducts(listing, variants, brand, currency, schema, adjustments, variantAxes, blockers, preflightNotes);

    // A variant's own typed value that isn't one of the category's stocked
    // options (see resolveVariantRowVariation) — checked before the
    // content gate below since it's about the payload not being buildable
    // as typed at all, the same class of problem an empty schema is.
    if (blockers.length > 0) {
      return { products: [], adjustments, missingRequired: [], missingRequiredAttributes: [], preflightNotes, error: blockers.join(" ") };
    }

    // Last-mile content gate — restricted words plus the prohibited-
    // category/restricted-brand catalog, run right before anything is
    // POSTed. See lib/jumia/listing-ready.ts.
    await loadLearnedRestrictedWords();
    const ready = assertListingReady(listing, countryCode, products);
    adjustments.push(...ready.warnings);
    if (!ready.ok) {
      return { products: [], adjustments, missingRequired: [], missingRequiredAttributes: [], preflightNotes, error: ready.blockers.join(" ") };
    }

    const missing = missingRequiredFor(products, schema);
    return { products, adjustments, missingRequired: missing.map((f) => f.label || f.name), missingRequiredAttributes: missing, preflightNotes };
  } catch (e) {
    return {
      products: [], adjustments, missingRequired: [], missingRequiredAttributes: [], preflightNotes,
      error: (e as Error).message ?? "Failed to build payload",
    };
  }
}

/**
 * POST https://vendor-api.jumia.com/feeds/products/create
 *
 * Resolves brand code via Catalog API first, then submits.
 * Returns feedId on 200/201 — product ingestion is async.
 */
export async function pushProductsToJumia(
  accessToken: string,
  shopId:      string,
  listing:     ListingRow,
  variants:    VariantRow[],
  currency:    string = "GHS",
  countryCode: string = DEFAULT_JUMIA_COUNTRY,
): Promise<JumiaPushResult> {
  const built = await buildJumiaPayload(accessToken, listing, variants, currency, countryCode);
  if (built.error) {
    return { success: false, jumia_ref: null, raw: null, error: built.error };
  }
  const products        = built.products;
  const preflightNotes  = built.adjustments;
  const missingRequired = built.missingRequired;

  // Refuse a payload the category schema already says Jumia will reject.
  // Jumia bins the ENTIRE feed over one missing required attribute ("The
  // column [product_weight] is missing from the file"), so sending it
  // costs the seller the product, a round trip, and a listing left at
  // "failed" for a problem visible before the request left the building.
  if (missingRequired.length > 0) {
    const labels = missingRequired.join(", ");
    console.warn(`[Jumia API] ⛔ not sending — category requires ${labels}`);
    return {
      success:   false,
      jumia_ref: null,
      raw:       null,
      blocked:   "missing_required",
      missing:   missingRequired,
      error:     `This category requires ${labels}. Jumia rejects the whole listing without ${missingRequired.length === 1 ? "it" : "them"}, so nothing was submitted — add ${missingRequired.length === 1 ? "it" : "them"} and submit again.`,
    };
  }

  const url  = `${JUMIA_API_BASE}/feeds/products/create`;
  const body = JSON.stringify({ shopId, products });

  console.info(`[Jumia API] POST ${url} — shopId=${shopId}, products=${products.length}, brand=${JSON.stringify(products[0]?.brand)}`);
  console.info("[Jumia API] Payload:", body.slice(0, 500));

  let res: Response;
  try {
    res = await fetch(url, {
      method:  "POST",
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept:         "application/json",
      },
      body,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Network error";
    console.error("[Jumia API] Network error:", e);
    return { success: false, jumia_ref: null, raw: null, error: msg };
  }

  const contentType = res.headers.get("content-type") ?? "";
  console.info(`[Jumia API] Response: ${res.status} (${contentType.split(";")[0].trim()})`);

  const raw: unknown = contentType.includes("application/json")
    ? await res.json().catch(() => null)
    : await res.text().catch(() => null);

  console.info("[Jumia API] Body:", JSON.stringify(raw)?.slice(0, 600));

  if (res.ok) {
    const feedId = extractFeedId(raw);
    console.info("[Jumia API] ✅ Feed created, feedId:", feedId);
    return { success: true, jumia_ref: feedId, raw, adjustments: preflightNotes };
  }

  const errorMsg = extractError(raw, res.status);
  console.error("[Jumia API] ❌ Error:", res.status, raw);
  return { success: false, jumia_ref: null, raw, error: errorMsg, adjustments: preflightNotes };
}

/**
 * POST /feeds/products/update
 *
 * Same payload shape as pushProductsToJumia, but per Jumia API docs each
 * product MUST include the `id` field (productSid) returned from the original
 * create-feed response. Without `id`, Jumia rejects the update.
 *
 * Also: products are only updateable once their qc.status === "approved".
 * Caller (the update route) is responsible for checking that gate before
 * invoking this function.
 *
 * Returns a new feedId; poll GET /feeds/{id} for completion.
 */
export async function updateProductOnJumia(
  accessToken: string,
  shopId:      string,
  listing:     ListingRow,
  variants:    VariantRow[],
  currency:    string = "GHS"
): Promise<JumiaPushResult> {
  if (!listing.jumia_product_sid && !listing.jumia_product_map) {
    return {
      success: false, jumia_ref: null, raw: null,
      error: "JUMIA_NO_PRODUCT_SID: Product hasn't been QC-approved yet. Updates are only allowed after Jumia approves the initial listing.",
    };
  }
  if (listing.jumia_qc_status && listing.jumia_qc_status !== "approved") {
    return {
      success: false, jumia_ref: null, raw: null,
      error: `JUMIA_QC_NOT_APPROVED: Product qc.status is "${listing.jumia_qc_status}". Only QC-approved products allow updates.`,
    };
  }

  const brand = await resolveBrand(accessToken, listing.brand, listing.category_path);

  let categoryAttributeSchema: JumiaCategoryAttribute[] = [];
  let variantAxes: JumiaCategoryAttribute[] = [];
  try {
    const { code } = resolveCategoryCode(listing);
    [categoryAttributeSchema, variantAxes] = await Promise.all([
      getCategoryAttributes(code),
      getVariantAxes(code),
    ]);
  } catch {
    // No valid category — mapListingToJumiaProducts reports this properly.
  }

  let basePayload: ReturnType<typeof mapListingToJumiaProducts>;
  try {
    basePayload = mapListingToJumiaProducts(listing, variants, brand, currency, categoryAttributeSchema, undefined, variantAxes);
  } catch (e) {
    const msg = (e as Error).message ?? "Failed to build update payload";
    return { success: false, jumia_ref: null, raw: null, error: msg };
  }
  const products = basePayload
    .map((p) => {
      // Inject the productSid required by /feeds/products/update.
      // For multi-variant listings, look up the SID from the saved map.
      let sid: string | null = null;
      if (variants.length > 1 && listing.jumia_product_map) {
        sid = listing.jumia_product_map[p.sellerSku]?.sid ?? null;
      } else {
        sid = listing.jumia_product_sid ?? null;
      }
      if (!sid) return null;
      return { id: sid, ...p };
    })
    .filter(Boolean) as Array<{ id: string } & ReturnType<typeof buildBaseProduct>>;

  if (products.length === 0) {
    return {
      success: false, jumia_ref: null, raw: null,
      error: "JUMIA_NO_PRODUCT_SID: No QC-approved products to update.",
    };
  }

  const url  = `${JUMIA_API_BASE}/feeds/products/update`;
  // The update endpoint per Postman spec does NOT include shopId — only products.
  const body = JSON.stringify({ products });

  console.info(`[Jumia API] POST ${url} — shopId=${shopId}, products=${products.length}`);

  let res: Response;
  try {
    res = await fetch(url, {
      method:  "POST",
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept:         "application/json",
      },
      body,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Network error";
    return { success: false, jumia_ref: null, raw: null, error: msg };
  }

  const contentType = res.headers.get("content-type") ?? "";
  const raw: unknown = contentType.includes("application/json")
    ? await res.json().catch(() => null)
    : await res.text().catch(() => null);

  console.info(`[Jumia API] Update response: ${res.status}`, JSON.stringify(raw)?.slice(0, 400));

  if (res.ok) {
    const feedId = extractFeedId(raw);
    return { success: true, jumia_ref: feedId, raw };
  }

  const errorMsg = extractError(raw, res.status);
  return { success: false, jumia_ref: null, raw, error: errorMsg };
}

// ─── Feed status polling ──────────────────────────────────────────────────────

export interface JumiaFeedStatus {
  status:  string;   // "DONE" | "PROCESSING" | "ERROR"
  total:   number;
  success: number;
  failed:  number;
  errors:  unknown[];
  raw:     unknown;
}

export async function getFeedStatus(
  accessToken: string,
  feedId:      string
): Promise<JumiaFeedStatus | null> {
  try {
    const res = await fetch(`${JUMIA_API_BASE}/feeds/${feedId}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (!res.ok) return null;
    const raw = await res.json() as Record<string, unknown>;

    // Jumia's actual response shape (per live data):
    //   { feedSid, status, feedType, feedSource, total, completed, failed,
    //     feedItems: [{ status, productSid, sellerSKU, errorMessage,
    //                   errors: { globalMessages: [], businessClients: [] } }] }
    // Older docs sometimes list `success` and `errors` at the top level —
    // accept both shapes.
    const feedItems = (raw.feedItems as Record<string, unknown>[] | undefined) ?? [];
    const failedItems = feedItems.filter((i) => String(i.status).toUpperCase() === "FAILED");

    // Collect every error message present anywhere in the response
    const errors: unknown[] = [];
    if (Array.isArray(raw.errors)) errors.push(...(raw.errors as unknown[]));
    for (const item of feedItems) {
      if (item.errorMessage) errors.push(item.errorMessage);
      const itemErrs = item.errors as Record<string, unknown> | undefined;
      if (itemErrs) {
        const global = (itemErrs.globalMessages as unknown[] | undefined) ?? [];
        errors.push(...global);
      }
    }

    return {
      status:  String(raw.status ?? "UNKNOWN").toUpperCase(),
      total:   Number(raw.total   ?? feedItems.length),
      success: Number(raw.success ?? raw.completed ?? (feedItems.length - failedItems.length)),
      failed:  Number(raw.failed  ?? failedItems.length),
      errors,
      raw,
    };
  } catch { return null; }
}

/**
 * Extract the productSid + qc.status from a feed's products payload.
 *
 * Per the Jumia API docs (Retrieve Feed Details):
 *   "To perform an update of newly created products, you need to get the
 *    products data at least once, from which you will get 2 valuable
 *    information: (1) the productSid needed for the update, (2) the qc.status
 *    i.e if your product is compliant with our listing guideline."
 *
 *   "you can only update the stock, price, status of products that have
 *    qc.status approved at least once."
 *
 * Returns null if the feed is still processing and doesn't yet have
 * productSid info, or if the feed contains no products.
 */
export interface FeedProductInfo {
  sellerSku:  string;
  productSid: string | null;   // null until QC has run
  qcStatus:   string | null;   // "approved" | "pending" | "rejected" | etc.
  errors:     string[];
}

export async function getFeedProductDetails(
  accessToken: string,
  feedId:      string
): Promise<FeedProductInfo[] | null> {
  try {
    const res = await fetch(`${JUMIA_API_BASE}/feeds/${feedId}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (!res.ok) return null;
    const raw = await res.json() as Record<string, unknown>;

    // Real Jumia response uses `feedItems`. Older docs / different feed types
    // use `products` or `items`. Accept whichever is present.
    const items = (
      raw.feedItems ?? raw.products ?? raw.items ?? []
    ) as Record<string, unknown>[];
    if (!Array.isArray(items)) return [];

    return items.map((p) => {
      const qc = (p.qc ?? {}) as Record<string, unknown>;
      // Sometimes productSid is a string like "Product Sid not found on the payload"
      // when QC hasn't run yet. Treat any non-UUID value as null.
      let sid = (p.productSid ?? p.product_sid ?? p.sid) as string | null ?? null;
      if (sid && !/^[0-9a-f-]{36}$/i.test(sid)) sid = null;

      // Collect every error message — top-level errorMessage + nested errors
      const errs: string[] = [];
      if (typeof p.errorMessage === "string") errs.push(p.errorMessage);
      const itemErrs = p.errors as Record<string, unknown> | unknown[] | undefined;
      if (Array.isArray(itemErrs)) {
        errs.push(...itemErrs.map((e) => typeof e === "string" ? e : JSON.stringify(e)));
      } else if (itemErrs && typeof itemErrs === "object") {
        const global = ((itemErrs as Record<string, unknown>).globalMessages as unknown[] | undefined) ?? [];
        errs.push(...global.map((e) => typeof e === "string" ? e : JSON.stringify(e)));
      }

      return {
        sellerSku:  String(p.sellerSku ?? p.sellerSKU ?? p.seller_sku ?? ""),
        productSid: sid,
        qcStatus:   (qc.status as string | undefined) ?? (String(p.status).toUpperCase() === "FAILED" ? "rejected" : null),
        errors:     errs,
      };
    });
  } catch {
    return null;
  }
}

/**
 * One product's quality-check result, from GET /catalog/products.
 *
 * A feed that finishes cleanly only means Jumia created the product; QC
 * reviews it afterwards and can still reject it (2026-09-30: "Wrong
 * Category" / "Category mismatch: AI suggests Grocery / Beverages / …").
 * The feed never reports that, this does. Per the API docs
 * (vendorcenter.jumia.com/api-docs, Retrieve Products), each variation
 * has a qc block per country it's sold in (businessClients[].qc):
 * status NOT_READY_TO_QC | PENDING | APPROVED | REJECTED, and on a
 * rejection a rejectionReason and rejectionComment.
 */
export interface ProductQc {
  sellerSku:  string;
  productSid: string | null;
  /** Uppercase as Jumia sends it; null when Jumia didn't say. */
  status:     string | null;
  reason:     string | null;
  comment:    string | null;
}

/**
 * QC for one seller SKU. `country` (the seller's, e.g. "GH") picks the
 * matching business client ("jumia-gh") when a product is sold in several.
 * Null when the product isn't found or the call fails; never throws.
 */
export async function getProductQc(
  accessToken: string,
  sellerSku:   string,
  country?:    string | null,
): Promise<ProductQc | null> {
  try {
    const res = await fetch(
      `${JUMIA_API_BASE}/catalog/products?sellerSku=${encodeURIComponent(sellerSku)}&size=10`,
      {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        signal:  AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      console.warn(`[jumia] product QC lookup for ${sellerSku}: HTTP ${res.status}`);
      return null;
    }
    const raw = await res.json() as { products?: Record<string, unknown>[] };
    const want = sellerSku.toLowerCase();
    for (const product of raw.products ?? []) {
      const variations = (product.variations ?? []) as Record<string, unknown>[];
      const variation = variations.find((v) => String(v.sellerSku ?? "").toLowerCase() === want);
      if (!variation) continue;

      const clients = (variation.businessClients ?? []) as Record<string, unknown>[];
      const code = country ? `jumia-${country.toLowerCase()}` : null;
      const client =
        clients.find((c) => code && String(c.code ?? "").toLowerCase() === code) ??
        clients.find((c) => (c.qc as Record<string, unknown> | undefined)?.status) ??
        clients[0];
      const qc = (client?.qc ?? {}) as Record<string, unknown>;
      const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

      const sid = typeof product.id === "string" && /^[0-9a-f-]{36}$/i.test(product.id) ? product.id : null;
      return {
        sellerSku,
        productSid: sid,
        status:     text(qc.status)?.toUpperCase() ?? null,
        reason:     text(qc.rejectionReason),
        comment:    text(qc.rejectionComment),
      };
    }
    return null;
  } catch (e) {
    console.warn(`[jumia] product QC lookup for ${sellerSku} failed: ${(e as Error).message}`);
    return null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractFeedId(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return (r.feedId ?? r.feed_id ?? r.id ?? r.request_id ?? null) as string | null;
}

function extractError(raw: unknown, status: number): string {
  if (!raw || typeof raw !== "object") return `HTTP ${status}`;
  const r = raw as Record<string, unknown>;
  const msg = (r.message ?? r.error ?? r.description ?? JSON.stringify(raw)) as string;
  return `HTTP ${status}: ${msg}`;
}
