/**
 * Generates a sample /feeds/products/create payload exactly as our code would
 * send it. Useful for:
 *   - Pasting into Postman to test against staging manually
 *   - Diffing against the Postman example to spot drift
 *
 * Run: npx ts-node scripts/dump-sample-payload.ts
 *      or
 *      npx tsx scripts/dump-sample-payload.ts
 */

import { mapListingToJumiaProducts } from "@/lib/jumia/api";
import type { ListingRow, VariantRow } from "@/lib/supabase/types";

const SAMPLE_LISTING: ListingRow = {
  id:              "demo-listing-1",
  user_id:         "demo-user",
  sku:             "PA-DEMO-1",
  title:           "Samsung Galaxy A55 5G Smartphone — 128GB Awesome Navy",
  description:     "6.6-inch Super AMOLED 120Hz display with 50MP triple camera and 5000mAh battery. Premium build, all-day battery life, IP67 rated.",
  highlights:      "• 6.6-inch Super AMOLED 120Hz display\n• 50MP triple camera with OIS\n• 5000mAh battery + 25W fast charge\n• IP67 water resistance\n• 5G connectivity",
  brand:           "Samsung",
  category_id:     "10000799",
  category_path:   "Phones & Tablets > Smartphones",
  category_code:   "10000799",
  color:           "Navy Blue",
  color_family:    "Navy Blue",
  weight_kg:       0.213,
  main_material:   "Aluminium",
  material_family: "Metal",
  production_country: "Vietnam",
  warranty_duration: "1 year",
  warranty_type:    "Service Center",
  warranty_text:    "1 year limited warranty",
  warranty_address: "Accra Service Center, Ridge",
  model:            "SM-A556E",
  product_line:     "Galaxy A series",
  size_l: 16.1, size_w: 7.7, size_h: 0.8,
  certifications:   ["CE"],
  youtube_id:       null,
  images: [
    "https://example.com/galaxy-a55-front.jpg",
    "https://example.com/galaxy-a55-back.jpg",
    "https://example.com/galaxy-a55-side.jpg",
  ],
  status:          "draft",
  selling_price:   2199,
  sale_price:      null,
  sale_start_date: null,
  sale_end_date:   null,
  commission_rate: 0.07,
  jumia_ref:       null,
  jumia_error:     null,
  jumia_synced_at: null,
  dynamic_attributes: {
    operating_system: "Android",
    ram:              "8GB",
    internal_memory:  "128GB",
    sim_type:         "Dual SIM",
    network:          "5G",
    display_size:     "6.6 inches",
    battery_capacity: "5000",
  },
  field_sources:    { title: "ai", brand: "ai" },
  quality_score:    85,
  quantity:         10,
  whatsapp_batch_id: null,
  whatsapp_seq:      null,
  update_feed_ref:    null,
  update_feed_status: null,
  image_variants:     null,
  user_prompt:        null,
  created_at: "2025-01-01T00:00:00Z",
  updated_at: "2025-01-01T00:00:00Z",
};

const SAMPLE_VARIANTS: VariantRow[] = [
  {
    id: "v-001", listing_id: SAMPLE_LISTING.id,
    variation: "8GB / 128GB / Navy Blue",
    seller_sku: "PA-DEMO-1-NAVY",
    gtin: "8806094956542",
    quantity: 10,
    global_price: 2199,
    sale_price: 1899,
    sale_start_date: "2025-02-01",
    sale_end_date:   "2025-02-15",
    created_at: "2025-01-01T00:00:00Z",
  },
];

const FAKE_SHOP_ID = "00000000-0000-0000-0000-000000000099";
const FAKE_BRAND   = { code: 1234, name: "Samsung" };

console.log("─".repeat(70));
console.log("SAMPLE PAYLOAD — POST /feeds/products/create");
console.log("─".repeat(70));

const productsSimple = mapListingToJumiaProducts(SAMPLE_LISTING, [], FAKE_BRAND, "GHS");
console.log("\n## Simple listing (no variants)\n");
console.log(JSON.stringify({ shopId: FAKE_SHOP_ID, products: productsSimple }, null, 2));

const productsWithVariants = mapListingToJumiaProducts(SAMPLE_LISTING, SAMPLE_VARIANTS, FAKE_BRAND, "GHS");
console.log("\n## With variants\n");
console.log(JSON.stringify({ shopId: FAKE_SHOP_ID, products: productsWithVariants }, null, 2));

console.log("\n─".repeat(70));
console.log("Copy either of the above into Postman → Vendor API Collection →");
console.log("GPM API → feeds → Create Feed → Body. Set the bearer token from");
console.log("a real OAuth flow. Set baseUrl = https://vendor-api-staging.jumia.com");
console.log("Then click Send to test conformance against the live staging server.");
console.log("─".repeat(70));
