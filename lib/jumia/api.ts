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
import { columnFor, readAttributeValue } from "@/lib/jumia/attribute-mapping";
import { preflightAttributes, summarisePreflight, type PreflightNote } from "@/lib/jumia/preflight";
import { refreshAccessToken, JUMIA_API_BASE } from "@/lib/jumia/oauth";
import { mockCategories } from "@/lib/mock/categories";
import { findBrandExact } from "@/lib/jumia/brands";
import { stripBrandFromTitle } from "@/lib/ai/jumia-content-policy";
import { encrypt, decrypt } from "@/lib/security/token-crypto";
import { getCategoryAttributes, type JumiaCategoryAttribute } from "@/lib/jumia/categories";
import type { ListingRow, VariantRow } from "@/lib/supabase/types";

// ─── Country → ISO 4217 currency code ────────────────────────────────────────

const COUNTRY_CURRENCY: Record<string, string> = {
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

// ─── Token + shopId retrieval ─────────────────────────────────────────────────

export async function getValidJumiaCredentials(userId: string): Promise<{
  accessToken: string;
  shopId:      string;
  currency:    string;
}> {
  const db = createServerClient();

  const { data: conn, error } = await db
    .from("jumia_connections")
    .select("access_token, refresh_token, token_expires_at, status, shop_id, app_id, app_secret, country")
    .eq("user_id", userId)
    .maybeSingle();

  if (error || !conn)                     throw new Error("JUMIA_NOT_CONNECTED");
  if (conn.status === "revoked")          throw new Error("JUMIA_NOT_CONNECTED");
  if (conn.status === "needs_reconnect")  throw new Error("JUMIA_RECONNECT_REQUIRED");

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

  // Auto-refresh within 5 minutes of expiry. If the refresh itself fails
  // (typically because the seller deleted the OAuth application from their
  // Vendor Center → Applications), mark the connection as needs_reconnect
  // and surface a clear error the UI can route to the onboarding page.
  if (conn.token_expires_at) {
    const expiresAt = new Date(conn.token_expires_at as string).getTime();
    if (Date.now() >= expiresAt - 5 * 60 * 1000) {
      if (!refreshTokenPlain) {
        await markNeedsReconnect(db, userId);
        throw new Error("JUMIA_RECONNECT_REQUIRED");
      }
      const appId     = (conn.app_id     ?? undefined) as string | undefined;
      const appSecret = conn.app_secret ? decrypt(conn.app_secret as string) : undefined;
      try {
        const fresh = await refreshAccessToken(
          refreshTokenPlain,
          appId,
          appSecret,
        );
        const newExpiry = new Date(Date.now() + fresh.expires_in * 1000).toISOString();
        await db.from("jumia_connections").update({
          access_token:     encrypt(fresh.access_token),
          refresh_token:    encrypt(fresh.refresh_token ?? refreshTokenPlain),
          token_expires_at: newExpiry,
          status:           "active",            // recover from past needs_reconnect
          updated_at:       new Date().toISOString(),
        }).eq("user_id", userId);
        accessToken = fresh.access_token;
      } catch (e) {
        // Refresh failed — most likely the app was deleted on Jumia's side.
        // Mark the connection as needs_reconnect so the UI can prompt
        // the seller to redo onboarding.
        console.error("[Jumia] refresh failed, marking needs_reconnect:", (e as Error).message);
        await markNeedsReconnect(db, userId);
        throw new Error("JUMIA_RECONNECT_REQUIRED");
      }
    }
  }

  let shopId = (conn.shop_id ?? "") as string;
  if (!shopId) shopId = await fetchAndStoreShopId(userId, accessToken, db);
  if (!shopId) throw new Error("JUMIA_NO_SHOP_ID");

  const currency = COUNTRY_CURRENCY[(conn.country ?? "GH") as string] ?? "GHS";

  return { accessToken, shopId, currency };
}

/**
 * Mark a connection as needing reconnect. Called when the OAuth refresh
 * fails (usually because the seller deleted the OAuth app from their
 * Vendor Center → Applications). The UI watches for this status and
 * shows a persistent banner directing the seller to /onboarding/connect.
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
  await db.from("jumia_connections").update({
    status:     "needs_reconnect",
    updated_at: new Date().toISOString(),
  }).eq("user_id", userId);
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
 *   3. Generic brand code              (last resort)
 */
async function resolveBrand(
  accessToken: string,
  brandName:   string | null
): Promise<{ code: number; name: string }> {
  if (!brandName) return BRAND_GENERIC_NON_FASHION;

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

  // ── 3. Generic fallback ──────────────────────────────────────────────────
  return { code: BRAND_GENERIC_NON_FASHION.code, name: brandName };
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

function buildAttributes(
  listing: ListingRow,
  schema: JumiaCategoryAttribute[],
  /** Collects every change made on the way out, already phrased for a
   *  seller, so the caller can TELL them. Silent repair is still repair
   *  happening behind their back. */
  noteSink?: string[],
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

  add("color",              listing.color);
  add("color_family",       listing.color_family);
  add("main_material",      listing.main_material);
  add("material_family",    listing.material_family);
  add("model",              listing.model);
  add("product_line",       listing.product_line);
  add("production_country", listing.production_country);
  add("warranty_duration",  listing.warranty_duration);
  add("warranty_type",      listing.warranty_type);
  add("warranty_address",   listing.warranty_address);
  add("product_warranty",   listing.warranty_text);
  add("youtube_id",         listing.youtube_id);
  add("short_description",  listing.highlights);
  add("manufacturer_txt",   listing.brand);

  if (listing.weight_kg != null) add("product_weight", `${listing.weight_kg} kg`);

  const measures = [
    listing.size_l != null ? `L: ${listing.size_l} cm` : null,
    listing.size_w != null ? `W: ${listing.size_w} cm` : null,
    listing.size_h != null ? `H: ${listing.size_h} cm` : null,
  ].filter(Boolean).join(" × ");
  if (measures) add("product_measures", measures);

  if (listing.certifications?.length) {
    add("certifications", listing.certifications.join(", "));
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

export type JumiaProduct = ReturnType<typeof buildBaseProduct>;

function buildBaseProduct(
  listing: ListingRow,
  brand: { code: number; name: string },
  currency: string,
  schema: JumiaCategoryAttribute[] = [],
  noteSink?: string[],
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
  // product). There's no dedup risk in that case since exactly one
  // product ships, so a detected colour is strictly more useful to the
  // seller/buyer than the meaningless literal "Default" placeholder.
  // Falls back to "Default" only when there's no colour either.
  //
  // This must NOT be reused as the fallback for a VARIANT that's missing
  // its own typed variation (see mapListingToJumiaProducts below) — that
  // path keeps a hardcoded "Default" literal on purpose: sharing this
  // colour string across multiple variants of the same parent used to
  // silently mask seller mistakes and made several variants collide on
  // the same value when colour was combined (e.g. "black and green"),
  // which Jumia dedup-rejected. The push route validates upstream (empty
  // variation → 422) so the seller is told to type a label instead.
  const colorVariation   = (listing.color ?? listing.color_family ?? "").trim();
  const defaultVariation = colorVariation || "Default";

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
      // variant.
      ...(listing.sale_price != null ? {
        salePrice: {
          value:   listing.sale_price,
          startAt: listing.sale_start_date ?? undefined,
          endAt:   listing.sale_end_date   ?? undefined,
        },
      } : {}),
    },
    stock:       listing.quantity ?? 1,
    attributes:  buildAttributes(listing, schema, noteSink),
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
): JumiaProduct[] {
  const base = buildBaseProduct(listing, brand, currency, categoryAttributeSchema, noteSink);

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
  const products = variants.map((v) => {
    // Deliberately NOT base.variation here — base.variation may now be a
    // detected colour (see buildBaseProduct), and sharing that across
    // multiple variants missing their own typed value would silently
    // collide/dedup-reject exactly the way this fallback used to. Keep a
    // fixed literal instead; a real missing-variation case should surface
    // as this warning, not a plausible-looking colour string.
    const variation = v.variation?.trim() || MISSING_VARIANT_VARIATION;
    if (!v.variation?.trim()) {
      console.warn(
        `[Jumia mapping] Variant ${v.id} has no variation — falling back to ` +
        `${JSON.stringify(MISSING_VARIANT_VARIATION)}. ` +
        `This shouldn't happen if the seller typed a value — investigate the save path.`,
      );
    }
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
        ...((v.sale_price ?? listing.sale_price) != null ? {
          salePrice: {
            value:   v.sale_price       ?? listing.sale_price!,
            startAt: v.sale_start_date  ?? listing.sale_start_date ?? undefined,
            endAt:   v.sale_end_date    ?? listing.sale_end_date   ?? undefined,
          },
        } : {}),
      },
      stock: v.quantity ?? 1,
      // Per-variant attributes: clone the listing-level attributes and
      // prepend a unique `variation` entry. Listing-level attributes
      // already had "variation" stripped in buildAttributes.
      attributes: [
        { name: "variation", value: variation, translations: [] as never[] },
        ...base.attributes,
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
): string[] {
  if (schema.length === 0 || products.length === 0) return [];

  const carried = new Set(CARRIED_OUTSIDE_ATTRIBUTES.map((n) => n.toLowerCase()));
  const present = new Set<string>();
  for (const product of products) {
    for (const attr of product.attributes) {
      if (String(attr.value ?? "").trim() !== "") present.add(attr.name.toLowerCase());
    }
  }

  return schema
    .filter((f) => f.required
      && !present.has(f.name.toLowerCase())
      && !carried.has(f.name.toLowerCase()))
    .map((f) => f.label || f.name);
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
  /** Set when the payload could not be built at all (no valid category). */
  error?:          string;
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
): Promise<JumiaPayloadBuild> {
  const brand = await resolveBrand(accessToken, listing.brand);

  // Cheap local DB read, no Jumia call — see the note in the push below.
  let schema: JumiaCategoryAttribute[] = [];
  try {
    const { code } = resolveCategoryCode(listing);
    schema = await getCategoryAttributes(code);
  } catch {
    // No valid category — mapListingToJumiaProducts reports it properly.
  }

  const adjustments: string[] = [];
  try {
    const products = mapListingToJumiaProducts(listing, variants, brand, currency, schema, adjustments);
    return { products, adjustments, missingRequired: missingRequiredFor(products, schema) };
  } catch (e) {
    return {
      products: [], adjustments, missingRequired: [],
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
  currency:    string = "GHS"
): Promise<JumiaPushResult> {
  const built = await buildJumiaPayload(accessToken, listing, variants, currency);
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

  const brand = await resolveBrand(accessToken, listing.brand);

  let categoryAttributeSchema: JumiaCategoryAttribute[] = [];
  try {
    const { code } = resolveCategoryCode(listing);
    categoryAttributeSchema = await getCategoryAttributes(code);
  } catch {
    // No valid category — mapListingToJumiaProducts reports this properly.
  }

  let basePayload: ReturnType<typeof mapListingToJumiaProducts>;
  try {
    basePayload = mapListingToJumiaProducts(listing, variants, brand, currency, categoryAttributeSchema);
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
