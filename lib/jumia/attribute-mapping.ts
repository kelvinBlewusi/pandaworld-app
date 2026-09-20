/**
 * Routes Jumia schema attribute names to the correct backing store in our
 * `listings` table.
 *
 * Background: Jumia's PIM returns a single flat list of attributes per
 * category — there is no semantic difference between "color" and
 * "battery_capacity" from their perspective. To keep our DB sane we want:
 *
 *   - Universal / frequently-queried fields → dedicated columns
 *     (title, description, brand, color, weight_kg, etc.)
 *   - Everything else → JSON blob `dynamic_attributes`
 *
 * Reads use this mapping to display values consistently. Writes use it to
 * persist to the right place. The renderer doesn't care which is which.
 */

import type { ListingRow } from "@/lib/supabase/types";

// Internal type — the columns we treat as "first-class" for fields the
// schema-driven form might write to. Extends to a strict ListingRow subset.
export type MappedColumn =
  | "title"
  | "description"
  | "highlights"
  | "brand"
  | "color"
  | "color_family"
  | "weight_kg"
  | "selling_price"
  | "model"
  | "main_material"
  | "material_family"
  | "production_country"
  | "product_line"
  | "warranty_duration"
  | "warranty_type"
  | "warranty_address"
  | "warranty_text"
  | "certifications"
  | "youtube_id"
  | "size_l"
  | "size_w"
  | "size_h";

/**
 * Lowercased Jumia attribute name → ListingRow column.
 * Aliases collapse to the same column (e.g. "product_description" and
 * "description" both write to listing.description).
 */
export const ATTRIBUTE_TO_COLUMN: Record<string, MappedColumn> = {
  // Identity
  name:                   "title",
  product_name:           "title",
  title:                  "title",

  // Descriptive text
  description:            "description",
  product_description:    "description",
  short_description:      "highlights",
  highlights:             "highlights",

  // Brand / colour
  brand:                  "brand",
  manufacturer:           "brand",
  color:                  "color",
  colour:                 "color",
  color_family:           "color_family",
  colour_family:          "color_family",

  // Physical
  weight:                 "weight_kg",
  weight_kg:              "weight_kg",
  product_weight:         "weight_kg",
  size_l:                 "size_l",
  size_w:                 "size_w",
  size_h:                 "size_h",

  // Pricing (still seller-required, but present in some category schemas)
  selling_price:          "selling_price",
  price:                  "selling_price",

  // Identification
  model:                  "model",
  model_number:           "model",

  // Materials
  main_material:          "main_material",
  material:               "main_material",
  material_family:        "material_family",

  // Provenance / certification
  production_country:     "production_country",
  country_of_origin:      "production_country",
  product_line:           "product_line",
  certifications:         "certifications",
  certification:          "certifications",

  // Warranty
  warranty_duration:      "warranty_duration",
  warranty_type:          "warranty_type",
  warranty_address:       "warranty_address",
  warranty_text:          "warranty_text",
  product_warranty:       "warranty_text",
  warranty:               "warranty_text",

  // Media
  youtube_id:             "youtube_id",
  youtube:                "youtube_id",
  video:                  "youtube_id",
};

/** Return the column name for a Jumia attribute, or null if it lives in dynamic_attributes. */
export function columnFor(attributeName: string): MappedColumn | null {
  return ATTRIBUTE_TO_COLUMN[attributeName.toLowerCase()] ?? null;
}

const COLUMN_TO_ALIASES: Partial<Record<MappedColumn, string[]>> = (() => {
  const map: Partial<Record<MappedColumn, string[]>> = {};
  for (const [name, col] of Object.entries(ATTRIBUTE_TO_COLUMN)) {
    (map[col] ??= []).push(name);
  }
  return map;
})();

/**
 * Every Jumia attribute-name alias that writes to this column, e.g.
 * "color" → ["color", "colour"]. Jumia's own schema uses a DIFFERENT
 * spelling for the same logical field across categories, so a builder
 * that hardcodes one alias silently loses the value on any category whose
 * schema declares it under another one — the field gets dropped as
 * "not visible for category" instead of sent under the name that category
 * actually accepts. Callers that construct an outbound attribute name
 * should check the category's own schema against this list rather than
 * assuming one fixed spelling.
 */
export function aliasesForColumn(column: MappedColumn): string[] {
  return COLUMN_TO_ALIASES[column] ?? [];
}

/**
 * Alias groups for dynamic-attribute keys. Jumia uses different spellings
 * across categories for the same logical seller field — without these
 * groups, the SchemaForm would render the same field twice (once for
 * each spelling), often with the second copy stuck as a NUMBER input
 * because Jumia's schema reported a weird type for the alias.
 *
 * Keys are the variants Jumia may use; values are the single canonical
 * key we use throughout the app. Add new aliases here whenever a
 * duplicate field appears in the UI.
 */
const DYNAMIC_ALIAS_GROUPS: Record<string, string> = {
  // ── What's in the box ──────────────────────────────────────────────────
  whats_in_the_box:         "whats_in_the_box",
  what_is_in_the_box:       "whats_in_the_box",
  what_in_box:              "whats_in_the_box",
  whats_in_box:             "whats_in_the_box",
  box_contents:             "whats_in_the_box",
  in_the_box:               "whats_in_the_box",
  package_contents:         "whats_in_the_box",
  // Singular. This is the name Jumia actually uses on at least category
  // 1000254 ("What's in the box"), and its absence here meant a seller's
  // own box contents were written under the canonical key, found not to
  // be declared by the category, and dropped by the pre-flight — while
  // the AI's guess, which happened to use the real name, was pushed.
  package_content:          "whats_in_the_box",
  contents_of_the_box:      "whats_in_the_box",
  // ── From the manufacturer (descriptive text, not the brand value) ─────
  from_the_manufacturer:    "from_the_manufacturer",
  from_manufacturer:        "from_the_manufacturer",
  manufacturer_description: "from_the_manufacturer",
  manufacturer_text:        "from_the_manufacturer",
  manufacturer_info:        "from_the_manufacturer",
  manufacturer_notes:       "from_the_manufacturer",
  // ── Notes ─────────────────────────────────────────────────────────────
  note:                     "note",
  notes:                    "note",
  // ── Additional information ────────────────────────────────────────────
  additional_info:          "additional_info",
  additional_information:   "additional_info",
};

/**
 * Returns a stable key that collapses ALL aliases for the same logical
 * field. Two attribute names with the same canonical key should render
 * as ONE field — SchemaForm uses this for dedup.
 *
 * Resolution order:
 *  1. If the attribute maps to a first-class column → "col:<column>"
 *  2. If the attribute is in an alias group → the canonical name
 *  3. Otherwise → the lowercased attribute name (no transformation)
 */
export function canonicalKey(attributeName: string): string {
  const lc = attributeName.toLowerCase();
  const col = ATTRIBUTE_TO_COLUMN[lc];
  if (col) return `col:${col}`;
  return DYNAMIC_ALIAS_GROUPS[lc] ?? lc;
}

/**
 * Read the current value of an attribute from a listing row.
 * Handles both column-backed and dynamic_attributes-backed fields.
 * Always returns a string — type coercion is done at render time.
 */
export function readAttributeValue(listing: ListingRow, attributeName: string): string {
  const col = columnFor(attributeName);
  if (col) {
    const raw = (listing as unknown as Record<string, unknown>)[col];
    if (raw == null) return "";
    if (Array.isArray(raw)) return raw.join(", ");
    return String(raw);
  }
  const dyn = listing.dynamic_attributes as Record<string, string> | null;
  return dyn?.[attributeName] ?? "";
}

/**
 * Build a partial listing update from a single field change.
 * Returns either:
 *   { columnUpdate: { [col]: value }, dynUpdate: null }   ← mapped column
 *   { columnUpdate: null, dynUpdate: { [name]: value } }  ← dynamic_attributes
 *
 * Caller merges these into the listing update payload.
 */
export function fieldChangeToUpdate(
  attributeName: string,
  value: string
): {
  columnUpdate: Record<string, unknown> | null;
  dynUpdate:    Record<string, string> | null;
} {
  const col = columnFor(attributeName);
  if (!col) {
    return {
      columnUpdate: null,
      dynUpdate:    { [attributeName]: value },
    };
  }

  // Type coercion per column. Most are strings, certifications is an array,
  // weight_kg / sizes are numbers, selling_price is a number.
  const v = value.trim();
  let coerced: unknown = v || null;
  if (col === "certifications") {
    coerced = v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
  } else if (col === "weight_kg" || col === "size_l" || col === "size_w" || col === "size_h" || col === "selling_price") {
    const n = parseFloat(v);
    coerced = isNaN(n) ? null : n;
  }

  return {
    columnUpdate: { [col]: coerced },
    dynUpdate:    null,
  };
}

/**
 * Attribute names that should ALWAYS render as their own UI block at the
 * top of the form (image grid handles itself; name + brand sit next to
 * each other). The schema-driven form skips these names so the static UI
 * isn't duplicated.
 *
 * Currently empty — we render everything dynamically. Kept as an extension
 * point in case a particular field warrants special-case UI later.
 */
export const PINNED_FIELDS = new Set<string>([
  // intentionally empty
]);
