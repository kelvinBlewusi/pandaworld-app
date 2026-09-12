import type { JumiaAttributeDef } from "@/components/jumia/SchemaField";

/**
 * Names of fields rendered as static (non-schema-driven) UI at the top of a
 * listing form — primarily `name` / `title`. Callers exclude these from
 * SchemaForm so the dedicated Product Name input isn't duplicated.
 *
 * Shared by the full editor (app/(main)/listings/[id]/review/review-client.tsx)
 * and the simpler WhatsApp focused editor (components/extension/whatsapp-focused-editor.tsx)
 * so the two never drift apart on what "the title field" means.
 */
export const STATIC_FIELDS = ["name", "title", "product_name"];

/**
 * Universal fields — guaranteed fallback injections for fields Jumia
 * *requires* even when its per-category schema omits them (some legacy
 * categories return minimal schemas). Brand is the canonical example:
 * Jumia rejects pushes without it but doesn't always list it in
 * /catalog/attribute-sets.
 *
 * EVERYTHING ELSE comes from Jumia's live schema. If Jumia doesn't ask for
 * it in this category, we don't show it — matches Vendor Center exactly.
 * When Jumia DOES return one of these names for the chosen category, the
 * live attribute wins via the canonicalKey dedup in SchemaForm.
 */
export function universalInfoFields(): JumiaAttributeDef[] {
  return [
    { name: "brand",       label: "Brand",                type: "string",   allowed_values: [], required: true,  is_variant: false, min_length: null, max_length: null },
    { name: "description", label: "Product description",  type: "textarea", allowed_values: [], required: true,  is_variant: false, min_length: 50,   max_length: 9000 },
    { name: "highlights",  label: "Highlights",           type: "textarea", allowed_values: [], required: false, is_variant: false, min_length: null, max_length: null },
  ];
}
