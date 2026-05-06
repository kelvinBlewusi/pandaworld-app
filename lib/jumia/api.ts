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
import { refreshAccessToken, JUMIA_API_BASE } from "@/lib/jumia/oauth";
import { mockCategories } from "@/lib/mock/categories";
import { findBrandExact } from "@/lib/jumia/brands";
import type { ListingRow, VariantRow } from "@/lib/supabase/types";

// ─── Token + shopId retrieval ─────────────────────────────────────────────────

export async function getValidJumiaCredentials(userId: string): Promise<{
  accessToken: string;
  shopId:      string;
}> {
  const db = createServerClient();

  const { data: conn, error } = await db
    .from("jumia_connections")
    .select("access_token, refresh_token, token_expires_at, status, shop_id, app_id, app_secret")
    .eq("user_id", userId)
    .maybeSingle();

  if (error || !conn)            throw new Error("JUMIA_NOT_CONNECTED");
  if (conn.status === "revoked") throw new Error("JUMIA_NOT_CONNECTED");

  // "credential_auth" is the sentinel stored when credentials were saved but
  // the seller hasn't yet completed the OAuth authorization code flow.
  if (conn.access_token === "credential_auth") {
    throw new Error("JUMIA_OAUTH_REQUIRED");
  }

  let accessToken = conn.access_token as string;

  // Auto-refresh within 5 minutes of expiry
  if (conn.token_expires_at) {
    const expiresAt = new Date(conn.token_expires_at as string).getTime();
    if (Date.now() >= expiresAt - 5 * 60 * 1000) {
      if (!conn.refresh_token) throw new Error("JUMIA_TOKEN_EXPIRED");
      // Use the seller's own app credentials for the refresh
      const appId     = (conn.app_id     ?? undefined) as string | undefined;
      const appSecret = (conn.app_secret ?? undefined) as string | undefined;
      const fresh     = await refreshAccessToken(
        conn.refresh_token as string,
        appId,
        appSecret,
      );
      const newExpiry = new Date(Date.now() + fresh.expires_in * 1000).toISOString();
      await db.from("jumia_connections").update({
        access_token:     fresh.access_token,
        refresh_token:    fresh.refresh_token ?? conn.refresh_token,
        token_expires_at: newExpiry,
        updated_at:       new Date().toISOString(),
      }).eq("user_id", userId);
      accessToken = fresh.access_token;
    }
  }

  let shopId = (conn.shop_id ?? "") as string;
  if (!shopId) shopId = await fetchAndStoreShopId(userId, accessToken, db);
  if (!shopId) throw new Error("JUMIA_NO_SHOP_ID");

  return { accessToken, shopId };
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

  return { code: 0, name: listing.category_path ?? "Unknown" };
}

// ─── Attribute builder ────────────────────────────────────────────────────────

function buildAttributes(listing: ListingRow): { name: string; value: string }[] {
  const attrs: { name: string; value: string }[] = [];

  const add = (name: string, value: string | null | undefined) => {
    if (value != null && value !== "") attrs.push({ name, value: String(value) });
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
    for (const [name, value] of Object.entries(dynAttrs)) {
      if (value != null && String(value).trim() !== "") {
        // Don't duplicate attributes already set above
        if (!attrs.find((a) => a.name === name)) {
          attrs.push({ name, value: String(value) });
        }
      }
    }
  }

  return attrs;
}

// ─── Payload mapping ──────────────────────────────────────────────────────────

/** Translated string field — Jumia uses { value, translations: [] } shape */
function t(value: string) {
  return { value, translations: [] as never[] };
}

export type JumiaProduct = ReturnType<typeof buildBaseProduct>;

function buildBaseProduct(listing: ListingRow, brand: { code: number; name: string }) {
  const category   = resolveCategoryCode(listing);
  const images     = (listing.images ?? [])
    .filter(Boolean)
    .map((url, i) => ({ url, primary: i === 0 }));

  return {
    name:        t(listing.title ?? ""),
    description: t(listing.description ?? ""),
    parentSku:   listing.sku,
    sellerSku:   listing.sku,
    gtinBarcode: "",
    variation:   "",
    brand,
    category,
    images,
    price: {
      currency: "GHS",
      value:    listing.selling_price ?? 0,
    },
    stock:      listing.quantity ?? 1,
    attributes: buildAttributes(listing),
  };
}

/**
 * Map a listing + variants → array of Jumia product objects.
 * Pass the resolved brand (from resolveBrand()) to avoid duplicate API calls.
 */
export function mapListingToJumiaProducts(
  listing:  ListingRow,
  variants: VariantRow[],
  brand:    { code: number; name: string }
): JumiaProduct[] {
  const base = buildBaseProduct(listing, brand);

  if (!variants.length) return [base];

  // With variants: one entry per variant; all share the same parentSku
  return variants.map((v) => ({
    ...base,
    sellerSku:   v.seller_sku ?? `${listing.sku}-${v.id.slice(0, 4)}`,
    parentSku:   listing.sku,
    variation:   v.variation ?? "",
    gtinBarcode: v.gtin ?? "",
    price: {
      currency:  "GHS" as const,
      value:     v.global_price ?? listing.selling_price ?? 0,
      ...(v.sale_price != null ? {
        salePrice: {
          value:   v.sale_price,
          startAt: v.sale_start_date ?? undefined,
          endAt:   v.sale_end_date   ?? undefined,
        },
      } : {}),
    },
    stock: v.quantity ?? 1,
  }));
}

// ─── Jumia API call ───────────────────────────────────────────────────────────

export interface JumiaPushResult {
  success:   boolean;
  jumia_ref: string | null;  // feedId — poll GET /feeds/{id} for status
  raw:       unknown;
  error?:    string;
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
  variants:    VariantRow[]
): Promise<JumiaPushResult> {
  // 1. Resolve brand code (calls /catalog/brands)
  const brand    = await resolveBrand(accessToken, listing.brand);
  const products = mapListingToJumiaProducts(listing, variants, brand);

  const url  = `${JUMIA_API_BASE}/feeds/products/create`;
  const body = JSON.stringify({ shopId, products });

  console.info(`[Jumia API] POST ${url} — shopId=${shopId}, products=${products.length}, brand=${JSON.stringify(brand)}`);
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
    return { success: true, jumia_ref: feedId, raw };
  }

  const errorMsg = extractError(raw, res.status);
  console.error("[Jumia API] ❌ Error:", res.status, raw);
  return { success: false, jumia_ref: null, raw, error: errorMsg };
}

/**
 * POST https://vendor-api.jumia.com/feeds/products/update
 *
 * Same payload shape as pushProductsToJumia — Jumia matches by sellerSku.
 * Returns a new feedId; poll GET /feeds/{id} for completion.
 */
export async function updateProductOnJumia(
  accessToken: string,
  shopId:      string,
  listing:     ListingRow,
  variants:    VariantRow[]
): Promise<JumiaPushResult> {
  const brand    = await resolveBrand(accessToken, listing.brand);
  const products = mapListingToJumiaProducts(listing, variants, brand);

  const url  = `${JUMIA_API_BASE}/feeds/products/update`;
  const body = JSON.stringify({ shopId, products });

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
    return {
      status:  (raw.status  as string) ?? "UNKNOWN",
      total:   (raw.total   as number) ?? 0,
      success: (raw.success as number) ?? 0,
      failed:  (raw.failed  as number) ?? 0,
      errors:  (raw.errors  as unknown[]) ?? [],
      raw,
    };
  } catch { return null; }
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
