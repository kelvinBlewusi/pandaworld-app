/**
 * Jumia category + attribute helpers (server-only)
 *
 * Category tree and per-category attribute schemas are cached in Supabase
 * (jumia_categories + jumia_category_attributes tables).
 *
 * Sync them via POST /api/admin/jumia/sync-categories.
 */

import { createServerClient } from "@/lib/supabase/server";
import { JUMIA_API_BASE } from "@/lib/jumia/oauth";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface JumiaCategoryRow {
  code:        number;
  name:        string;
  path:        string;
  parent_code: number | null;
  level:       number;
  is_leaf:     boolean;
}

export interface JumiaCategoryAttribute {
  name:           string;   // API field name e.g. "ram"
  label:          string;   // Display label e.g. "RAM"
  type:           "enum" | "string" | "number" | "boolean";
  allowed_values: string[]; // valid values (enum only)
  required:       boolean;
}

// ─── Fetch leaf categories for AI classification prompt ───────────────────────

/**
 * Returns all leaf categories from Supabase.
 * Used to build the AI classification prompt so the model
 * can pick an exact Jumia category code.
 */
export async function getLeafCategories(): Promise<JumiaCategoryRow[]> {
  const db = createServerClient();
  const { data } = await db
    .from("jumia_categories")
    .select("code, name, path, parent_code, level, is_leaf")
    .eq("is_leaf", true)
    .order("path");
  return (data ?? []) as JumiaCategoryRow[];
}

/**
 * Returns a single category by code.
 */
export async function getCategoryByCode(
  code: number
): Promise<JumiaCategoryRow | null> {
  const db = createServerClient();
  const { data } = await db
    .from("jumia_categories")
    .select("code, name, path, parent_code, level, is_leaf")
    .eq("code", code)
    .maybeSingle();
  return (data ?? null) as JumiaCategoryRow | null;
}

// ─── Fetch attributes for a category ─────────────────────────────────────────

/**
 * Returns the attribute schema for a category from Supabase cache.
 * If the category has no cached attributes, returns [].
 */
export async function getCategoryAttributes(
  categoryCode: number
): Promise<JumiaCategoryAttribute[]> {
  const db = createServerClient();
  const { data } = await db
    .from("jumia_category_attributes")
    .select("name, label, type, allowed_values, required")
    .eq("category_code", categoryCode)
    .order("sort_order");
  return (data ?? []) as JumiaCategoryAttribute[];
}

// ─── Live fetch from Jumia API (used during sync) ─────────────────────────────

/**
 * Fetches the full category tree from Jumia's Catalog API.
 * Returns a flat array; the tree structure is preserved via parent_code.
 */
export async function fetchCategoriesFromJumia(
  accessToken: string
): Promise<JumiaCategoryRow[]> {
  const res = await fetch(`${JUMIA_API_BASE}/catalog/categories`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`GET /catalog/categories failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  const raw = await res.json();

  // Jumia returns either an array or { categories: [...], content: [...] }
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : (raw.categories ?? raw.content ?? raw.data ?? []);

  return flattenCategoryTree(list, null, 1);
}

function flattenCategoryTree(
  nodes: unknown[],
  parentCode: number | null,
  level: number
): JumiaCategoryRow[] {
  const result: JumiaCategoryRow[] = [];
  for (const node of nodes) {
    const n = node as Record<string, unknown>;
    const code = Number(n.code ?? n.id ?? n.categoryCode ?? 0);
    if (!code) continue;

    const children = (n.children ?? n.subcategories ?? n.subCategories ?? []) as unknown[];
    const isLeaf = children.length === 0;

    result.push({
      code,
      name:        String(n.name ?? n.label ?? ""),
      path:        String(n.path ?? n.breadcrumb ?? n.name ?? ""),
      parent_code: parentCode,
      level,
      is_leaf:     isLeaf,
    });

    if (!isLeaf) {
      result.push(...flattenCategoryTree(children, code, level + 1));
    }
  }
  return result;
}

/**
 * Fetches attribute schema for one category from Jumia's Catalog API.
 */
export async function fetchAttributesFromJumia(
  accessToken: string,
  categoryCode: number
): Promise<JumiaCategoryAttribute[]> {
  const res = await fetch(
    `${JUMIA_API_BASE}/catalog/categories/${categoryCode}/attributes`,
    {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    }
  );
  if (!res.ok) return []; // non-fatal — category might not have attributes

  const raw = await res.json();
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : (raw.attributes ?? raw.content ?? raw.data ?? []);

  return list.map((a, i) => {
    const attr = a as Record<string, unknown>;
    const values = (
      attr.values ?? attr.allowedValues ?? attr.options ?? []
    ) as unknown[];

    return {
      name:           String(attr.name ?? attr.code ?? `attr_${i}`),
      label:          String(attr.label ?? attr.displayName ?? attr.name ?? ""),
      type:           inferAttrType(attr, values),
      allowed_values: values.map((v) => {
        const val = v as Record<string, unknown>;
        return String(val.value ?? val.name ?? val.label ?? v);
      }),
      required: Boolean(attr.required ?? attr.mandatory ?? false),
    };
  });
}

function inferAttrType(
  attr: Record<string, unknown>,
  values: unknown[]
): "enum" | "string" | "number" | "boolean" {
  const raw = String(attr.type ?? attr.inputType ?? "").toLowerCase();
  if (raw.includes("bool") || raw.includes("checkbox")) return "boolean";
  if (raw.includes("num") || raw.includes("int") || raw.includes("float")) return "number";
  if (values.length > 0) return "enum";
  return "string";
}

// ─── Upsert helpers (used by the sync route) ──────────────────────────────────

export async function upsertCategories(categories: JumiaCategoryRow[]) {
  if (!categories.length) return;
  const db = createServerClient();
  // Upsert in batches of 100 to avoid payload limits
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
  const db = createServerClient();
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
