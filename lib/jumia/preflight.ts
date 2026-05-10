/**
 * Pre-flight check: validates that a listing is ready to push to Jumia
 * WITHOUT actually calling Jumia's API. Runs every rule we know about and
 * returns a structured report.
 *
 * Use cases:
 *   - Testing the integration without polluting the seller's Jumia catalog
 *   - Pre-checking a listing before a real push to catch issues early
 *   - Generating the exact payload for inspection / debugging
 *
 * Rules mirror the actual constraints Jumia enforces. Every constraint we've
 * encountered in production rejections is encoded here as a check.
 */

import { createServerClient } from "@/lib/supabase/server";
import { mapListingToJumiaProducts } from "@/lib/jumia/api";
import { findBrandExact } from "@/lib/jumia/brands";
import { getCategoryAttributes, getCategoryByCode } from "@/lib/jumia/categories";
import type { ListingRow, VariantRow } from "@/lib/supabase/types";

export type CheckLevel = "pass" | "warn" | "fail";

export interface PreflightCheck {
  level:         CheckLevel;
  field:         string;          // dotted path e.g. "description" or "attributes.color"
  rule:          string;          // short identifier e.g. "min_length"
  message:       string;          // human-friendly message
  jumiaWouldSay?: string;         // what we expect Jumia to say if this failed at the wire
  fix?:          string;          // actionable next step for the seller
}

export interface PreflightReport {
  ready:    boolean;              // true when zero fails
  checks:   PreflightCheck[];
  payload:  unknown;              // exact JSON body we would send to /feeds/products/create
  summary: {
    total:    number;
    passed:   number;
    warnings: number;
    errors:   number;
  };
  meta: {
    listingId:   string;
    shopId:      string | null;
    storeName:   string | null;
    country:     string | null;
    runAt:       string;
  };
}

// ─── Constants mirroring Jumia's validation rules ────────────────────────────

const TITLE_MIN = 15;
const TITLE_MAX = 70;
const DESCRIPTION_MIN = 50;
const DESCRIPTION_MAX = 9000;
const IMAGE_MAX = 8;
const IMAGE_HEAD_TIMEOUT_MS = 4000;

// ─── Helpers ────────────────────────────────────────────────────────────────

function check(level: CheckLevel, field: string, rule: string, message: string, extras: Partial<PreflightCheck> = {}): PreflightCheck {
  return { level, field, rule, message, ...extras };
}

async function isUrlReachable(url: string): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(IMAGE_HEAD_TIMEOUT_MS),
      redirect: "follow",
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ─── Main entrypoint ────────────────────────────────────────────────────────

export async function preflightListing(
  userId:    string,
  listingId: string
): Promise<PreflightReport | { error: string }> {
  const db = createServerClient();

  // ── Load listing ──────────────────────────────────────────────────────────
  const { data: listing, error } = await db
    .from("listings")
    .select("*")
    .eq("id", listingId)
    .eq("user_id", userId)
    .single();

  if (error || !listing) {
    return { error: "Listing not found" };
  }
  const row = listing as ListingRow;

  // ── Load variants ─────────────────────────────────────────────────────────
  const { data: variantsData } = await db
    .from("variants")
    .select("*")
    .eq("listing_id", listingId);
  const variants = (variantsData ?? []) as VariantRow[];

  // ── Load connection (for shopId + currency) ───────────────────────────────
  const { data: conn } = await db
    .from("jumia_connections")
    .select("shop_id, store_name, country, status, access_token")
    .eq("user_id", userId)
    .maybeSingle();

  const checks: PreflightCheck[] = [];

  // ─── 1. Connection sanity ───────────────────────────────────────────────
  if (!conn) {
    checks.push(check("fail", "connection", "not_connected",
      "No Jumia connection found. Go to Settings → Integrations to connect.",
      { fix: "Connect Jumia first." }
    ));
  } else if (conn.status !== "active") {
    checks.push(check("fail", "connection", "inactive", `Connection status is "${conn.status}".`));
  } else if (conn.access_token === "credential_auth") {
    checks.push(check("fail", "connection", "oauth_required",
      "OAuth hasn't been completed yet — credentials are saved but you need to authorise.",
      { fix: "Settings → Integrations → Authorise with Jumia." }
    ));
  } else if (!conn.shop_id) {
    checks.push(check("warn", "connection", "no_shop_id",
      "Shop ID not yet fetched. Will be retrieved on first push."
    ));
  } else {
    checks.push(check("pass", "connection", "connected",
      `Connected to "${conn.store_name ?? "Jumia store"}" (${conn.country ?? "—"})`
    ));
  }

  // ─── 2. Title ────────────────────────────────────────────────────────────
  const titleLen = (row.title ?? "").length;
  if (!row.title) {
    checks.push(check("fail", "title", "required", "Title is required."));
  } else if (titleLen < TITLE_MIN) {
    checks.push(check("fail", "title", "min_length",
      `Title is ${titleLen} characters — must be at least ${TITLE_MIN}.`,
      { jumiaWouldSay: `Attribute [name] should have between [${TITLE_MIN}] to [${TITLE_MAX}] characters.` }
    ));
  } else if (titleLen > TITLE_MAX) {
    checks.push(check("fail", "title", "max_length",
      `Title is ${titleLen} characters — must be ${TITLE_MAX} or fewer.`,
      { jumiaWouldSay: `Attribute [name] should have between [${TITLE_MIN}] to [${TITLE_MAX}] characters.` }
    ));
  } else {
    checks.push(check("pass", "title", "length", `Title ${titleLen}/${TITLE_MAX} characters`));
  }

  // ─── 3. Description ──────────────────────────────────────────────────────
  const descLen = (row.description ?? "").length;
  if (!row.description) {
    checks.push(check("fail", "description", "required", "Description is required."));
  } else if (descLen < DESCRIPTION_MIN) {
    checks.push(check("fail", "description", "min_length",
      `Description is ${descLen} characters — Jumia hard minimum is ${DESCRIPTION_MIN}.`,
      { jumiaWouldSay: `Attribute [description] should have between [${DESCRIPTION_MIN}] to [${DESCRIPTION_MAX.toLocaleString()}] characters.` }
    ));
  } else if (descLen > DESCRIPTION_MAX) {
    checks.push(check("fail", "description", "max_length",
      `Description is ${descLen} characters — must be ${DESCRIPTION_MAX.toLocaleString()} or fewer.`
    ));
  } else if (descLen < 200) {
    checks.push(check("warn", "description", "quality",
      `Description is ${descLen} characters — Jumia accepts it but 200+ is recommended for a better content score.`
    ));
  } else {
    checks.push(check("pass", "description", "length", `Description ${descLen} characters`));
  }

  // ─── 4. Category ─────────────────────────────────────────────────────────
  if (!row.category_code) {
    checks.push(check("fail", "category", "required", "Category is required.",
      { fix: "Open the review form → pick a category from the dropdown." }
    ));
  } else {
    const code = parseInt(row.category_code, 10);
    if (!code || isNaN(code)) {
      checks.push(check("fail", "category", "invalid_code", `Category code "${row.category_code}" is not a valid number.`));
    } else {
      const cat = await getCategoryByCode(code);
      if (!cat) {
        checks.push(check("fail", "category", "unknown",
          `Category code ${code} not in our cache. Re-sync categories in Settings → Integrations.`,
          { fix: "Settings → Integrations → Sync categories." }
        ));
      } else if (!cat.is_leaf) {
        checks.push(check("fail", "category", "not_leaf",
          `"${cat.name}" is a parent category. Jumia only allows listings on leaf categories.`,
          { jumiaWouldSay: "You can't list products in this category. Please choose a different (more specific) category and try again.",
            fix: "Open the review form → click 'Change' next to Category → pick a more specific subcategory." }
        ));
      } else {
        checks.push(check("pass", "category", "leaf", `Category "${cat.name}" is a leaf — Jumia accepts listings here.`));
      }
    }
  }

  // ─── 5. Brand ────────────────────────────────────────────────────────────
  if (!row.brand) {
    checks.push(check("fail", "brand", "required", "Brand is required."));
  } else {
    let brandResolved = false;
    try {
      const local = await findBrandExact(row.brand);
      if (local) {
        checks.push(check("pass", "brand", "resolved",
          `Brand "${row.brand}" resolved to Jumia code ${local.code} (from local cache).`
        ));
        brandResolved = true;
      }
    } catch {
      // Brands table missing — fall through to warning
    }
    if (!brandResolved) {
      checks.push(check("warn", "brand", "not_in_cache",
        `Brand "${row.brand}" not in local cache. Jumia API will be queried at push time; fallback to "Generic" if not found.`
      ));
    }
  }

  // ─── 6. Variation ────────────────────────────────────────────────────────
  // Empty variation triggers: "The variation 'variation' value has to be filled..."
  const variation =
    row.color?.trim() ||
    row.color_family?.trim() ||
    "Default";
  checks.push(check("pass", "variation", "non_empty",
    `Will send variation="${variation}" (from ${row.color ? "color" : row.color_family ? "color_family" : "fallback"})`
  ));

  // ─── 7. Price ────────────────────────────────────────────────────────────
  const price = variants[0]?.global_price ?? row.selling_price ?? 0;
  if (!price || price <= 0) {
    checks.push(check("fail", "price", "required", "Selling price is required and must be > 0."));
  } else {
    checks.push(check("pass", "price", "set", `Price ${price} (${conn?.country === "GH" ? "GHS" : "local currency"})`));
  }

  // ─── 8. Images ───────────────────────────────────────────────────────────
  const images = (row.images ?? []).filter(Boolean);
  if (images.length === 0) {
    checks.push(check("fail", "images", "required", "At least 1 product image is required."));
  } else if (images.length > IMAGE_MAX) {
    checks.push(check("warn", "images", "too_many",
      `Listing has ${images.length} images — only the first ${IMAGE_MAX} will be sent (Jumia limit).`
    ));
  } else {
    checks.push(check("pass", "images", "count", `${images.length} image${images.length === 1 ? "" : "s"} provided`));
  }

  // Image reachability — parallel HEAD requests. Skip if no images.
  if (images.length > 0) {
    const reachResults = await Promise.all(
      images.slice(0, IMAGE_MAX).map((url) => isUrlReachable(url))
    );
    const unreachable = reachResults
      .map((r, i) => ({ ...r, url: images[i] }))
      .filter((r) => !r.ok);
    if (unreachable.length > 0) {
      checks.push(check("fail", "images", "unreachable",
        `${unreachable.length} image URL${unreachable.length === 1 ? "" : "s"} are unreachable. Jumia will reject the listing.`,
        { fix: "Re-upload the failing images or click 'Polish images' on the review page." }
      ));
    } else {
      checks.push(check("pass", "images", "reachable",
        `All ${reachResults.length} images responded OK to a HEAD request.`
      ));
    }
  }

  // ─── 9. Required category attributes ─────────────────────────────────────
  if (row.category_code) {
    const code = parseInt(row.category_code, 10);
    if (code && !isNaN(code)) {
      const schemaAttrs = await getCategoryAttributes(code);
      const requiredAttrs = schemaAttrs.filter((a) => a.required);
      const dyn = (row.dynamic_attributes ?? {}) as Record<string, string>;

      const missing = requiredAttrs.filter((a) => {
        const v = dyn[a.name];
        return !v || String(v).trim() === "";
      });

      if (requiredAttrs.length === 0) {
        checks.push(check("pass", "attributes", "none_required", "Category has no required attributes."));
      } else if (missing.length === 0) {
        checks.push(check("pass", "attributes", "all_filled",
          `All ${requiredAttrs.length} required attribute${requiredAttrs.length === 1 ? "" : "s"} filled.`
        ));
      } else {
        for (const m of missing) {
          checks.push(check("fail", `attributes.${m.name}`, "required",
            `Required attribute "${m.label}" is empty.`,
            { jumiaWouldSay: `Attribute [${m.name}] is required for this category.` }
          ));
        }
      }

      // Check that values match allowed_values for enum/multi types
      for (const a of schemaAttrs) {
        const v = dyn[a.name];
        if (!v || !a.allowed_values.length) continue;
        if (a.type === "enum") {
          if (!a.allowed_values.includes(v)) {
            checks.push(check("warn", `attributes.${a.name}`, "value_not_in_options",
              `Value "${v}" for "${a.label}" is not in the allowed list (${a.allowed_values.slice(0, 3).join(", ")}…). Jumia may reject.`
            ));
          }
        } else if (a.type === "multi") {
          const parts = v.split(",").map((s) => s.trim()).filter(Boolean);
          const invalid = parts.filter((p) => !a.allowed_values.includes(p));
          if (invalid.length > 0) {
            checks.push(check("warn", `attributes.${a.name}`, "value_not_in_options",
              `Some values for "${a.label}" not in the allowed list: ${invalid.join(", ")}.`
            ));
          }
        }

        // Length validation for text fields
        if ((a.type === "string" || a.type === "textarea") && (a.min_length || a.max_length)) {
          if (a.min_length && v.length < a.min_length) {
            checks.push(check("fail", `attributes.${a.name}`, "min_length",
              `"${a.label}" is ${v.length} characters — minimum is ${a.min_length}.`
            ));
          }
          if (a.max_length && v.length > a.max_length) {
            checks.push(check("fail", `attributes.${a.name}`, "max_length",
              `"${a.label}" is ${v.length} characters — maximum is ${a.max_length}.`
            ));
          }
        }
      }
    }
  }

  // ─── 10. Build the payload (using the exact same code path push uses) ────
  let payload: unknown = null;
  try {
    const brand = await findBrandExact(row.brand ?? "");
    const brandRef = brand
      ? { code: brand.code, name: brand.name }
      : { code: 1045133, name: row.brand ?? "Generic" };  // fallback to Generic
    const currency =
      conn?.country === "NG" ? "NGN" :
      conn?.country === "KE" ? "KES" :
      conn?.country === "EG" ? "EGP" :
      conn?.country === "MA" ? "MAD" :
      conn?.country === "SN" ? "XOF" :
      conn?.country === "CI" ? "XOF" :
      conn?.country === "TZ" ? "TZS" :
      conn?.country === "UG" ? "UGX" :
                                "GHS";
    const products = mapListingToJumiaProducts(row, variants, brandRef, currency);
    payload = { shopId: conn?.shop_id ?? "<not-yet-fetched>", products };
    checks.push(check("pass", "payload", "buildable", `Built ${products.length} product entr${products.length === 1 ? "y" : "ies"} successfully.`));
  } catch (e) {
    checks.push(check("fail", "payload", "build_error",
      `Couldn't build the Jumia payload: ${(e as Error).message}`
    ));
  }

  // ── Summary ────────────────────────────────────────────────────────────
  const summary = {
    total:    checks.length,
    passed:   checks.filter((c) => c.level === "pass").length,
    warnings: checks.filter((c) => c.level === "warn").length,
    errors:   checks.filter((c) => c.level === "fail").length,
  };

  return {
    ready: summary.errors === 0,
    checks,
    payload,
    summary,
    meta: {
      listingId,
      shopId:    conn?.shop_id    ?? null,
      storeName: conn?.store_name ?? null,
      country:   conn?.country    ?? null,
      runAt:     new Date().toISOString(),
    },
  };
}
