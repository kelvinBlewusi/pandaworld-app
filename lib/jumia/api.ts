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

  const currency = COUNTRY_CURRENCY[(conn.country ?? "GH") as string] ?? "GHS";

  return { accessToken, shopId, currency };
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

interface JumiaAttribute {
  name:         string;
  value:        string;
  translations: never[];
}

function buildAttributes(listing: ListingRow): JumiaAttribute[] {
  const attrs: JumiaAttribute[] = [];

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
    for (const [name, value] of Object.entries(dynAttrs)) {
      if (value != null && String(value).trim() !== "") {
        // Don't duplicate attributes already set above
        if (!attrs.find((a) => a.name === name)) {
          attrs.push({ name, value: String(value), translations: [] });
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

function buildBaseProduct(listing: ListingRow, brand: { code: number; name: string }, currency: string) {
  const category   = resolveCategoryCode(listing);
  const images     = (listing.images ?? [])
    .filter(Boolean)
    .map((url, i) => ({ url, primary: i === 0 }));

  // Match Jumia Postman spec exactly:
  //   POST /feeds/products/create
  //   { name: {value, translations[]}, description: {value, translations[]},
  //     parentSku, sellerSku, variation, brand: {code, name}, category: {code, name},
  //     images: [{url, primary}], price: {value, currency, salePrice?},
  //     stock, attributes: [{name, value, translations[]}],
  //     barcodeEan, additionalCategories: [{code, name}] }
  return {
    name:                 t(listing.title ?? ""),
    description:          t(listing.description ?? ""),
    parentSku:            listing.sku,
    sellerSku:            listing.sku,
    variation:            "",
    brand,
    category,
    images,
    price: {
      value:    listing.selling_price ?? 0,
      currency,
    },
    stock:                listing.quantity ?? 1,
    attributes:           buildAttributes(listing),
    barcodeEan:           "",
    additionalCategories: [] as { code: number; name: string }[],
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
  currency: string = "GHS"
): JumiaProduct[] {
  const base = buildBaseProduct(listing, brand, currency);

  if (!variants.length) return [base];

  // With variants: one entry per variant; all share the same parentSku
  return variants.map((v) => ({
    ...base,
    sellerSku:  v.seller_sku ?? `${listing.sku}-${v.id.slice(0, 4)}`,
    parentSku:  listing.sku,
    variation:  v.variation ?? "",
    barcodeEan: v.gtin ?? "",
    price: {
      value:     v.global_price ?? listing.selling_price ?? 0,
      currency,
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
  variants:    VariantRow[],
  currency:    string = "GHS"
): Promise<JumiaPushResult> {
  // 1. Resolve brand code (calls /catalog/brands)
  const brand    = await resolveBrand(accessToken, listing.brand);
  const products = mapListingToJumiaProducts(listing, variants, brand, currency);

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

  const brand    = await resolveBrand(accessToken, listing.brand);
  const products = mapListingToJumiaProducts(listing, variants, brand, currency)
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
