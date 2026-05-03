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

export interface JumiaCategoryAttribute {
  name:           string;   // API field name e.g. "battery_capacity"
  label:          string;   // Display label e.g. "Battery Capacity (mAh)"
  type:           "enum" | "string" | "number" | "boolean" | "multi";
  allowed_values: string[]; // populated for enum/multi types
  required:       boolean;
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
    .select("name, label, type, allowed_values, required")
    .eq("category_code", categoryCode)
    .order("sort_order");
  return (data ?? []) as JumiaCategoryAttribute[];
}

// ─── Live fetch from Jumia API ────────────────────────────────────────────────

/**
 * Fetches the flat category list from Jumia.
 * The API returns ~50 top-level categories — these are the actual leaf categories
 * (the ?parentCode param is ignored; hasChildren: true is misleading).
 * Each category carries attributeSet.sid used to fetch its attribute schema.
 */
export async function fetchCategoriesFromJumia(accessToken: string): Promise<JumiaCategoryRow[]> {
  const res = await fetch(`${JUMIA_API_BASE}/catalog/categories`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`GET /catalog/categories failed: ${res.status}`);
  }

  const raw  = await res.json() as Record<string, unknown>;
  const list = (Array.isArray(raw) ? raw : (raw.categories ?? [])) as Record<string, unknown>[];

  return list.map((c) => {
    const attrSet = c.attributeSet as Record<string, unknown> | undefined;
    return {
      code:               Number(c.code),
      name:               String(c.name ?? ""),
      path:               String(c.completePath ?? c.name ?? ""),
      parent_code:        null,
      level:              1,
      is_leaf:            true,   // all returned categories accept products
      attribute_set_sid:  attrSet?.sid ? String(attrSet.sid) : null,
      attribute_set_name: attrSet?.name ? String(attrSet.name) : null,
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
function mapAttrType(typeCode: number, hasOptions: boolean): JumiaCategoryAttribute["type"] {
  if (typeCode === 2) return "boolean";
  if (typeCode === 1 || typeCode === 5) return "number";
  if (typeCode === 3) return "multi";
  if (typeCode === 4 || hasOptions) return "enum";
  return "string";
}

/**
 * Fetches attribute schema for one category using its attributeSet sid.
 * Correct endpoint: GET /catalog/attribute-sets/{sid}
 */
export async function fetchAttributesFromJumia(
  accessToken:     string,
  attributeSetSid: string
): Promise<JumiaCategoryAttribute[]> {
  const res = await fetch(`${JUMIA_API_BASE}/catalog/attribute-sets/${attributeSetSid}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
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
      const options = (attr.options ?? []) as Record<string, unknown>[];
      const typeCode = Number(attr.type ?? 0);
      const hasOpts  = options.length > 0;

      // Use EN translation as label if available
      const translations = (attr.translations ?? []) as Record<string, unknown>[];
      const enTranslation = translations.find(
        (t) => String(t.languageCode).toUpperCase() === "EN" && t.translation
      );
      const label = String(
        enTranslation?.translation ?? attr.description ?? attr.name ?? ""
      ).trim();

      return {
        name:           String(attr.name ?? ""),
        label,
        type:           mapAttrType(typeCode, hasOpts),
        allowed_values: options.map((o) =>
          String(o.label ?? o.name ?? o.value ?? o.code ?? o)
        ),
        required: Boolean(attr.mandatory ?? false),
      };
    });
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
    sort_order:     i,
    synced_at:      new Date().toISOString(),
  }));
  await db
    .from("jumia_category_attributes")
    .upsert(rows, { onConflict: "category_code,name" });
}
