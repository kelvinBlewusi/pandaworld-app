/**
 * Shared variant-row shape — the client-side working state for a listing's
 * variant matrix, before it's mapped to the `variants` DB table
 * (replaceVariantsForListing) or a Jumia push payload. Used by both the
 * full multi-variant editor (app/(main)/listings/[id]/review/review-client.tsx)
 * and the WhatsApp focused editor (components/extension/whatsapp-focused-editor.tsx)
 * so the two stay in lockstep rather than drifting apart.
 */
export interface VariantRow {
  id: string;
  axes: Record<string, string>;
  /**
   * User-facing variation label. Pre-filled from axes (e.g. "Black / 64GB")
   * but freely editable for sellers who don't use axes — they can type
   * "Pack of 6" or "Large" directly.
   */
  variation: string;
  sellerSku: string;
  gtin: string;
  quantity: string;
  globalPrice: string;
  salePrice: string;
  saleStartDate: string;
  saleEndDate: string;
}

/** One active variant axis (e.g. Color) plus which of its allowed values are selected. */
export interface AxisDef {
  name: string;
  label: string;
  values: string[];
  allowedValues: string[];
}
