export type ListingStatus =
  | "draft"
  | "processing"
  | "pending_approval"
  | "live"
  | "failed";

export interface Database {
  public: {
    Tables: {
      listings: {
        Row: {
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
        };
        Insert: Omit<
          Database["public"]["Tables"]["listings"]["Row"],
          "id" | "created_at" | "updated_at"
        > &
          Partial<
            Pick<
              Database["public"]["Tables"]["listings"]["Row"],
              "id" | "created_at" | "updated_at"
            >
          >;
        Update: Partial<Database["public"]["Tables"]["listings"]["Insert"]>;
      };
      variants: {
        Row: {
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
        };
        Insert: Omit<
          Database["public"]["Tables"]["variants"]["Row"],
          "id" | "created_at"
        > &
          Partial<
            Pick<
              Database["public"]["Tables"]["variants"]["Row"],
              "id" | "created_at"
            >
          >;
        Update: Partial<Database["public"]["Tables"]["variants"]["Insert"]>;
      };
      stores: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          marketplace: string;
          seller_id: string | null;
          status: "connected" | "disconnected" | "pending";
          listings_count: number;
          created_at: string;
        };
        Insert: Omit<
          Database["public"]["Tables"]["stores"]["Row"],
          "id" | "created_at"
        > &
          Partial<
            Pick<
              Database["public"]["Tables"]["stores"]["Row"],
              "id" | "created_at"
            >
          >;
        Update: Partial<Database["public"]["Tables"]["stores"]["Insert"]>;
      };
    };
  };
}

// Convenience row types
export type ListingRow = Database["public"]["Tables"]["listings"]["Row"];
export type VariantRow = Database["public"]["Tables"]["variants"]["Row"];
export type StoreRow = Database["public"]["Tables"]["stores"]["Row"];
