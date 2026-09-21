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
  getCategoryAttributes:   jest.fn(),
  getVariantAxes:          jest.fn(async () => []),
  getCategoryByCode:       jest.fn(async () => null),
  fetchAttributesFromJumia: jest.fn(),
  upsertAttributes:        jest.fn(),
}));
jest.mock("@/lib/jumia/brands", () => ({
  findBrandExact: jest.fn(async () => null),
}));

import { getCategoryAttributes, getCategoryByCode, fetchAttributesFromJumia, upsertAttributes } from "@/lib/jumia/categories";

const mockGetCategoryAttributes    = getCategoryAttributes as jest.Mock;
const mockGetCategoryByCode        = getCategoryByCode as jest.Mock;
const mockFetchAttributesFromJumia = fetchAttributesFromJumia as jest.Mock;
const mockUpsertAttributes         = upsertAttributes as jest.Mock;

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

  it("fetches the schema live and caches it, rather than failing closed, when nobody has ever pushed to this category before", async () => {
    // The cache read (getCategoryAttributes) comes back empty — nobody has
    // ever selected this category before — but the category itself is
    // real and listable (has an attribute_set_sid), so a live fetch
    // should succeed instead of the seller being told to manually re-pick
    // it. Confirmed live, 2026-09-20: three products in one 20-product
    // batch failed exactly this way.
    mockGetCategoryAttributes.mockResolvedValue([]);
    mockGetCategoryByCode.mockResolvedValue({ code: 500001, attribute_set_sid: "sid-live-fetch" });
    mockFetchAttributesFromJumia.mockResolvedValue([
      { name: "color_family", label: "Colour", type: "select", allowed_values: [], required: false, is_variant: false },
    ]);

    const built = await buildJumiaPayload("token", baseListing, [], "GHS", "GH");

    expect(built.error).toBeUndefined();
    expect(built.products.length).toBe(1);
    expect(mockFetchAttributesFromJumia).toHaveBeenCalledWith("token", "sid-live-fetch");
    expect(mockUpsertAttributes).toHaveBeenCalledWith(500001, expect.any(Array));
  });

  it("still fails closed when the on-demand fetch also comes up empty", async () => {
    mockGetCategoryAttributes.mockResolvedValue([]);
    mockGetCategoryByCode.mockResolvedValue({ code: 500001, attribute_set_sid: "sid-live-fetch" });
    mockFetchAttributesFromJumia.mockResolvedValue([]);

    const built = await buildJumiaPayload("token", baseListing, [], "GHS", "GH");

    expect(built.error).toMatch(/JUMIA_NO_SCHEMA/);
    expect(built.products).toEqual([]);
  });
});

describe("buildJumiaPayload — preflightNotes surfaces raw, reason-tagged notes", () => {
  // Confirms the plumbing added for lib/whatsapp/readiness.ts's Ready/Held
  // assessor end to end, through the REAL buildAttributes/preflightAttributes
  // path (not a mock) — a caller deciding Ready vs Held needs the raw
  // .reason tag; `adjustments` alone has already turned it into a sentence
  // for a seller, losing the distinction between "harmless repair" and
  // "this got dropped and the seller should know before submitting".
  it("carries a decimal_mismatch_blocked note for a whole-number-only attribute given a fraction", async () => {
    mockGetCategoryAttributes.mockResolvedValue([
      { name: "capacity_litres", label: "Capacity (L)", type: "number", allowed_values: [], required: false, is_variant: false, decimal_places: 0 },
    ]);
    const listing = { ...baseListing, dynamic_attributes: { capacity_litres: "1.8" } };
    const built = await buildJumiaPayload("token", listing, [], "GHS", "GH");

    expect(built.error).toBeUndefined();
    const note = built.preflightNotes.find((n) => n.attribute === "capacity_litres");
    expect(note?.reason).toBe("decimal_mismatch_blocked");
    // Dropped from the actual payload, not merely flagged.
    expect(built.products[0].attributes.some((a: { name: string }) => a.name === "capacity_litres")).toBe(false);
  });

  it("carries no preflightNotes at all for a clean push", async () => {
    mockGetCategoryAttributes.mockResolvedValue([
      { name: "color_family", label: "Colour", type: "select", allowed_values: [], required: false, is_variant: false },
    ]);
    const built = await buildJumiaPayload("token", baseListing, [], "GHS", "GH");
    expect(built.preflightNotes).toEqual([]);
  });

  // Real category schema, category 1022979 "Coffee, Tea & Espresso
  // Appliances" (staging canary, 2026-09-21) — declares six capacity-shaped
  // fields. dynamic_attributes for the actual live listing carried NONE of
  // them; "1.8L" only ever existed as prose in the title/description. This
  // is a genuinely different gap from the one above: nothing was dropped
  // by preflight, because nothing capacity-shaped was ever built in the
  // first place for preflight to see — proving lib/whatsapp/readiness.ts's
  // "no attribute named capacity* anywhere in the built payload" check has
  // real data to detect, not just a hypothetical.
  it("builds no capacity-shaped attribute at all when dynamic_attributes never captured one, even though the schema declares six", async () => {
    mockGetCategoryAttributes.mockResolvedValue([
      { name: "capacity",         label: "Capacity",         type: "number", allowed_values: [], required: false, is_variant: false, decimal_places: 0, not_zero_or_negative: true },
      { name: "capacity_kg",      label: "Capactity KG",     type: "number", allowed_values: [], required: false, is_variant: false, decimal_places: 0 },
      { name: "capacity_kva",     label: "Capacity KVA",     type: "number", allowed_values: [], required: false, is_variant: false, decimal_places: 0 },
      { name: "capacity_liter",   label: "Capacity Liter",   type: "number", allowed_values: [], required: false, is_variant: false, decimal_places: 0, not_zero_or_negative: true },
      { name: "capacity_litres",  label: "Capacity Litres",  type: "string", allowed_values: [], required: false, is_variant: false },
      { name: "capacity_slices",  label: "Capacity Slices",  type: "string", allowed_values: [], required: false, is_variant: false },
      { name: "color_family",     label: "Color family",     type: "select", allowed_values: [], required: false, is_variant: false },
      { name: "manufacturer_txt", label: "From the Manufacturer", type: "textarea", allowed_values: [], required: false, is_variant: false },
    ]);
    const listing = {
      ...baseListing,
      title: "Electric Kettle - 1.8L Capacity",
      dynamic_attributes: { color: "Silver", color_family: "Silver", product_weight: "1.2", manufacturer_txt: "N/A" },
    };
    const built = await buildJumiaPayload("token", listing, [], "GHS", "GH");

    expect(built.error).toBeUndefined();
    expect(built.preflightNotes).toEqual([]); // nothing to drop — nothing capacity-shaped was ever built
    expect(built.products[0].attributes.some((a: { name: string }) => /capacity/i.test(a.name))).toBe(false);
  });

  // Real category schema, category 1012714 "... Tee" (staging canary round
  // 2, 2026-09-21): the category's true is_variant field is "size", not
  // "variation". PER_VARIANT_ATTRIBUTE_NAMES (lib/jumia/api.ts) only ever
  // treats the literal name "variation" as per-variant, so "size" goes out
  // through the generic dynamic_attributes loop as ONE static top-level
  // attribute — then base.attributes is spread unchanged into every
  // variant product, so all three variants ship the exact same "size"
  // value regardless of their own, correctly-per-variant `variation`. This
  // is the confirmed source of the false "✅ Ready" the canary caught; it's
  // reused here as the ground truth lib/whatsapp/readiness.ts's
  // staleDuplicateVariantAttribute is written against.
  it("duplicates a non-'variation' is_variant field identically across every variant, disagreeing with two of the three", async () => {
    mockGetCategoryAttributes.mockResolvedValue([
      { name: "size", label: "Size", type: "enum", allowed_values: ["S", "M", "L", "XL"], required: true, is_variant: true },
      { name: "manufacturer_txt", label: "From the Manufacturer", type: "textarea", allowed_values: [], required: false, is_variant: false },
    ]);
    const listing = { ...baseListing, dynamic_attributes: { size: "M" } };
    const variants = ["M", "L", "XL"].map((v, i) => ({
      id: `v${i}`, listing_id: "listing-1", variation: v, seller_sku: `SKU-1-${v}`,
      gtin: null, quantity: 1, global_price: null, sale_price: null,
      sale_start_date: null, sale_end_date: null, created_at: "2026-01-01T00:00:00Z",
    }));

    const built = await buildJumiaPayload("token", listing, variants, "GHS", "GH");

    expect(built.error).toBeUndefined();
    expect(built.products.map((p) => p.variation)).toEqual(["M", "L", "XL"]);
    const sizeValues = built.products.map(
      (p) => p.attributes.find((a: { name: string }) => a.name === "size")?.value,
    );
    expect(sizeValues).toEqual(["M", "M", "M"]);
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
