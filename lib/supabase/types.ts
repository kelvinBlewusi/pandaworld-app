export type ListingStatus =
  | "draft"
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
  status: ListingStatus;
  selling_price: number | null;
  commission_rate: number | null;
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

export type ListingInsert = Omit<ListingRow, "id" | "created_at" | "updated_at"> & {
  id?: string;
  created_at?: string;
  updated_at?: string;
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
