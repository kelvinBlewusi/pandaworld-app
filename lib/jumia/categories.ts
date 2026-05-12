/**
 * Jumia category + attribute helpers (server-only)
 *
 * Key findings from API exploration:
 * - GET /catalog/categories           → flat list of ~50 root categories (these ARE the leaf categories)
 * - Each category has attributeSet.sid (UUID)
 * - GET /catalog/attribute-sets/{sid} → full attribute schema for that category
 *
 * Both tables are populated by POST /api/admin/jumia/sync-categories
 */

import { createServerClient } from "@/lib/supabase/server";
import { JUMIA_API_BASE } from "@/lib/jumia/oauth";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface JumiaCategoryRow {
  code:               number;
  name:               string;
  path:               string;
  parent_code:        number | null;
  level:              number;
  is_leaf:            boolean;
  attribute_set_sid:  string | null;
  attribute_set_name: string | null;
}

// Per official Postman docs, Jumia API attribute types are:
//   BOOLEAN, DATE, DATE_TIME, MULTI_SELECTION, NUMBER, SELECTION, TEXT, TEXT_AREA
// We map them to UI-friendly types for rendering.
export type JumiaAttrType =
  | "boolean"   // BOOLEAN
  | "number"    // NUMBER
  | "date"      // DATE
  | "datetime"  // DATE_TIME
  | "enum"      // SELECTION
  | "multi"     // MULTI_SELECTION
  | "string"    // TEXT
  | "textarea"; // TEXT_AREA

export interface JumiaCategoryAttribute {
  name:           string;   // API field name e.g. "battery_capacity"
  label:          string;   // Display label e.g. "Battery Capacity (mAh)"
  type:           JumiaAttrType;
  allowed_values: string[]; // populated for enum/multi types
  required:       boolean;
  is_variant:     boolean;  // true = can be used as variant axis (e.g. color, ram)
  // Live validation constraints from the Jumia API. Empty when not provided.
  min_length?:    number | null;
  max_length?:    number | null;
}

// ─── Supabase reads ───────────────────────────────────────────────────────────

export async function getLeafCategories(): Promise<JumiaCategoryRow[]> {
  const db = createServerClient();
  const { data } = await db
    .from("jumia_categories")
    .select("code, name, path, parent_code, level, is_leaf, attribute_set_sid, attribute_set_name")
    .eq("is_leaf", true)
    .order("name");
  return (data ?? []) as JumiaCategoryRow[];
}

export async function getCategoryByCode(code: number): Promise<JumiaCategoryRow | null> {
  const db = createServerClient();
  const { data } = await db
    .from("jumia_categories")
    .select("code, name, path, parent_code, level, is_leaf, attribute_set_sid, attribute_set_name")
    .eq("code", code)
    .maybeSingle();
  return (data ?? null) as JumiaCategoryRow | null;
}

export async function getCategoryAttributes(categoryCode: number): Promise<JumiaCategoryAttribute[]> {
  const db = createServerClient();
  const { data } = await db
    .from("jumia_category_attributes")
    .select("name, label, type, allowed_values, required, is_variant, min_length, max_length")
    .eq("category_code", categoryCode)
    .order("sort_order");
  return (data ?? []).map((r) => ({
    ...r,
    is_variant: r.is_variant ?? false,
    min_length: r.min_length ?? null,
    max_length: r.max_length ?? null,
  })) as JumiaCategoryAttribute[];
}

export async function getCategoryByPath(path: string): Promise<JumiaCategoryRow | null> {
  const db = createServerClient();
  const { data } = await db
    .from("jumia_categories")
    .select("code, name, path, parent_code, level, is_leaf, attribute_set_sid, attribute_set_name")
    .or(`path.ilike.${encodeURIComponent(path)},name.ilike.${encodeURIComponent(path)}`)
    .limit(1)
    .maybeSingle();
  return (data ?? null) as JumiaCategoryRow | null;
}

/** Returns only the variant-axis attributes for a category (is_variant = true). */
export async function getVariantAxes(categoryCode: number): Promise<JumiaCategoryAttribute[]> {
  const db = createServerClient();
  const { data } = await db
    .from("jumia_category_attributes")
    .select("name, label, type, allowed_values, required, is_variant, min_length, max_length")
    .eq("category_code", categoryCode)
    .eq("is_variant", true)
    .order("sort_order");
  return (data ?? []).map((r) => ({
    ...r,
    is_variant: true,
    min_length: r.min_length ?? null,
    max_length: r.max_length ?? null,
  })) as JumiaCategoryAttribute[];
}

// ─── Live fetch from Jumia API ────────────────────────────────────────────────

/**
 * Fetches the full paginated category list from Jumia. Walks every page until
 * the response returns no items. Then derives `is_leaf` from the breadcrumb
 * paths (`completePath`) — a category is a leaf iff no other category's path
 * starts with it.
 *
 * Critical: Jumia rejects listings against non-leaf categories with the
 * generic "you can't list products in this category" error.
 *
 * Per Postman spec, the response shape is:
 *   { categories: [{ code, name, completePath, attributeSet: { id, name } }] }
 */
export async function fetchCategoriesFromJumia(accessToken: string): Promise<JumiaCategoryRow[]> {
  const all: Record<string, unknown>[] = [];
  // Jumia's category tree typically has ~200-500 leaf categories. With the
  // default Jumia page size we expect at most ~10 pages. We allow 100 as
  // a wide safety margin so we never silently miss new categories.
  const MAX_PAGES = 100;
  let page = 1;

  while (page <= MAX_PAGES) {
    const url = `${JUMIA_API_BASE}/catalog/categories?page=${page}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (!res.ok) {
      // Surface auth failures distinctly so callers (sync route) can mark
      // the connection as needs_reconnect rather than treating it as a
      // generic network blip.
      if (res.status === 401 || res.status === 403) {
        throw new Error(`JUMIA_AUTH_FAILED: GET /catalog/categories returned ${res.status}`);
      }
      if (page === 1) throw new Error(`GET /catalog/categories failed: ${res.status}`);
      break;
    }
    const raw = await res.json() as Record<string, unknown>;
    const list = (Array.isArray(raw) ? raw : (raw.categories ?? [])) as Record<string, unknown>[];
    if (list.length === 0) break;
    all.push(...list);

    // If this is a fresh-style response without a "next page" hint, infer
    // whether more pages exist from list size. We'll keep going until empty.
    page += 1;

    // Respect Jumia rate limit (max 4 req/sec)
    await new Promise((r) => setTimeout(r, 260));
  }

  console.info(`[Jumia categories] Fetched ${all.length} categories across ${page - 1} page(s)`);

  // Normalise + collect all completePaths so we can compute is_leaf
  const normalised = all.map((c) => {
    const attrSet = c.attributeSet as Record<string, unknown> | undefined;
    const code    = Number(c.code);
    const name    = String(c.name ?? "");
    const path    = String(c.completePath ?? name);
    const level   = Math.max(1, path.split(/\s*[>/]\s*/).length);
    return {
      code,
      name,
      path,
      level,
      attribute_set_sid:  attrSet?.sid ? String(attrSet.sid) : null,
      attribute_set_name: attrSet?.name ? String(attrSet.name) : null,
    };
  });

  // A category is a leaf if no other category's path starts with "this path > "
  // (case insensitive, tolerant of various separators)
  const allPaths = normalised.map((n) => n.path.toLowerCase());

  return normalised.map((n) => {
    const myPath = n.path.toLowerCase();
    const isLeaf = !allPaths.some(
      (p) => p !== myPath && (p.startsWith(myPath + " > ") || p.startsWith(myPath + ">"))
    );
    return {
      code:               n.code,
      name:               n.name,
      path:               n.path,
      parent_code:        null,
      level:              n.level,
      is_leaf:            isLeaf,
      attribute_set_sid:  n.attribute_set_sid,
      attribute_set_name: n.attribute_set_name,
    };
  });
}

/**
 * Jumia attribute type codes:
 *  0 = string/text
 *  1 = number/decimal
 *  2 = boolean
 *  3 = multi-select (tag array)
 *  4 = enum/select (single value from options list)
 *  5 = date
 */
function mapAttrType(rawType: unknown, hasOptions: boolean): JumiaAttrType {
  // The API may return either a numeric legacy code OR the official string code
  // documented in Postman: BOOLEAN, DATE, DATE_TIME, MULTI_SELECTION, NUMBER,
  // SELECTION, TEXT, TEXT_AREA.
  const s = String(rawType ?? "").toUpperCase().trim();
  switch (s) {
    case "BOOLEAN":         return "boolean";
    case "DATE":            return "date";
    case "DATE_TIME":       return "datetime";
    case "NUMBER":          return "number";
    case "MULTI_SELECTION": return "multi";
    case "SELECTION":       return "enum";
    case "TEXT_AREA":       return "textarea";
    case "TEXT":            return "string";
  }

  // Legacy numeric codes
  const code = Number(rawType);
  if (code === 2) return "boolean";
  if (code === 1 || code === 5) return "number";
  if (code === 3) return "multi";
  if (code === 4 || hasOptions) return "enum";
  return "string";
}

/**
 * Fetches attribute schema for one category using its attributeSet sid.
 * Correct endpoint: GET /catalog/attribute-sets/{sid}
 *
 * Per official Postman spec, each attribute object is:
 *   {
 *     code:         <number>,
 *     name:         <string>,           // API field name e.g. "battery_capacity"
 *     description:  <string>,
 *     type:         <string>,           // BOOLEAN | DATE | DATE_TIME | MULTI_SELECTION |
 *                                       // NUMBER | SELECTION | TEXT | TEXT_AREA
 *     mandatory:    <boolean>,
 *     variation:    <boolean>,          // ← NOT "variant" or "is_variant"
 *     translatable: <boolean>,
 *     sid:          <uuid>,
 *     translations: [{ languageCode, translation, languageId }],
 *     options:      [{ id, name, position, isDefault }],   // ← option label is "name"
 *     validations:  [{ MinLength, MaxLength, DecimalPlaces, ... }]
 *   }
 */
export async function fetchAttributesFromJumia(
  accessToken:     string,
  attributeSetSid: string
): Promise<JumiaCategoryAttribute[]> {
  const res = await fetch(`${JUMIA_API_BASE}/catalog/attribute-sets/${attributeSetSid}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`JUMIA_AUTH_FAILED: GET /catalog/attribute-sets returned ${res.status}`);
  }
  if (!res.ok) return [];

  const raw  = await res.json() as Record<string, unknown>;
  const list = (Array.isArray(raw) ? raw : (raw.attributes ?? [])) as Record<string, unknown>[];

  return list
    .filter((a) => {
      const attr = a as Record<string, unknown>;
      // Skip internal/system attributes we can't meaningfully populate
      const skip = ["seller_sku", "parent_sku", "gtin"];
      return !skip.includes(String(attr.name ?? ""));
    })
    .map((a) => {
      const attr    = a as Record<string, unknown>;

      // Options: per spec each option has { id, name, position, isDefault }
      // The display label is `name` (not `label`). Sort by position when present.
      const rawOptions = (attr.options ?? []) as Record<string, unknown>[];
      const sortedOptions = [...rawOptions].sort((x, y) =>
        (Number(x.position ?? 0)) - (Number(y.position ?? 0))
      );
      const allowedValues = sortedOptions
        .map((o) => String(o.name ?? o.label ?? o.value ?? o.code ?? "").trim())
        .filter(Boolean);

      // Type: per spec this is a string (BOOLEAN, TEXT_AREA, ...). Pass it
      // raw to mapAttrType which handles both string and legacy numeric codes.
      const hasOpts = allowedValues.length > 0;
      const type    = mapAttrType(attr.type, hasOpts);

      // Label: prefer the English translation, fall back to the description,
      // then to the field name.
      const translations = (attr.translations ?? []) as Record<string, unknown>[];
      const enTranslation = translations.find(
        (t) => String(t.languageCode ?? "").toUpperCase() === "EN" && t.translation
      );
      const label = String(
        enTranslation?.translation ?? attr.description ?? attr.name ?? ""
      ).trim();

      // Validations array — typically has one entry. Extract length bounds.
      const validations = (attr.validations ?? []) as Record<string, unknown>[];
      const firstVal    = validations[0] ?? {};
      const minLength = firstVal.MinLength != null ? Number(firstVal.MinLength) : null;
      const maxLength = firstVal.MaxLength != null ? Number(firstVal.MaxLength) : null;

      return {
        name:           String(attr.name ?? ""),
        label:          label || String(attr.name ?? ""),
        type,
        allowed_values: allowedValues,
        required:       Boolean(attr.mandatory ?? false),
        // Per spec the variant flag is `variation` (boolean). Older naming
        // attempts kept as fallback in case any cache or response uses them.
        is_variant:     Boolean(attr.variation ?? attr.variant ?? attr.is_variant ?? false),
        min_length:     minLength,
        max_length:     maxLength,
      };
    });
}

// ─── fetchAndCacheCategoryTree ─────────────────────────────────────────────────
//
// Top-level orchestrator: fetches the full Jumia category tree for a given
// access token and stores it in Supabase. Optional: also fetches all attribute
// schemas (slow — one API call per category). Suitable for a background job
// or an explicit admin/user-triggered sync.

export async function fetchAndCacheCategoryTree(
  accessToken: string,
  options: { syncAttributes?: boolean } = {}
): Promise<{ categories: number; attributes: number }> {
  const syncAttributes = options.syncAttributes ?? false;

  // 1. Fetch + store category list
  const categories = await fetchCategoriesFromJumia(accessToken);
  await upsertCategories(categories);

  if (!syncAttributes) {
    return { categories: categories.length, attributes: 0 };
  }

  // 2. Fetch attribute schemas for each category (one call per category)
  let attrTotal = 0;
  for (const cat of categories) {
    if (!cat.attribute_set_sid) continue;
    try {
      const attrs = await fetchAttributesFromJumia(accessToken, cat.attribute_set_sid);
      if (attrs.length > 0) {
        await upsertAttributes(cat.code, attrs);
        attrTotal += attrs.length;
      }
    } catch (e) {
      console.warn(`[categories] Attribute fetch failed for ${cat.name}:`, e);
    }
  }

  return { categories: categories.length, attributes: attrTotal };
}

// ─── Upsert helpers ───────────────────────────────────────────────────────────

export async function upsertCategories(categories: JumiaCategoryRow[]) {
  if (!categories.length) return;
  const db = createServerClient();
  for (let i = 0; i < categories.length; i += 100) {
    const batch = categories.slice(i, i + 100).map((c) => ({
      ...c,
      synced_at: new Date().toISOString(),
    }));
    await db.from("jumia_categories").upsert(batch, { onConflict: "code" });
  }
}

export async function upsertAttributes(
  categoryCode: number,
  attributes:   JumiaCategoryAttribute[]
) {
  if (!attributes.length) return;
  const db  = createServerClient();
  const rows = attributes.map((a, i) => ({
    category_code:  categoryCode,
    name:           a.name,
    label:          a.label,
    type:           a.type,
    allowed_values: a.allowed_values,
    required:       a.required,
    is_variant:     a.is_variant ?? false,
    min_length:     a.min_length ?? null,
    max_length:     a.max_length ?? null,
    sort_order:     i,
    synced_at:      new Date().toISOString(),
  }));
  await db
    .from("jumia_category_attributes")
    .upsert(rows, { onConflict: "category_code,name" });
}
