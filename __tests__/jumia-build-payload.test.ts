/**
 * buildJumiaPayload's push-boundary gates (lib/jumia/api.ts) — fixes 3 and
 * 7 from the reject-catalogue pass:
 *
 *   - Fail closed when a category resolved but its attribute schema came
 *     back empty, rather than passing every attribute through unchecked
 *     (preflightAttributes' own leniency for "we never fetched a schema"
 *     is correct for a validator but wrong at the actual push boundary).
 *   - The restricted-words / prohibited-catalog last-mile gate
 *     (assertListingReady, lib/jumia/listing-ready.ts) runs before the
 *     built payload is handed back for POSTing.
 */

import { buildJumiaPayload } from "@/lib/jumia/api";
import type { ListingRow } from "@/lib/supabase/types";

jest.mock("@/lib/jumia/categories", () => ({
  getCategoryAttributes: jest.fn(),
  getVariantAxes: jest.fn(async () => []),
}));
jest.mock("@/lib/jumia/brands", () => ({
  findBrandExact: jest.fn(async () => null),
}));

import { getCategoryAttributes } from "@/lib/jumia/categories";

const mockGetCategoryAttributes = getCategoryAttributes as jest.Mock;

const realFetch = global.fetch;
beforeEach(() => {
  // resolveBrand's live-API fallback — never actually reached by these
  // tests (brand is always null below, which short-circuits before any
  // fetch), but stubbed so a real network call is never attempted if that
  // changes.
  global.fetch = jest.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch;
});
afterEach(() => {
  global.fetch = realFetch;
  jest.clearAllMocks();
});

const baseListing: ListingRow = {
  id: "listing-1", user_id: "user-1", sku: "SKU-1",
  title: "A Perfectly Ordinary Product Title For Testing",
  description: "A description long enough to pass the fifty character minimum Jumia requires for every listing.",
  highlights: null, brand: null,
  category_id: null, category_path: "Home & Living > Kitchen", category_code: "500001",
  color: null, color_family: null, weight_kg: null, main_material: null, material_family: null,
  production_country: null, warranty_duration: null, warranty_type: null, warranty_text: null,
  warranty_address: null, model: null, product_line: null,
  size_l: null, size_w: null, size_h: null, certifications: null, youtube_id: null,
  images: ["https://example.com/1.jpg"],
  image_variants: null,
  status: "draft", selling_price: 100,
  sale_price: null, sale_start_date: null, sale_end_date: null,
  commission_rate: null, jumia_ref: null, jumia_error: null, jumia_synced_at: null,
  dynamic_attributes: null, field_sources: null,
  user_prompt: null, quality_score: null, quantity: 5,
  update_feed_ref: null, update_feed_status: null,
  whatsapp_batch_id: null, whatsapp_seq: null,
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
};

describe("buildJumiaPayload — fail closed on an empty (unsynced) schema", () => {
  it("refuses to build a payload when the category resolved but its schema is empty", async () => {
    mockGetCategoryAttributes.mockResolvedValue([]);
    const built = await buildJumiaPayload("token", baseListing, [], "GHS", "GH");
    expect(built.error).toMatch(/JUMIA_NO_SCHEMA/);
    expect(built.products).toEqual([]);
  });

  it("builds normally once the schema actually has entries", async () => {
    mockGetCategoryAttributes.mockResolvedValue([
      { name: "color_family", label: "Colour", type: "select", allowed_values: [], required: false, is_variant: false },
    ]);
    const built = await buildJumiaPayload("token", baseListing, [], "GHS", "GH");
    expect(built.error).toBeUndefined();
    expect(built.products.length).toBe(1);
  });
});

describe("buildJumiaPayload — last-mile restricted-words gate", () => {
  beforeEach(() => {
    mockGetCategoryAttributes.mockResolvedValue([
      { name: "color_family", label: "Colour", type: "select", allowed_values: [], required: false, is_variant: false },
    ]);
  });

  it("strips a restricted word from the description and reports the adjustment, rather than blocking", () => {
    return (async () => {
      const listing = { ...baseListing, description: `${baseListing.description} This is a brand new item, original packaging.` };
      const built = await buildJumiaPayload("token", listing, [], "GHS", "GH");
      expect(built.error).toBeUndefined();
      expect(JSON.stringify(built.products[0].description)).not.toMatch(/brand new|original/i);
      expect(built.adjustments.join(" ")).toMatch(/restricted word/);
    })();
  });
});
