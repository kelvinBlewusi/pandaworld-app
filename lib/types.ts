// Shared display type used by ListingTable — works with both mock data and DB rows
export type ListingStatus =
  | "draft"
  | "processing"
  | "pending_approval"
  | "live"
  | "failed";

export type Marketplace = "jumia" | "shopify" | "ebay" | "amazon";

export interface ListingDisplay {
  id: string;
  sku: string;
  title: string;
  status: ListingStatus;
  thumbnail: string;        // first image URL or placeholder
  category: string;         // display label
  price: number | null;
  lastUpdated: string;      // ISO string
  marketplace: Marketplace;
  jumia_ref: string | null; // feedId — used for status polling
  jumia_error: string | null;
  quantity: number;
  update_feed_ref:    string | null;
  update_feed_status: string | null;
}

// Map a Supabase ListingRow → ListingDisplay
import type { ListingRow } from "@/lib/supabase/types";

export function toListingDisplay(row: ListingRow): ListingDisplay {
  return {
    id: row.id,
    sku: row.sku,
    title: row.title ?? "Untitled listing",
    status: row.status as ListingStatus,
    thumbnail:
      row.images?.[0] ??
      "https://placehold.co/80x80/f4f4f5/a1a1aa?text=?",
    category: row.category_path ?? row.category_id ?? "Uncategorised",
    price: row.selling_price ? Number(row.selling_price) : null,
    lastUpdated: row.updated_at,
    marketplace: "jumia" as Marketplace,
    jumia_ref:          row.jumia_ref          ?? null,
    jumia_error:        row.jumia_error        ?? null,
    quantity:           row.quantity           ?? 1,
    update_feed_ref:    row.update_feed_ref    ?? null,
    update_feed_status: row.update_feed_status ?? null,
  };
}
