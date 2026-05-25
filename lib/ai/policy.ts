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
    "Dear Customer, once your order arrives, please take a moment or two " +
    "to share your feedback. Your input is extremely valuable to me. We " +
    "review all suggestions carefully to make the necessary improvements. " +
    "Thank you sincerely.",
  from_the_manufacturer: "N/A",
};
