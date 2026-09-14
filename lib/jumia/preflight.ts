/**
 * Pre-flight validation of a Jumia attribute payload against the resolved
 * category's own schema.
 *
 * WHY: the push path sends the payload and lets Jumia adjudicate. Every
 * rejection on record was detectable locally before sending —
 *
 *   "Attribute [color_family] is not visible for category [Laptops]"
 *   "Attribute [main_material] is not visible for category [Laptops]"
 *   "Attribute [graphics_memory] is not visible for category [Laptops]"
 *   "Attribute [material_family] with invalid value [Fabric]"
 *
 * — because the schema already tells us which attributes the category
 * declares and which values each one accepts. Jumia rejects the ENTIRE
 * feed over one bad attribute, so a single undeclared field costs the
 * seller the whole product.
 *
 * The specific hole this closes: sanitizeEnumAttributes deliberately let
 * an attribute with NO schema entry pass through untouched, on the theory
 * that a universal field the category doesn't define might still be
 * accepted. The live rejections above prove otherwise.
 *
 * Pure and synchronous on purpose — no database, no AI, no network. It
 * decides what is provably wrong and what can be repaired deterministically;
 * anything needing judgement is reported for a caller to act on.
 */

import type { JumiaCategoryAttribute } from "@/lib/jumia/categories";

export interface PreflightAttribute {
  name:  string;
  value: string;
}

export type PreflightReason =
  /** The category's schema doesn't declare this attribute at all. Jumia
   *  answers with "not visible for category" and rejects the whole feed. */
  | "not_in_schema"
  /** Enum value isn't one the category accepts, and no close match exists. */
  | "invalid_enum"
  /** Enum value was near-missed and snapped to the accepted spelling. */
  | "snapped_enum"
  /** Exceeded the schema's max_length and was trimmed. */
  | "truncated"
  /** Required by the schema and empty. Cannot be repaired here — needs an
   *  AI fill or the seller. */
  | "missing_required";

export interface PreflightNote {
  attribute: string;
  label:     string;
  reason:    PreflightReason;
  detail:    string;
}

export interface PreflightResult {
  /** The payload as it should actually be sent. */
  attributes: PreflightAttribute[];
  /** Everything changed or flagged, for logging and for telling a seller
   *  what could not be fixed. */
  notes: PreflightNote[];
  /** Schema-required attributes still empty — the caller decides whether
   *  to AI-fill them or hand back to the seller. */
  missingRequired: PreflightNote[];
}

/**
 * Repair a near-miss enum value.
 *
 * Handles the drift that actually occurs: casing ("pink" vs "Pink"),
 * surrounding whitespace, and singular/plural ("Hard Hat" vs "Hard Hats").
 *
 * Refuses to guess when more than one allowed value could be meant —
 * picking one of two plausible options is how a listing ends up
 * confidently wrong, which this codebase treats as worse than empty.
 */
export function snapToAllowed(value: string, allowed: string[]): string | null {
  const raw = value.trim();
  if (!raw) return null;
  if (allowed.length === 0) return raw;

  const exact = allowed.find((a) => a === raw);
  if (exact) return exact;

  const lower = raw.toLowerCase();
  const ci = allowed.filter((a) => a.toLowerCase() === lower);
  if (ci.length === 1) return ci[0];

  // Singular/plural, both directions.
  const depluralised = lower.replace(/s$/, "");
  const plural = allowed.filter((a) => {
    const al = a.toLowerCase();
    return al.replace(/s$/, "") === depluralised;
  });
  if (plural.length === 1) return plural[0];

  return null;
}

/** Split a multi-select value into its parts. Jumia sends these comma
 *  separated. */
function splitMulti(value: string): string[] {
  return value.split(",").map((v) => v.trim()).filter(Boolean);
}

export interface PreflightOptions {
  /**
   * Schema-required names the PRODUCT object carries somewhere OTHER than
   * the attribute list, and which are therefore not missing just because
   * they're absent from it.
   *
   * Jumia's schema marks `name`, `description` and `variation` required
   * for effectively every category, but the payload sends them as
   * top-level product fields (and `variation` per variant). Counting
   * those as missing made `missingRequired` fire on every single push —
   * three false positives that would drown the one real one and make the
   * list useless as a gate.
   */
  carriedElsewhere?: Iterable<string>;
}

/**
 * Validate and repair an attribute payload against a category schema.
 *
 * An EMPTY schema means we never successfully fetched one, not that the
 * category declares nothing — so nothing is dropped in that case. Being
 * wrong about the schema must never cost the seller attributes that would
 * have been accepted.
 */
export function preflightAttributes(
  attributes: PreflightAttribute[],
  schema:     JumiaCategoryAttribute[],
  options:    PreflightOptions = {},
): PreflightResult {
  if (schema.length === 0) {
    return { attributes, notes: [], missingRequired: [] };
  }

  const byName = new Map(schema.map((f) => [f.name.toLowerCase(), f]));
  const notes: PreflightNote[] = [];
  const out: PreflightAttribute[] = [];

  for (const attr of attributes) {
    const field = byName.get(attr.name.toLowerCase());

    if (!field) {
      notes.push({
        attribute: attr.name,
        label:     attr.name,
        reason:    "not_in_schema",
        detail:    `this category doesn't accept "${attr.name}"`,
      });
      continue;
    }

    let value = attr.value.trim();
    if (!value) continue;

    if (field.allowed_values.length > 0) {
      const parts = field.type === "multi" ? splitMulti(value) : [value];
      const kept: string[] = [];
      for (const part of parts) {
        const snapped = snapToAllowed(part, field.allowed_values);
        if (snapped === null) continue;
        if (snapped !== part) {
          notes.push({
            attribute: attr.name,
            label:     field.label,
            reason:    "snapped_enum",
            detail:    `"${part}" corrected to "${snapped}"`,
          });
        }
        kept.push(snapped);
      }
      if (kept.length === 0) {
        notes.push({
          attribute: attr.name,
          label:     field.label,
          reason:    "invalid_enum",
          detail:    `"${value}" isn't a value this category accepts`,
        });
        continue;
      }
      value = kept.join(",");
    }

    // Trim at a word boundary where possible — a value cut mid-word looks
    // broken to a buyer, and the few characters saved are worth nothing.
    const max = field.max_length ?? null;
    if (max != null && max > 0 && value.length > max) {
      const cut = value.slice(0, max);
      const lastSpace = cut.lastIndexOf(" ");
      value = (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd();
      notes.push({
        attribute: attr.name,
        label:     field.label,
        reason:    "truncated",
        detail:    `trimmed to the ${max}-character limit`,
      });
    }

    out.push({ name: attr.name, value });
  }

  // Required-but-empty, reported rather than invented.
  const present = new Set(out.map((a) => a.name.toLowerCase()));
  const carried = new Set(
    Array.from(options.carriedElsewhere ?? []).map((n) => n.toLowerCase()),
  );
  const missingRequired: PreflightNote[] = schema
    .filter((f) => f.required
      && !present.has(f.name.toLowerCase())
      && !carried.has(f.name.toLowerCase()))
    .map((f) => ({
      attribute: f.name,
      label:     f.label,
      reason:    "missing_required" as const,
      detail:    `${f.label} is required by this category`,
    }));

  return { attributes: out, notes: [...notes, ...missingRequired], missingRequired };
}

/** One-line summary for logs. Empty when nothing was changed or flagged. */
export function summarisePreflight(result: PreflightResult): string {
  if (result.notes.length === 0) return "";
  const counts = new Map<PreflightReason, number>();
  for (const n of result.notes) counts.set(n.reason, (counts.get(n.reason) ?? 0) + 1);
  return Array.from(counts.entries()).map(([reason, n]) => `${reason}=${n}`).join(" ");
}
