/**
 * AI listing policy constants — kept in a regular module (not "use server")
 * so they can be imported by both server actions and client components.
 *
 * Per the PDF restructuring spec: the AI must NEVER auto-fill these fields
 * from images alone. They carry legal/commercial risk if wrong. Sellers
 * supply them manually.
 */

// Core listing fields the AI must always leave null
export const SELLER_REQUIRED_FIELDS = new Set<string>([
  "model",
  "selling_price",
  "warranty_duration",
  "warranty_type",
  "warranty_address",
  "warranty_text",
  "production_country",
  "certifications",
]);

// Dynamic-attribute keys that should never be filled by AI
export const SELLER_REQUIRED_ATTR_KEYS = new Set<string>([
  "gtin", "gtin_barcode", "barcode_ean", "ean", "upc",
  "sku", "seller_sku", "parent_sku",
  "price", "sale_price", "global_price",
  "stock", "quantity",
]);

// Brand has special handling — allowed only at high confidence (logo visible)
export const BRAND_CONFIDENCE_THRESHOLD = 0.9;
