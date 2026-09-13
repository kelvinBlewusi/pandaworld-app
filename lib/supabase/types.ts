export type ListingStatus =
  | "draft"
  | "awaiting_review"
  | "processing"
  | "pending_approval"
  | "live"
  | "failed";

// ─── Row types ────────────────────────────────────────────────────────────────

export interface ListingRow {
  id: string;
  user_id: string;
  sku: string;
  title: string | null;
  description: string | null;
  highlights: string | null;
  brand: string | null;
  category_id: string | null;
  category_path: string | null;
  category_code: string | null;
  color: string | null;
  color_family: string | null;
  weight_kg: number | null;
  main_material: string | null;
  material_family: string | null;
  production_country: string | null;
  warranty_duration: string | null;
  warranty_type: string | null;
  warranty_text: string | null;
  warranty_address: string | null;
  model: string | null;
  product_line: string | null;
  size_l: number | null;
  size_w: number | null;
  size_h: number | null;
  certifications: string[] | null;
  youtube_id: string | null;
  images: string[];
  /**
   * Gemini-enhanced versions of each original image, keyed by the
   * original URL. Shape: { [originalUrl]: { polish?, rebuild? } }.
   * Written by /api/enhance-images, read by the EnhanceModal. Originals
   * stay in `images` so the seller can revert without re-uploading.
   */
  image_variants: Record<string, { polish?: string; rebuild?: string }> | null;
  status: ListingStatus;
  selling_price: number | null;
  // Listing-level sale price + window — the fallback every variant's own
  // sale_price/sale_start_date/sale_end_date resolves to when unset (see
  // mapListingToJumiaProducts in lib/jumia/api.ts), the same pattern
  // global_price already has via selling_price. Lets a sale price set
  // once (e.g. from a WhatsApp chat message, before any variant row
  // exists) apply to every variant. See migration
  // 2026-09-13_listing-sale-price.sql.
  sale_price: number | null;
  sale_start_date: string | null;
  sale_end_date: string | null;
  commission_rate: number | null;
  jumia_ref: string | null;
  jumia_error: string | null;
  jumia_synced_at: string | null;
  // Category-specific attributes detected by AI and populated in review form
  // e.g. { ram: "8GB", operating_system: "Android", network: "5G" }
  dynamic_attributes: Record<string, string> | null;
  // Tracks which fields came from AI vs user edits — used for per-field AI badges
  field_sources: Record<string, "ai" | "user"> | null;
  // Per-field AI confidence + provenance. Mirrors keys in field_sources.
  //   source ∈ "image" | "ocr" | "inferred" | "seller-required"
  // Used to render coloured indicators in the review form.
  field_confidence?: Record<string, {
    confidence: number;
    source:     "image" | "ocr" | "inferred" | "seller-required";
    reasoning?: string;
  }> | null;
  // Top-3 category picks from AI classification (with confidence). Lets the
  // review page offer a switcher when the primary pick is uncertain.
  category_alternates?: Array<{
    code:       number;
    name:       string;
    path:       string;
    confidence: number;
  }> | null;
  // Free-text instruction the seller typed in the "What do you want in
  // the listing" box. Persisted so re-runs (re-analyze, refill-attributes)
  // honour the same intent without the seller having to retype.
  // See migration 2026-05-26_listing-user-prompt.sql.
  user_prompt: string | null;
  // 0-100 quality score cached on last save
  quality_score: number | null;
  // Stock for simple (non-variant) listings; variant stock is on VariantRow.quantity
  quantity: number;
  // In-flight stock/price update feed (separate from the initial create feed jumia_ref)
  update_feed_ref:    string | null;
  update_feed_status: string | null;  // 'pending' | 'done' | 'error'
  // Jumia productSid + qc.status — populated by cron after feed completes.
  // Required for any post-creation update calls. Only "approved" qc.status
  // allows stock/price/status updates per Jumia API docs.
  jumia_product_sid?:  string | null;
  jumia_qc_status?:    string | null;
  jumia_product_map?:  Record<string, { sid: string | null; qc: string | null }> | null;
  // Set when this listing was created via the WhatsApp chatbot's
  // multi-product batch flow (see lib/whatsapp/intake.ts) — groups every
  // listing from one "how many products?" run and its 1-based position
  // within it. Null for listings created any other way.
  whatsapp_batch_id: string | null;
  whatsapp_seq:      number | null;
  created_at: string;
  updated_at: string;
}

export interface VariantRow {
  id: string;
  listing_id: string;
  variation: string | null;
  seller_sku: string | null;
  gtin: string | null;
  quantity: number;
  global_price: number | null;
  sale_price: number | null;
  sale_start_date: string | null;
  sale_end_date: string | null;
  created_at: string;
}

export interface StoreRow {
  id: string;
  user_id: string;
  name: string;
  marketplace: string;
  seller_id: string | null;
  status: "connected" | "disconnected" | "pending";
  listings_count: number;
  created_at: string;
}

// ─── Insert types ─────────────────────────────────────────────────────────────

export type ListingInsert = Omit<
  ListingRow,
  | "id" | "created_at" | "updated_at"
  | "jumia_ref" | "jumia_error" | "jumia_synced_at"
  | "dynamic_attributes" | "field_sources" | "quality_score"
  | "quantity" | "update_feed_ref" | "update_feed_status"
  | "image_variants" | "user_prompt" | "whatsapp_batch_id" | "whatsapp_seq"
> & {
  id?: string;
  created_at?: string;
  updated_at?: string;
  jumia_ref?: string | null;
  jumia_error?: string | null;
  jumia_synced_at?: string | null;
  dynamic_attributes?: Record<string, string> | null;
  field_sources?: Record<string, "ai" | "user"> | null;
  quality_score?: number | null;
  quantity?: number;
  update_feed_ref?: string | null;
  update_feed_status?: string | null;
  image_variants?: Record<string, { polish?: string; rebuild?: string }> | null;
  user_prompt?: string | null;
  whatsapp_batch_id?: string | null;
  whatsapp_seq?: number | null;
};

export type VariantInsert = Omit<VariantRow, "id" | "created_at"> & {
  id?: string;
  created_at?: string;
};

export type StoreInsert = Omit<StoreRow, "id" | "created_at"> & {
  id?: string;
  created_at?: string;
};

// ─── Database generic (for createClient<Database>) ────────────────────────────

export interface Database {
  public: {
    Tables: {
      listings: {
        Row: ListingRow;
        Insert: ListingInsert;
        Update: Partial<ListingInsert>;
        Relationships: [];
      };
      variants: {
        Row: VariantRow;
        Insert: VariantInsert;
        Update: Partial<VariantInsert>;
        Relationships: [];
      };
      stores: {
        Row: StoreRow;
        Insert: StoreInsert;
        Update: Partial<StoreInsert>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
