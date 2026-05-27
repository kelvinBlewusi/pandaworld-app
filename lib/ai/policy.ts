/**
 * AI listing policy constants — kept in a regular module (not "use server")
 * so they can be imported by both server actions and client components.
 *
 * Two layers of policy here:
 *
 *   1. SELLER_REQUIRED_FIELDS / SELLER_REQUIRED_ATTR_KEYS — fields the
 *      AI must NEVER auto-fill. These carry legal / commercial / inventory
 *      risk if the AI gets them wrong (price, certifications, GTIN, etc.).
 *
 *   2. AI_DEFAULTS — fields the AI fills with a stable default value
 *      unless the seller's AI-chat context (userContext) overrides it.
 *      Removes friction during onboarding (sellers don't have to type
 *      "warranty: none" 100 times) while still letting them override
 *      per-listing when they want a real warranty.
 *
 * Updating: change a default below and every Pass A / Pass C call picks
 * it up on the next run, no prompt-string edits needed elsewhere.
 */

// ─── Fields the AI MUST NEVER fill ──────────────────────────────────────────
//
// Why each:
//   - selling_price: pricing decisions are commercial and per-seller; AI
//     guessing a price risks underpricing the seller's margin.
//   - warranty_type: enum (manufacturer / seller / no-warranty) carries
//     legal weight — seller picks consciously.
//   - certifications: regulatory claims (CE / FDA / ISO) — false claim is
//     illegal in many jurisdictions.

export const SELLER_REQUIRED_FIELDS = new Set<string>([
  "selling_price",
  "warranty_type",
  "certifications",
]);

// Dynamic-attribute keys that should never be filled by AI — these are
// inventory identifiers (barcodes, SKUs) and pricing fields that the
// seller's ERP / Jumia store manages, not the AI.
export const SELLER_REQUIRED_ATTR_KEYS = new Set<string>([
  "gtin", "gtin_barcode", "barcode_ean", "ean", "upc",
  "sku", "seller_sku", "parent_sku",
  "price", "sale_price", "global_price",
  "stock", "quantity",
]);

// Brand has special handling — allowed only at high confidence (logo visible)
export const BRAND_CONFIDENCE_THRESHOLD = 0.9;

// ─── Default values the AI fills unless userContext overrides ───────────────
//
// The AI prompt instructs Gemini to:
//   - Set warranty_duration / warranty_text / warranty_address to the
//     defaults below UNLESS the seller's AI-chat context mentions a
//     specific warranty (e.g. "12 month warranty, contact +233...").
//   - Pick production_country based on general knowledge (e.g. "China"
//     for unbranded electronics, "Ghana" for hand-made local goods).
//     If the seller's AI-chat context names a country, use that instead.
//   - Set product_note + from_the_manufacturer in dynamic_attributes
//     to the defaults below unless the AI-chat content overrides.
//
// Why these specific defaults:
//   - "None" + "N/A" — Jumia accepts both as legitimate "seller does not
//     offer this" values, so the listing passes QC without forcing the
//     seller through a 4-field warranty form they don't need.
//   - product_note text — pre-vetted Ghanaian seller copy that nudges
//     post-delivery reviews. Sellers can override per-listing if they
//     have a specific message.
//   - from_the_manufacturer = "N/A" — a default the seller can override
//     via AI-chat when they ARE the manufacturer.

export const AI_FIELD_DEFAULTS = {
  warranty_duration: "None",
  warranty_text:     "N/A",
  warranty_address:  "N/A",
  // production_country is intentionally NOT a static default — the AI
  // picks based on visible logos, packaging text, and product category.
} as const;

/**
 * Default attribute values the AI puts into `dynamic_attributes` on
 * every fresh fill. Jumia's attribute-mapping system silently drops
 * keys the category doesn't accept, so it's safe to set these
 * unconditionally — categories that don't use them will ignore them,
 * and categories that DO use them will pick up sensible defaults.
 */
export const AI_DYNAMIC_ATTR_DEFAULTS: Record<string, string> = {
  product_note:
    "Dear Customer, once you receive your item, please take a moment to " +
    "share your feedback and leave a review. Your honest review helps " +
    "other buyers make confident decisions and helps us keep improving. " +
    "Thank you for shopping with us!",
  // ALWAYS populated — Jumia's "What's in the Box" field is a buyer-trust
  // signal that converts. Sellers forget to fill it; the AI shouldn't.
  // The Pass A / combined prompt is instructed to override this default
  // with a real, product-specific item list (e.g. "1× Smartphone, 1× USB-C
  // cable, 1× User manual"). This generic fallback only ships when the
  // model fails to fill it for whatever reason — better than empty.
  what_is_in_the_box:
    "1× Product unit and any standard accessories shown in the images. " +
    "Please refer to the product description and highlights for full details.",
  from_the_manufacturer: "N/A",
};

// ─── Pattern-based universal attribute defaults ─────────────────────────────
//
// Phase 1 of the "user enters price → submits" plan.
//
// After Pass C / combined B+C fills the category-specific attributes,
// we walk the category's schema. For any REQUIRED attribute that's STILL
// empty after the AI pass, we try to match its name or label against the
// pattern list below. If a pattern matches, we pick a default value —
// either a literal string OR (when the attribute has an allowed_values
// enum) the best-matching enum value picked by the `resolve` function.
//
// Order matters — first matching pattern wins.
//
// Why this exists: the AI is conservative; it leaves "Skin Type", "Season",
// "Gender" etc. empty whenever it can't 100% determine the right answer
// from the image. For most cosmetics / clothing / general products there's
// a sensible "all" / "unisex" / "standard" option in the allowed list that
// keeps Jumia happy and lets the seller bypass another form field.

export interface PatternDefault {
  patterns: RegExp[];
  /**
   * Pick a default value. Receives the attribute's allowed_values list
   * (empty array if the attribute is free-text) and returns either a
   * string default OR null to skip this pattern.
   */
  resolve: (allowedValues: string[]) => string | null;
}

export const AI_DYNAMIC_ATTR_PATTERN_DEFAULTS: PatternDefault[] = [
  {
    patterns: [/skin[\s_-]?type/i],
    resolve: (allowed) =>
      allowed.find((v) => /^all/i.test(v)) ??
      allowed.find((v) => /normal/i.test(v)) ??
      (allowed.length === 0 ? "All Skin Types" : null),
  },
  {
    patterns: [/hair[\s_-]?type/i],
    resolve: (allowed) =>
      allowed.find((v) => /^all/i.test(v)) ??
      (allowed.length === 0 ? "All Hair Types" : null),
  },
  {
    patterns: [/season/i],
    resolve: (allowed) =>
      allowed.find((v) => /all\s*seasons?/i.test(v)) ??
      allowed.find((v) => /year.*round/i.test(v)) ??
      (allowed.length === 0 ? "All Seasons" : null),
  },
  {
    patterns: [/^gender$/i, /target[\s_-]?gender/i],
    resolve: (allowed) =>
      allowed.find((v) => /unisex/i.test(v)) ??
      (allowed.length === 0 ? "Unisex" : null),
  },
  {
    patterns: [/age[\s_-]?group/i, /target[\s_-]?age/i, /^age$/i],
    resolve: (allowed) =>
      allowed.find((v) => /^adults?$/i.test(v)) ??
      allowed.find((v) => /adult/i.test(v)) ??
      (allowed.length === 0 ? "Adults" : null),
  },
  {
    patterns: [/^size$/i, /^sizes$/i, /clothing[\s_-]?size/i, /apparel[\s_-]?size/i],
    resolve: (allowed) =>
      allowed.find((v) => /one\s*size/i.test(v)) ??
      allowed.find((v) => /^(m|medium|standard)$/i.test(v)) ??
      (allowed.length === 0 ? "Standard" : null),
  },
  {
    patterns: [/size[\s_-]?(l|w|h|width|length|height|depth)/i, /dimensions?/i, /^(l_w_h|lwh)$/i],
    resolve: () => "Standard",       // free-text size fields → "Standard"
  },
  {
    patterns: [/^product[\s_-]?line$/i],
    resolve: (allowed) =>
      allowed.find((v) => /^standard$/i.test(v)) ??
      allowed.find((v) => /^classic$/i.test(v)) ??
      (allowed[0] ?? "Standard"),
  },
  {
    patterns: [/^style$/i, /design[\s_-]?style/i],
    resolve: (allowed) =>
      allowed.find((v) => /^classic$/i.test(v)) ??
      allowed.find((v) => /^standard$/i.test(v)) ??
      (allowed[0] ?? "Classic"),
  },
  {
    patterns: [/^pattern$/i],
    resolve: (allowed) =>
      allowed.find((v) => /^plain$/i.test(v)) ??
      allowed.find((v) => /^solid$/i.test(v)) ??
      (allowed[0] ?? "Plain"),
  },
  {
    patterns: [/^occasion$/i, /event[\s_-]?type/i],
    resolve: (allowed) =>
      allowed.find((v) => /casual/i.test(v)) ??
      allowed.find((v) => /everyday/i.test(v)) ??
      (allowed[0] ?? "Casual"),
  },
  {
    patterns: [/^fit$/i, /^cut$/i],
    resolve: (allowed) =>
      allowed.find((v) => /regular/i.test(v)) ??
      allowed.find((v) => /^standard$/i.test(v)) ??
      (allowed[0] ?? "Regular"),
  },
  {
    patterns: [/finish/i, /^texture$/i],
    resolve: (allowed) =>
      allowed.find((v) => /matte/i.test(v)) ??
      allowed.find((v) => /smooth/i.test(v)) ??
      (allowed[0] ?? null),
  },
  {
    patterns: [/care[\s_-]?instructions?/i],
    resolve: () => "Refer to product label",
  },
  {
    patterns: [/origin[\s_-]?country/i, /country[\s_-]?of[\s_-]?origin/i],
    resolve: () => "China",          // safest neutral default for unbranded electronics
  },
];

/**
 * Resolve a pattern-based default for the given attribute.
 * Returns null if no pattern matches OR the resolver returns null.
 */
export function resolvePatternDefault(
  attr: { name: string; label: string; allowed_values: string[] },
): string | null {
  const name = attr.name;
  const label = attr.label;
  for (const def of AI_DYNAMIC_ATTR_PATTERN_DEFAULTS) {
    const hit = def.patterns.some((p) => p.test(name) || p.test(label));
    if (!hit) continue;
    const value = def.resolve(attr.allowed_values);
    if (value) return value;
  }
  return null;
}
