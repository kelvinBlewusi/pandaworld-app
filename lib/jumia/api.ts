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

  if (error || !conn)                     throw new Error("JUMIA_NOT_CONNECTED");
  if (conn.status === "revoked")          throw new Error("JUMIA_NOT_CONNECTED");
  if (conn.status === "needs_reconnect")  throw new Error("JUMIA_RECONNECT_REQUIRED");

  // "credential_auth" is the sentinel stored when credentials were saved but
  // the seller hasn't yet completed the OAuth authorization code flow.
  if (conn.access_token === "credential_auth") {
    throw new Error("JUMIA_OAUTH_REQUIRED");
  }

  let accessToken = conn.access_token as string;

  // Auto-refresh within 5 minutes of expiry. If the refresh itself fails
  // (typically because the seller deleted the OAuth application from their
  // Vendor Center → Applications), mark the connection as needs_reconnect
  // and surface a clear error the UI can route to the onboarding page.
  if (conn.token_expires_at) {
    const expiresAt = new Date(conn.token_expires_at as string).getTime();
    if (Date.now() >= expiresAt - 5 * 60 * 1000) {
      if (!conn.refresh_token) {
        await markNeedsReconnect(db, userId);
        throw new Error("JUMIA_RECONNECT_REQUIRED");
      }
      const appId     = (conn.app_id     ?? undefined) as string | undefined;
      const appSecret = (conn.app_secret ?? undefined) as string | undefined;
      try {
        const fresh = await refreshAccessToken(
          conn.refresh_token as string,
          appId,
          appSecret,
        );
        const newExpiry = new Date(Date.now() + fresh.expires_in * 1000).toISOString();
        await db.from("jumia_connections").update({
          access_token:     fresh.access_token,
          refresh_token:    fresh.refresh_token ?? conn.refresh_token,
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

  // Jumia requires `variation` to be non-empty even for products without
  // variants. Their error: "The variation 'variation' value has to be
  // filled in order to create a Product."
  //
  // We DELIBERATELY do NOT fall back to listing.color here. That fallback
  // used to mask seller mistakes (variation field saved as null → Jumia
  // received the colour instead of what was typed) and could swap several
  // variants to the SAME string when colour was a combined value like
  // "black and green", which Jumia then dedup-rejected.
  //
  // The push route now validates upstream: empty variation → 422 with a
  // clear error. The seller is told to type a label. This "Default"
  // string only ever ships for genuinely simple products that arrive
  // here with zero variants AND no caller-supplied placeholder — and
  // even then it's a literal "Default", never the colour.
  const defaultVariation = "Default";

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
    name:        t(listing.title ?? ""),
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
    },
    stock:       listing.quantity ?? 1,
    attributes:  buildAttributes(listing),
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
  currency: string = "GHS"
): JumiaProduct[] {
  const base = buildBaseProduct(listing, brand, currency);

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
  // listings). `variation` must be a non-empty descriptive string. We use
  // whatever the seller typed (v.variation) and only fall back to
  // base.variation if a row was somehow saved with an empty variation.
  const products = variants.map((v) => {
    const variation = v.variation?.trim() || base.variation;
    if (!v.variation?.trim()) {
      console.warn(
        `[Jumia mapping] Variant ${v.id} has no variation — falling back to ` +
        `base.variation=${JSON.stringify(base.variation)}. ` +
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
        ...(v.sale_price != null ? {
          salePrice: {
            value:   v.sale_price,
            startAt: v.sale_start_date ?? undefined,
            endAt:   v.sale_end_date   ?? undefined,
          },
        } : {}),
      },
      stock: v.quantity ?? 1,
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
  const brand = await resolveBrand(accessToken, listing.brand);

  // 2. Build the products payload. Can throw if the listing lacks a real
  //    numeric category — surface that as a structured push error rather
  //    than a 500.
  let products: ReturnType<typeof mapListingToJumiaProducts>;
  try {
    products = mapListingToJumiaProducts(listing, variants, brand, currency);
  } catch (e) {
    const msg = (e as Error).message ?? "Failed to build payload";
    return { success: false, jumia_ref: null, raw: null, error: msg };
  }

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

  const brand = await resolveBrand(accessToken, listing.brand);
  let basePayload: ReturnType<typeof mapListingToJumiaProducts>;
  try {
    basePayload = mapListingToJumiaProducts(listing, variants, brand, currency);
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
