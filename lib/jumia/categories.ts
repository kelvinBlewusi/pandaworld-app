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
import { selectAllPaginated, selectAllPaginatedParallel } from "@/lib/supabase/paginate";
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
  // Page through in 1000-row chunks — Supabase enforces a hard server-side
  // `max_rows` cap (default 1000) that .range() can't override. The full
  // GH catalogue runs to ~30k rows; an un-paginated read would see only
  // the first 1000 alphabetically. See lib/supabase/paginate.ts.
  const rows = await selectAllPaginated<JumiaCategoryRow>((from, to) =>
    db
      .from("jumia_categories")
      .select("code, name, path, parent_code, level, is_leaf, attribute_set_sid, attribute_set_name")
      .eq("is_leaf", true)
      .order("name")
      .range(from, to),
  );
  return rows;
}

/**
 * Returns every category Jumia has marked as listable — i.e. every row
 * whose attribute_set_sid is non-null. This matches what Vendor Center
 * shows in its category picker.
 *
 * Self-healing: if the table is empty (fresh deploy, accidental wipe,
 * dev environment), we lazily seed from the bundled JSON snapshot and
 * retry. Guarantees the picker is never blank — sellers always have a
 * tree to drill into, even before the admin has run their first sync.
 *
 * Why not just leaves? Jumia treats "having children" and "being
 * listable" as orthogonal. A parent category like "Watches" can have an
 * attributeSet AND children — VC's picker still shows it. We let the
 * UI layer decide selectability (CategoryRow.isSelectable based on
 * hasChildren) but include intermediate-listable parents in the tree.
 */
// ─── Process-level cache for getListableCategories ─────────────────────────
//
// The listable categories table is ~27k rows on a fully-synced GH
// project. Paginating it server-side (Supabase max_rows=1000) takes
// 28 sequential queries × ~500ms each = ~14 SECONDS per analyze. With
// 10 products in a batch this used to burn 140 seconds just on
// Supabase paging.
//
// Categories change infrequently (sync runs nightly via cron). Caching
// the result at module scope for 1 hour is safe: stale-by-up-to-an-hour
// is fine for category selection — the worst case is the AI rank pass
// not seeing a category Jumia added in the last hour, and the seller
// can re-run analyze after the cache expires.
//
// Invalidation: the sync endpoint can call invalidateListableCategoriesCache()
// to bust the cache immediately after a successful sync. The TTL is the
// safety net.

let _listableCache: { data: JumiaCategoryRow[]; expires: number } | null = null;
const LISTABLE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Bust the in-memory cache. Call after a successful jumia_categories sync. */
export function invalidateListableCategoriesCache(): void {
  _listableCache = null;
}

export async function getListableCategories(): Promise<JumiaCategoryRow[]> {
  // Fast path: warm cache.
  if (_listableCache && _listableCache.expires > Date.now()) {
    return _listableCache.data;
  }

  const db = createServerClient();
  // Page through in 1000-row chunks — see getLeafCategories for the cap
  // rationale. The AI's candidate pool and Vendor-Center picker both
  // depend on getting the FULL listable set, not just the first 1000.
  const query = () =>
    selectAllPaginatedParallel<JumiaCategoryRow>((from, to) =>
      db
        .from("jumia_categories")
        .select("code, name, path, parent_code, level, is_leaf, attribute_set_sid, attribute_set_name")
        .not("attribute_set_sid", "is", null)
        .order("name")
        .range(from, to),
    );

  let rows = await query();
  if (rows.length > 0) {
    _listableCache = { data: rows, expires: Date.now() + LISTABLE_CACHE_TTL_MS };
    return rows;
  }

  // Empty table — try to seed from the bundled snapshot. If the seed
  // also yields nothing (snapshot is empty), return [] — the picker
  // shows its empty-state copy and the admin needs to run a sync.
  const { inserted } = await seedFromBundledSnapshot();
  if (inserted === 0) return [];

  rows = await query();
  if (rows.length > 0) {
    _listableCache = { data: rows, expires: Date.now() + LISTABLE_CACHE_TTL_MS };
  }
  return rows;
}

// ─── Process-level cache for getAllCategoriesForTree ───────────────────────

let _allCache: { data: JumiaCategoryRow[]; expires: number } | null = null;

/** Bust the in-memory cache. Call after a successful jumia_categories sync. */
export function invalidateAllCategoriesCache(): void {
  _allCache = null;
}

/**
 * Every category row — leaves, listable parents, AND pure-navigation
 * non-listable parents (e.g. a department like "Electronics" that exists
 * only to hold children). getListableCategories() filters the last group
 * out via `attribute_set_sid IS NOT NULL`, which is right for the
 * seller-facing picker but wrong for walking the tree department-first —
 * see lib/actions/auto-analyze.ts's category-resolution section and
 * lib/jumia/category-search.ts's getTopLevelDepartments/getSubtreeCategories.
 *
 * No bundled-snapshot self-heal here: this is only ever called right
 * after getListableCategories() already confirmed the table is
 * non-empty, so an empty result here would mean something else broke.
 */
export async function getAllCategoriesForTree(): Promise<JumiaCategoryRow[]> {
  if (_allCache && _allCache.expires > Date.now()) {
    return _allCache.data;
  }

  const db = createServerClient();
  const rows = await selectAllPaginatedParallel<JumiaCategoryRow>((from, to) =>
    db
      .from("jumia_categories")
      .select("code, name, path, parent_code, level, is_leaf, attribute_set_sid, attribute_set_name")
      .order("name")
      .range(from, to),
  );

  if (rows.length > 0) {
    _allCache = { data: rows, expires: Date.now() + LISTABLE_CACHE_TTL_MS };
  }
  return rows;
}

/**
 * Most-recent `synced_at` across the categories table. Used by the
 * picker to decide whether to fire a background refresh (>24h ⇒ stale).
 * Returns null if the table is empty.
 */
export async function getCategoriesLastSyncedAt(): Promise<string | null> {
  const db = createServerClient();
  const { data } = await db
    .from("jumia_categories")
    .select("synced_at")
    .order("synced_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.synced_at as string | undefined) ?? null;
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
  // Jumia's category tree typically has ~200-500 leaf categories with their
  // default page size; ~10 pages total. MAX_PAGES is the safety ceiling.
  const MAX_PAGES = 30;
  // OVERALL_BUDGET_MS is the wall-clock budget for the entire walk. The
  // Vercel function maxDuration is 60s; we leave 10s headroom for the
  // upsert + response writing so we bail out gracefully before being
  // killed. Without this, a single slow Jumia page can sink the whole
  // function and the seller gets a 504 with zero data.
  const OVERALL_BUDGET_MS = 50_000;
  // PER_PAGE_TIMEOUT_MS bounds any single Jumia API call so one slow
  // page doesn't eat the entire budget.
  const PER_PAGE_TIMEOUT_MS = 10_000;

  const startedAt = Date.now();
  let page = 1;
  let timedOut = false;

  while (page <= MAX_PAGES) {
    if (Date.now() - startedAt > OVERALL_BUDGET_MS) {
      console.warn(
        `[Jumia categories] Overall budget (${OVERALL_BUDGET_MS}ms) exceeded after page ${page - 1}. ` +
        `Returning ${all.length} categories collected so far.`,
      );
      timedOut = true;
      break;
    }

    const url   = `${JUMIA_API_BASE}/catalog/categories?page=${page}`;
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PER_PAGE_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        signal:  ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const err = e as Error;
      if (err.name === "AbortError") {
        console.warn(`[Jumia categories] Page ${page} timed out after ${PER_PAGE_TIMEOUT_MS}ms. Stopping with ${all.length} collected.`);
        timedOut = true;
        break;
      }
      // Network-level failure — surface as auth failure if first page,
      // otherwise treat as end-of-walk so we keep whatever we have.
      if (page === 1) throw new Error(`GET /catalog/categories failed: ${err.message}`);
      console.warn(`[Jumia categories] Page ${page} fetch failed: ${err.message}. Stopping with ${all.length} collected.`);
      break;
    }
    clearTimeout(timer);

    if (!res.ok) {
      // Auth failures bubble up so the sync route can mark the connection
      // as needs_reconnect. Non-auth failures past page 1 just stop the
      // walk with whatever we already have.
      if (res.status === 401 || res.status === 403) {
        throw new Error(`JUMIA_AUTH_FAILED: GET /catalog/categories returned ${res.status}`);
      }
      if (page === 1) throw new Error(`GET /catalog/categories failed: ${res.status}`);
      console.warn(`[Jumia categories] Page ${page} returned ${res.status}. Stopping with ${all.length} collected.`);
      break;
    }

    const raw  = await res.json() as Record<string, unknown>;
    const list = (Array.isArray(raw) ? raw : (raw.categories ?? [])) as Record<string, unknown>[];
    if (list.length === 0) break;
    all.push(...list);

    page += 1;

    // Respect Jumia rate limit (max 4 req/sec)
    await new Promise((r) => setTimeout(r, 260));
  }

  if (timedOut && all.length === 0) {
    throw new Error("JUMIA_TIMEOUT: First page timed out — Jumia API is unreachable or unusually slow.");
  }

  // Quick breakdown so logs show how many are listable vs tree-only
  // straight after the walk. Tree-only nodes are categories Jumia
  // returns without an attributeSet — they're for navigation hierarchy
  // but can't accept product listings.
  const withAttrSet = all.filter((c) => {
    const attrSet = c.attributeSet as Record<string, unknown> | undefined;
    return Boolean(attrSet?.sid);
  }).length;
  console.info(
    `[Jumia categories] Fetched ${all.length} categories across ${page - 1} page(s) ` +
    `— ${withAttrSet} listable (attributeSet present), ${all.length - withAttrSet} tree-only.`,
  );

  // Normalise + collect all completePaths so we can compute is_leaf.
  //
  // CRITICAL: Jumia's `completePath` field uses inconsistent separators
  // depending on the endpoint version — sometimes " > ", sometimes " / ".
  // We canonicalise to " > " on the way in so downstream code (tree
  // builder, leaf detection, CSV export, deep-link rehydrate) only has
  // to deal with one form. Without this, the picker's tree builder
  // splits paths into ["Automobile / Car Care / ..."] as a single
  // segment and renders the whole category list flat at the root.
  const normalised = all.map((c) => {
    const attrSet = c.attributeSet as Record<string, unknown> | undefined;
    const code    = Number(c.code);
    const name    = String(c.name ?? "");
    const rawPath = String(c.completePath ?? name);
    const path    = rawPath.replace(/\s*[>/]\s*/g, " > ").trim();
    const level   = Math.max(1, path.split(" > ").length);
    return {
      code,
      name,
      path,
      level,
      attribute_set_sid:  attrSet?.sid ? String(attrSet.sid) : null,
      attribute_set_name: attrSet?.name ? String(attrSet.name) : null,
    };
  });

  // A category is a leaf if no other category's path starts with "this
  // path > " (paths are already normalised, so we only need to check
  // " > " — no separator variants to worry about).
  const allPaths = normalised.map((n) => n.path.toLowerCase());

  return normalised.map((n) => {
    const myPath = n.path.toLowerCase();
    const isLeaf = !allPaths.some(
      (p) => p !== myPath && p.startsWith(myPath + " > ")
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
 * Jumia attribute type codes.
 *
 * The numeric codes below were CORRECTED against the live cache after a
 * rejection exposed them. The mapping originally read 1=number, 2=boolean;
 * both were wrong, and the shape of the wrongness is unmistakable:
 *
 *   code 2 → we stored "boolean"   19 distinct names, EVERY one a
 *                                  quantity: capacity_liter, cpu_cores,
 *                                  cpu_speed, storage_capacity, voltage,
 *                                  display_size, pages, year_of_publication…
 *                                  Not one is a yes/no. Jumia confirmed it
 *                                  directly: "Attribute [capacity_liter]
 *                                  with the value [0.35] should be a number
 *                                  without decimals."
 *
 *   code 1 → we stored "number"    description, short_description,
 *                                  package_content, product_warranty,
 *                                  manufacturer_txt, warranty_address —
 *                                  594 categories each, all long free text.
 *                                  (battery_capacity appears here once
 *                                  against 82 categories where it's TEXT;
 *                                  that is Jumia being inconsistent, not a
 *                                  second meaning for the code.)
 *
 * So no numeric code in the live data means NUMBER except 2, and none
 * means BOOLEAN at all — a real boolean arrives as the string "BOOLEAN",
 * which the switch above already handles.
 *
 * Code 5 is grouped with 1 because it always has been and nothing in the
 * cache distinguishes them; every row in that bucket is long text. If a
 * future sync proves otherwise, the raw code is logged now (see below).
 *
 *  0 = text
 *  1 = long text / text area
 *  2 = number
 *  3 = multi-select (tag array)
 *  4 = enum/select (single value from options list)
 *  5 = long text (assumed — see above)
 */
/** The documented string codes. Anything else gets logged once per sync. */
const KNOWN_RAW_ATTR_TYPES = new Set([
  "BOOLEAN", "DATE", "DATE_TIME", "NUMBER", "NUMBER_FLOAT",
  "MULTI_SELECTION", "SELECTION", "TEXT_AREA", "TEXT",
]);

export function mapAttrType(rawType: unknown, hasOptions: boolean): JumiaAttrType {
  // The API may return either a numeric legacy code OR the official string code
  // documented in Postman: BOOLEAN, DATE, DATE_TIME, MULTI_SELECTION, NUMBER,
  // NUMBER_FLOAT, SELECTION, TEXT, TEXT_AREA.
  const s = String(rawType ?? "").toUpperCase().trim();
  switch (s) {
    case "BOOLEAN":         return "boolean";
    case "DATE":            return "date";
    case "DATE_TIME":       return "datetime";
    case "NUMBER":          return "number";
    // Missing from the original Postman spec entirely — a category
    // attribute typed NUMBER_FLOAT (a fractional quantity, e.g. a ratio or
    // a measurement with a decimal) matched none of the cases here and
    // fell all the way through to the string-typed default at the bottom,
    // rendering as a free-text box with no numeric handling at all.
    case "NUMBER_FLOAT":    return "number";
    case "MULTI_SELECTION": return "multi";
    case "SELECTION":       return "enum";
    case "TEXT_AREA":       return "textarea";
    case "TEXT":            return "string";
  }

  // Legacy numeric codes
  const code = Number(rawType);
  if (code === 2) return "number";
  if (code === 1 || code === 5) return "textarea";
  if (code === 3) return "multi";
  if (code === 4 || hasOptions) return "enum";
  return "string";
}

/**
 * Fetches attribute schema for one category using its attributeSet sid.
 * Correct endpoint: GET /catalog/attribute-sets/{sid}
 *
 * Per Jumia's own corrected doc (2026-09-16 changelog — the Postman spec
 * this was originally written against was wrong on every point below),
 * each attribute object is:
 *   {
 *     code:         <number>,
 *     name:         <string>,           // API field name e.g. "battery_capacity"
 *     description:  <string>,
 *     type:         <number>,           // NOT a string — see mapAttrType's
 *                                       // legacy-numeric-code branch, which
 *                                       // already exists for this reason.
 *                                       // The corresponding string names
 *                                       // are BOOLEAN | DATE | DATE_TIME |
 *                                       // MULTI_SELECTION | NUMBER |
 *                                       // NUMBER_FLOAT | SELECTION | TEXT |
 *                                       // TEXT_AREA — NUMBER_FLOAT was
 *                                       // missing from the original spec.
 *     mandatory:    <boolean>,
 *     variation:    <boolean>,          // ← NOT "variant" or "is_variant"
 *     translatable: <boolean>,
 *     sid:          <uuid>,
 *     translations: [{ languageCode, translation, languageId }],
 *     options:      [{ id, name, position, isDefault, status, translations }],
 *                                       // ← option label is "name". `id` is
 *                                       // a NUMBER; the uuid is a separate
 *                                       // `sid` field. We never send option
 *                                       // ids back to Jumia (only the name
 *                                       // string, as the attribute VALUE),
 *                                       // so this has no effect on us.
 *     validations:  { minLength, maxLength, dateFormat, selectedByDefault,
 *                     decimalPlaces, percentage, notZeroOrNegative }
 *                                       // ← a single OBJECT, not an array,
 *                                       // and every key lowercase. This was
 *                                       // documented as an array of
 *                                       // capitalised keys (MinLength,
 *                                       // MaxLength, ...) that the live API
 *                                       // never actually returns — meaning
 *                                       // min_length/max_length below have
 *                                       // been silently null since this was
 *                                       // written. Read defensively (both
 *                                       // shapes) rather than assume the
 *                                       // correction is itself exhaustive.
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
  if (!res.ok) {
    // THROW rather than return []. This used to return [] for every
    // non-auth failure — a 500, a timeout Jumia turned into a 502, an sid
    // that no longer resolves — which made the caller (fetchAndCacheCategoryTree)
    // read a transient API failure as "this category genuinely has zero
    // attributes" and silently DOWNGRADE it: null out attribute_set_sid,
    // remove it from the picker, as if Jumia had told us the category
    // can't be listed. It hadn't; the request had simply failed.
    //
    // Catalog is one of the three error shapes the corrected doc
    // distinguishes: { code, message } — not the { data: [...] } wrapper
    // this endpoint was originally documented with, and not the
    // { timestamp, status, error, path } shape the Feeds/Shops services use.
    const body = await res.json().catch(() => null) as { code?: string | number; message?: string } | null;
    const detail = body?.message ? ` — ${body.message}${body.code != null ? ` (${body.code})` : ""}` : "";
    throw new Error(`GET /catalog/attribute-sets/${attributeSetSid} returned ${res.status}${detail}`);
  }

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

      // Record the RAW code alongside what we made of it. The numeric
      // codes had been mis-mapped since this was written and nothing
      // surfaced it until Jumia rejected a feed over a field we'd typed
      // boolean — because the only place the mapping was visible was a
      // Yes/No dropdown on a form no one had reason to distrust. One line
      // per unfamiliar code is cheap; being wrong about it again is not.
      if (!KNOWN_RAW_ATTR_TYPES.has(String(attr.type ?? "").toUpperCase().trim())) {
        console.info(`[Jumia attrs] raw type ${JSON.stringify(attr.type)} → "${type}" (${String(attr.name ?? "?")})`);
      }

      // Label: prefer the English translation, fall back to the description,
      // then to the field name.
      const translations = (attr.translations ?? []) as Record<string, unknown>[];
      const enTranslation = translations.find(
        (t) => String(t.languageCode ?? "").toUpperCase() === "EN" && t.translation
      );
      const label = String(
        enTranslation?.translation ?? attr.description ?? attr.name ?? ""
      ).trim();

      // `validations` is a single OBJECT, not an array — the original spec
      // documented `[{ MinLength, MaxLength, ... }]` and neither part of
      // that was right. Reading `validations[0]` off an object read
      // `undefined[0]` → undefined every time, so minLength/maxLength have
      // been silently null since this was written; preflightAttributes'
      // max_length truncation (lib/jumia/preflight.ts) has never actually
      // had a bound to enforce.
      //
      // Read both casings rather than trust the correction blindly — the
      // capitalised keys are what a second source of drift would look
      // like, and this costs nothing to guard against.
      const validations = (Array.isArray(attr.validations)
        ? ((attr.validations as Record<string, unknown>[])[0] ?? {})
        : (attr.validations ?? {})) as Record<string, unknown>;
      const readNum = (lower: string, upper: string): number | null => {
        const v = validations[lower] ?? validations[upper];
        return v != null ? Number(v) : null;
      };
      const minLength = readNum("minLength", "MinLength");
      const maxLength = readNum("maxLength", "MaxLength");

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

  // 2. Fetch attribute schemas for each category (one call per category).
  //    Doubles as a listability confirmation: a category with
  //    `attribute_set_sid` set but a zero-row schema is functionally
  //    non-listable — downgrade it by nulling the sid in the DB so the
  //    picker stops offering it.
  let attrTotal       = 0;
  const downgrades:   number[] = [];
  const db            = createServerClient();
  for (const cat of categories) {
    if (!cat.attribute_set_sid) continue;
    try {
      const attrs = await fetchAttributesFromJumia(accessToken, cat.attribute_set_sid);
      if (attrs.length > 0) {
        await upsertAttributes(cat.code, attrs);
        attrTotal += attrs.length;
      } else {
        downgrades.push(cat.code);
      }
    } catch (e) {
      console.warn(`[categories] Attribute fetch failed for ${cat.name}:`, e);
      // Soft-fail: don't downgrade on transient errors. The next sync
      // gets another chance. Only confirmed-empty schemas downgrade.
    }
  }

  if (downgrades.length > 0) {
    console.info(
      `[Jumia categories] Downgrading ${downgrades.length} category/categories ` +
      `whose attributeSet returned an empty schema (not actually listable).`,
    );
    // Batch-update in chunks of 100 to stay within Supabase limits.
    for (let i = 0; i < downgrades.length; i += 100) {
      const chunk = downgrades.slice(i, i + 100);
      await db
        .from("jumia_categories")
        .update({ attribute_set_sid: null, synced_at: new Date().toISOString() })
        .in("code", chunk);
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

// ─── Batched sync helpers ─────────────────────────────────────────────────────
//
// The admin UI calls `fetchCategoriesPage(token, n)` once per Jumia page,
// then `recomputeIsLeafForAllCategories()` once at the end. Each per-page
// call returns in ~1-2s — far below any function timeout. The client
// orchestrates the loop and renders a progress bar.

export interface FetchPageResult {
  /** Categories returned by Jumia for this page, already normalised + upserted. */
  rows:        JumiaCategoryRow[];
  /** True when Jumia returned a non-empty list — caller knows to try page+1. */
  hasMore:     boolean;
}

/**
 * Fetch a single Jumia category page and upsert it. is_leaf is left as
 * `false` for every row in this call — it can't be computed page-by-page
 * because a category in page 1 might gain children only in page 5. Call
 * `recomputeIsLeafForAllCategories()` once at the end of the batch loop
 * to fix is_leaf for the full set.
 */
export async function fetchCategoriesPage(
  accessToken: string,
  page:        number,
): Promise<FetchPageResult> {
  const PER_PAGE_TIMEOUT_MS = 10_000;

  const url   = `${JUMIA_API_BASE}/catalog/categories?page=${page}`;
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PER_PAGE_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      signal:  ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const err = e as Error;
    if (err.name === "AbortError") {
      throw new Error(`JUMIA_TIMEOUT: page ${page} timed out after ${PER_PAGE_TIMEOUT_MS}ms`);
    }
    throw new Error(`Page ${page} fetch failed: ${err.message}`);
  }
  clearTimeout(timer);

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error(`JUMIA_AUTH_FAILED: page ${page} returned ${res.status}`);
    }
    throw new Error(`Page ${page} returned HTTP ${res.status}`);
  }

  const raw  = await res.json() as Record<string, unknown>;
  const list = (Array.isArray(raw) ? raw : (raw.categories ?? [])) as Record<string, unknown>[];
  if (list.length === 0) {
    return { rows: [], hasMore: false };
  }

  // Normalise + provisional is_leaf=false. Final value is recomputed in
  // recomputeIsLeafForAllCategories() after the full walk.
  const rows: JumiaCategoryRow[] = list.map((c) => {
    const attrSet = c.attributeSet as Record<string, unknown> | undefined;
    const code    = Number(c.code);
    const name    = String(c.name ?? "");
    const rawPath = String(c.completePath ?? name);
    const path    = rawPath.replace(/\s*[>/]\s*/g, " > ").trim();
    const level   = Math.max(1, path.split(" > ").length);
    return {
      code,
      name,
      path,
      parent_code:        null,
      level,
      is_leaf:            false,  // recomputed in finalize step
      attribute_set_sid:  attrSet?.sid ? String(attrSet.sid) : null,
      attribute_set_name: attrSet?.name ? String(attrSet.name) : null,
    };
  });

  await upsertCategories(rows);
  return { rows, hasMore: true };
}

/**
 * Read every category's path from Supabase, compute is_leaf for each
 * (a row is a leaf iff no other row's path starts with this row's path
 * followed by " > "), and batch-update. Single DB read + ~5 batch updates
 * — typically <1s.
 *
 * Called once at the end of a batched sync, AFTER the last page is in.
 * Safe to call ad-hoc to repair stale is_leaf values.
 */
export async function recomputeIsLeafForAllCategories(): Promise<{
  updated: number;
  total:   number;
}> {
  const db = createServerClient();
  // Page through in 1000-row chunks — Supabase's hard server-side max_rows
  // (default 1000) means a single .range(0, 99_999) call would still cap
  // at 1000 rows. Without paging, recompute would only see the first 1000
  // alphabetical rows and mark everything past that as a leaf.
  const all = await selectAllPaginated<{ code: number; path: string; is_leaf: boolean | null }>(
    (from, to) =>
      db
        .from("jumia_categories")
        .select("code, path, is_leaf")
        .range(from, to),
  );
  if (all.length === 0) return { updated: 0, total: 0 };

  const lowerPaths = all.map((r) => r.path.toLowerCase());

  // Compute is_leaf for each row. Only write back if it changed.
  const updates: Array<{ code: number; is_leaf: boolean }> = [];
  for (let i = 0; i < all.length; i++) {
    const myPath = lowerPaths[i];
    const isLeaf = !lowerPaths.some(
      (p, j) => j !== i && p.startsWith(myPath + " > ")
    );
    if (Boolean(all[i].is_leaf) !== isLeaf) {
      updates.push({ code: all[i].code, is_leaf: isLeaf });
    }
  }

  // Batch the updates in chunks of 200 to stay under Supabase limits.
  for (let i = 0; i < updates.length; i += 200) {
    const chunk = updates.slice(i, i + 200);
    // Supabase upsert with onConflict performs the update.
    await db.from("jumia_categories").upsert(
      chunk.map((u) => ({ code: u.code, is_leaf: u.is_leaf })),
      { onConflict: "code" },
    );
  }

  return { updated: updates.length, total: all.length };
}

/**
 * Bootstrap an empty `jumia_categories` table from the bundled JSON
 * snapshot at `supabase/seed/jumia-categories.json`. Lazy / on-demand —
 * called only when a read returns zero rows.
 *
 * If the snapshot is itself empty (e.g. on a brand-new project before
 * the maintainer has run `npm run snapshot-categories`), this is a no-op
 * and the table stays empty. The admin sync still works to populate.
 */
export async function seedFromBundledSnapshot(): Promise<{ inserted: number }> {
  let snapshot: JumiaCategoryRow[];
  try {
    // Dynamic import so the JSON is bundled into the route's serverless
    // function only when needed (small but saves cold-start overhead).
    const mod = await import("../../supabase/seed/jumia-categories.json");
    snapshot = (mod.default ?? mod) as JumiaCategoryRow[];
  } catch (e) {
    console.warn("[seed] Snapshot JSON missing or unreadable:", (e as Error).message);
    return { inserted: 0 };
  }

  if (!Array.isArray(snapshot) || snapshot.length === 0) {
    console.info("[seed] Snapshot is empty — nothing to seed. Admin needs to run a sync.");
    return { inserted: 0 };
  }

  await upsertCategories(snapshot);
  console.info(`[seed] Seeded ${snapshot.length} categories from bundled snapshot.`);
  return { inserted: snapshot.length };
}
