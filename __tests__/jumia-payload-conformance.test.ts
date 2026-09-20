/**
 * Static conformance test for /feeds/products/create payload.
 *
 * Compares the JSON our code generates against the schema published in the
 * official Jumia Vendor API Postman collection
 * (54326324-74bd91a9-6b39-486f-a451-cfededd726cc, "Create Feed" request).
 *
 * Run: npm test
 */

import { mapListingToJumiaProducts, type JumiaProduct } from "@/lib/jumia/api";
import type { ListingRow, VariantRow } from "@/lib/supabase/types";
import type { JumiaCategoryAttribute } from "@/lib/jumia/categories";

// Sale-window dates used below must stay in the future relative to whenever
// this suite actually runs — buildSalePriceField (lib/jumia/api.ts) refuses
// a salePrice whose end date has already passed, so a fixed calendar date
// would silently start failing this suite once "now" caught up to it.
function isoDateOffset(days: number): string {
  return new Date(Date.now() + days * 24 * 3600 * 1000).toISOString().slice(0, 10);
}
const FUTURE_SALE_START   = isoDateOffset(10);
const FUTURE_SALE_END     = isoDateOffset(20);
const FUTURE_SALE_START_2 = isoDateOffset(30);
const FUTURE_SALE_END_2   = isoDateOffset(40);

// ─── Shape of a valid POST /feeds/products/create payload per Postman ───────

interface ExpectedShape {
  required: string[];
  optional?: string[];
}

const PRODUCT_SHAPE: Record<string, ExpectedShape> = {
  // Top-level product object
  root: {
    required: [
      "name", "description", "parentSku", "sellerSku", "variation",
      "brand", "category", "images", "price", "stock", "attributes",
      "barcodeEan",
    ],
    optional: ["gtinBarcode"],   // duplicate of barcodeEan; both sent for safety
  },
  name: { required: ["value", "translations"] },
  description: { required: ["value", "translations"] },
  brand: { required: ["code", "name"] },
  category: { required: ["code", "name"] },
  imageItem: { required: ["url", "primary"] },
  price: { required: ["value", "currency"], optional: ["salePrice"] },
  // startAt/endAt are REQUIRED whenever salePrice is present at all — Jumia
  // rejects a salePrice missing either ("Attribute
  // [Product.Price.SalePrice.StartAt] with invalid value [null]"), and
  // buildSalePriceField (lib/jumia/api.ts) now omits the whole salePrice
  // key rather than ever emitting one without both dates. This used to mark
  // them optional, which is exactly what let the partial shape ship.
  salePrice: { required: ["value", "startAt", "endAt"] },
  attribute: { required: ["name", "value", "translations"] },
};

// ─── Test fixtures ──────────────────────────────────────────────────────────

const sampleListing: ListingRow = {
  id:              "00000000-0000-0000-0000-000000000001",
  user_id:         "user_test",
  sku:             "PA-TEST-1",
  title:           "Samsung Galaxy A55 5G Smartphone — 128GB Awesome Navy",
  description:     "6.6-inch Super AMOLED 120Hz display with 50MP triple camera and 5000mAh battery.",
  highlights:      "• 6.6-inch Super AMOLED display\n• 50MP triple camera\n• 5000mAh battery\n• 5G connectivity",
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
  warranty_duration:  "1 year",
  warranty_type:      "Service Center",
  warranty_text:      "1 year limited warranty",
  warranty_address:   "Accra Service Center",
  model:           "SM-A556E",
  product_line:    "Galaxy A series",
  size_l: 16.1, size_w: 7.7, size_h: 0.8,
  certifications:  ["CE"],
  youtube_id:      null,
  images: [
    "https://example.com/img1.jpg",
    "https://example.com/img2.jpg",
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
  },
  field_sources:   { title: "ai", brand: "ai", color: "ai" },
  quality_score:   85,
  quantity:        10,
  update_feed_ref:    null,
  update_feed_status: null,
  created_at: "2025-01-01T00:00:00Z",
  updated_at: "2025-01-01T00:00:00Z",
};

const sampleVariants: VariantRow[] = [
  {
    id: "v-001", listing_id: sampleListing.id,
    variation: "8GB / 128GB / Navy",
    seller_sku: "PA-TEST-1-NAVY", gtin: "8806094956542",
    quantity: 10, global_price: 2199,
    sale_price: 1899,
    // Must stay in the future relative to whenever this suite runs —
    // buildSalePriceField (lib/jumia/api.ts) refuses a salePrice whose end
    // date has already passed, so a fixed past date would silently start
    // failing these tests once "now" caught up to it.
    sale_start_date: FUTURE_SALE_START,
    sale_end_date:   FUTURE_SALE_END,
    created_at: "2025-01-01T00:00:00Z",
  },
];

const brand = { code: 1234, name: "Samsung" };
const currency = "GHS";

// ─── Helpers ────────────────────────────────────────────────────────────────

function assertHasKeys(obj: unknown, shape: ExpectedShape, path: string) {
  expect(obj).toBeDefined();
  expect(typeof obj).toBe("object");
  const o = obj as Record<string, unknown>;
  for (const key of shape.required) {
    if (!(key in o)) {
      throw new Error(`Missing required field "${path}.${key}". Has: ${Object.keys(o).join(", ")}`);
    }
  }
}

function assertCorrectBarcodeFields(p: JumiaProduct) {
  // Per official spec (PDF page 4) the field is `gtinBarcode`. Postman sample
  // and the live API use `barcodeEan`. We send BOTH for safety since Jumia's
  // own docs disagree. Either way `barcodeEan` MUST be present.
  expect("barcodeEan" in p).toBe(true);
}

// ─── Test cases ─────────────────────────────────────────────────────────────

describe("Jumia /feeds/products/create payload conformance", () => {
  describe("simple (no variants)", () => {
    const products = mapListingToJumiaProducts(sampleListing, [], brand, currency);

    it("returns exactly one product when no variants", () => {
      expect(products).toHaveLength(1);
    });

    it("has all top-level required fields per Postman spec", () => {
      assertHasKeys(products[0], PRODUCT_SHAPE.root, "product");
    });

    it("includes barcodeEan (the live API field name)", () => {
      assertCorrectBarcodeFields(products[0]);
    });

    it("name is { value, translations: [] }", () => {
      assertHasKeys(products[0].name, PRODUCT_SHAPE.name, "product.name");
      expect(Array.isArray(products[0].name.translations)).toBe(true);
    });

    it("description is { value, translations: [] }", () => {
      assertHasKeys(products[0].description, PRODUCT_SHAPE.description, "product.description");
    });

    it("brand is { code: number, name: string }", () => {
      assertHasKeys(products[0].brand, PRODUCT_SHAPE.brand, "product.brand");
      expect(typeof products[0].brand.code).toBe("number");
      expect(typeof products[0].brand.name).toBe("string");
    });

    it("category is { code: number, name: string }", () => {
      assertHasKeys(products[0].category, PRODUCT_SHAPE.category, "product.category");
      expect(typeof products[0].category.code).toBe("number");
    });

    it("price is { value, currency }", () => {
      assertHasKeys(products[0].price, PRODUCT_SHAPE.price, "product.price");
      expect(typeof products[0].price.value).toBe("number");
      expect(typeof products[0].price.currency).toBe("string");
    });

    it("currency reflects the seller's country (GHS for Ghana)", () => {
      expect(products[0].price.currency).toBe("GHS");
    });

    it("each image has { url, primary }", () => {
      expect(products[0].images.length).toBeGreaterThan(0);
      products[0].images.forEach((img: { url: string; primary: boolean }, i: number) => {
        assertHasKeys(img, PRODUCT_SHAPE.imageItem, `product.images[${i}]`);
        expect(typeof img.url).toBe("string");
        expect(typeof img.primary).toBe("boolean");
      });
    });

    it("first image is marked primary, rest are not", () => {
      expect(products[0].images[0].primary).toBe(true);
      products[0].images.slice(1).forEach((img: { primary: boolean }) => {
        expect(img.primary).toBe(false);
      });
    });

    it("each attribute has { name, value, translations: [] }", () => {
      expect(products[0].attributes.length).toBeGreaterThan(0);
      products[0].attributes.forEach((a: { name: string; value: string; translations: unknown[] }, i: number) => {
        assertHasKeys(a, PRODUCT_SHAPE.attribute, `product.attributes[${i}]`);
        expect(Array.isArray(a.translations)).toBe(true);
      });
    });

    it("includes dynamic_attributes as flat name/value pairs", () => {
      const names = products[0].attributes.map((a) => a.name);
      expect(names).toContain("operating_system");
      expect(names).toContain("ram");
      expect(names).toContain("network");
    });

    it("stock is a number", () => {
      expect(typeof products[0].stock).toBe("number");
    });

    it("variation is never an empty string (Jumia requires a non-empty value)", () => {
      // Empty variation triggers Jumia error:
      // "The variation 'variation' value has to be filled in order to create a Product."
      expect(products[0].variation.length).toBeGreaterThan(0);
    });

    it("variation falls back to 'Default' when no color is set", () => {
      const noColorListing: ListingRow = { ...sampleListing, color: null, color_family: null };
      const ps = mapListingToJumiaProducts(noColorListing, [], brand, currency);
      expect(ps[0].variation).toBe("Default");
    });

    it("variation uses color when present (preferred over 'Default')", () => {
      // Sample listing has color "Navy Blue"
      expect(products[0].variation).toBe("Navy Blue");
    });

    // A single SKU cannot have three colours. When the AI sees a product
    // photographed in several colourways it stores them all, and that
    // string used to ship as the variation: observed live on 2026-09-15 as
    // one product whose variation read "Black, Silver, White", which no
    // buyer can choose from. A list means variants the seller hasn't set
    // up yet, not a name for this one.
    it.each([
      "Black, Silver, White",
      "Black and White",
      "Red & Blue",
      "Red/Blue",
    ])("variation falls back to 'Default' rather than shipping the list %p", (color) => {
      const multi: ListingRow = { ...sampleListing, color, color_family: color };
      const ps = mapListingToJumiaProducts(multi, [], brand, currency);
      expect(ps[0].variation).toBe("Default");
    });

    // The guard must not swallow legitimate multi-word colour names.
    it.each(["Navy Blue", "Rose Gold", "Off White", "Sandstone"])(
      "keeps %p, which is one colour that happens to have two words",
      (color) => {
        const single: ListingRow = { ...sampleListing, color, color_family: color };
        const ps = mapListingToJumiaProducts(single, [], brand, currency);
        expect(ps[0].variation).toBe(color);
      },
    );

    it("includes a listing-level sale price when set — the only place one can live with zero variant rows", () => {
      const onSale: ListingRow = { ...sampleListing, sale_price: 1799, sale_start_date: FUTURE_SALE_START_2, sale_end_date: FUTURE_SALE_END_2 };
      const ps = mapListingToJumiaProducts(onSale, [], brand, currency);
      const sp = ps[0].price.salePrice;
      expect(sp).toBeDefined();
      expect(sp!.value).toBe(1799);
      expect(sp!.startAt).toBe(FUTURE_SALE_START_2);
      expect(sp!.endAt).toBe(FUTURE_SALE_END_2);
    });

    it("omits salePrice when no listing-level sale price is set", () => {
      expect(products[0].price.salePrice).toBeUndefined();
    });
  });

  describe("with variants", () => {
    const products = mapListingToJumiaProducts(sampleListing, sampleVariants, brand, currency);

    it("returns one product per variant", () => {
      expect(products).toHaveLength(sampleVariants.length);
    });

    it("each variant carries a parentSku referencing the listing SKU", () => {
      products.forEach((p) => {
        expect(p.parentSku).toBe(sampleListing.sku);
      });
    });

    it("each variant has a unique sellerSku", () => {
      const skus = products.map((p) => p.sellerSku);
      expect(new Set(skus).size).toBe(skus.length);
    });

    it("variant carries barcodeEan with the GTIN from the variant row", () => {
      products.forEach((p) => {
        assertCorrectBarcodeFields(p);
        expect((p as JumiaProduct & { barcodeEan: string }).barcodeEan).toBe("8806094956542");
      });
    });

    it("variant variation field is set from the variant row", () => {
      expect(products[0].variation).toBe("8GB / 128GB / Navy");
    });

    it("variation falls back to a non-empty value when variant row has none", () => {
      const variantWithoutVariation: VariantRow = { ...sampleVariants[0], variation: null };
      const ps = mapListingToJumiaProducts(sampleListing, [variantWithoutVariation], brand, currency);
      expect(ps[0].variation.length).toBeGreaterThan(0);
    });

    // Fix 6 (see lib/jumia/api.ts resolveVariantRowVariation): the
    // variation axis discipline color_family already had must not treat a
    // legitimate composite spec label ("RAM / Storage / Colour", joined by
    // "/") as a list of alternatives — that's a DIFFERENT bug from a
    // colour column holding several colourways.
    it("keeps a composite variation label joined by '/' untouched with no axis schema", () => {
      const ps = mapListingToJumiaProducts(sampleListing, sampleVariants, brand, currency);
      expect(ps[0].variation).toBe("8GB / 128GB / Navy");
    });

    describe("variation snapped to the category's own variant axis", () => {
      const colorAxis: JumiaCategoryAttribute[] = [
        { name: "color_family", label: "Colour", type: "select",
          allowed_values: ["Black", "White", "Gray", "Navy"],
          required: false, is_variant: true },
      ];

      it("maps British 'Grey' to the axis's declared 'Gray' — real rejection: \"Attribute [variation] with invalid value [Grey]\"", () => {
        const greyVariant: VariantRow = { ...sampleVariants[0], variation: "Grey" };
        const ps = mapListingToJumiaProducts(sampleListing, [greyVariant], brand, currency, [], undefined, colorAxis);
        expect(ps[0].variation).toBe("Gray");
      });

      // Real rejection: "Attribute [color_family] with invalid value
      // [Yellow,Red,Orange,White,Blue]" — five individually-valid colours
      // sent as one string. Only refused when the axis PROVES every part is
      // a real stocked option — a value with no axis to check against is
      // left alone (see the composite-label test above).
      it("refuses a comma-joined list where every part is a real stocked colour", () => {
        const multiVariant: VariantRow = { ...sampleVariants[0], variation: "Black,White,Navy" };
        const ps = mapListingToJumiaProducts(sampleListing, [multiVariant], brand, currency, [], undefined, colorAxis);
        expect(ps[0].variation).toBe("Default");
      });

      it("leaves a single axis-valid colour alone", () => {
        const single: VariantRow = { ...sampleVariants[0], variation: "Navy" };
        const ps = mapListingToJumiaProducts(sampleListing, [single], brand, currency, [], undefined, colorAxis);
        expect(ps[0].variation).toBe("Navy");
      });

      // Real rejection, live and repeated (2026-09-19 batch): "Attribute
      // [variation] with invalid value [Navy Blue]" on a Baby Carrier —
      // "Navy Blue" was never one of the category's own colour options,
      // and "Fix & resubmit" kept redrafting and resubmitting the
      // identical value because nothing local ever checked it against the
      // axis. Held now instead of shipped, with the real options named.
      it("holds the push (via blockers) when the value isn't a stocked option and no unambiguous snap exists", () => {
        const unmatched: VariantRow = { ...sampleVariants[0], variation: "Navy Blue" };
        const blockers: string[] = [];
        const ps = mapListingToJumiaProducts(sampleListing, [unmatched], brand, currency, [], undefined, colorAxis, blockers);
        expect(blockers).toHaveLength(1);
        expect(blockers[0]).toMatch(/isn't one of this category's stocked options/);
        expect(blockers[0]).toMatch(/Black, White, Gray, Navy/);
        // The product is still built (the caller decides whether to push it) —
        // blockers is the signal, not a thrown error.
        expect(ps[0].variation).toBe("Navy Blue");
      });

      it("does not block a value that snaps unambiguously (Grey → Gray)", () => {
        const greyVariant: VariantRow = { ...sampleVariants[0], variation: "Grey" };
        const blockers: string[] = [];
        mapListingToJumiaProducts(sampleListing, [greyVariant], brand, currency, [], undefined, colorAxis, blockers);
        expect(blockers).toHaveLength(0);
      });

      it("does not block a value that's already an exact stocked option", () => {
        const single: VariantRow = { ...sampleVariants[0], variation: "Navy" };
        const blockers: string[] = [];
        mapListingToJumiaProducts(sampleListing, [single], brand, currency, [], undefined, colorAxis, blockers);
        expect(blockers).toHaveLength(0);
      });

      it("does not block a composite label with no axis to check against", () => {
        const blockers: string[] = [];
        mapListingToJumiaProducts(sampleListing, sampleVariants, brand, currency, [], undefined, [], blockers);
        expect(blockers).toHaveLength(0);
      });
    });

    it("salePrice is included with startAt/endAt when set", () => {
      const sp = products[0].price.salePrice;
      expect(sp).toBeDefined();
      assertHasKeys(sp, PRODUCT_SHAPE.salePrice, "product.price.salePrice");
      expect(sp!.value).toBe(1899);
      expect(sp!.startAt).toBe(FUTURE_SALE_START);
      expect(sp!.endAt).toBe(FUTURE_SALE_END);
    });

    it("falls back to the listing-level sale price when a variant has none of its own — applies no matter the variant", () => {
      const listingOnSale: ListingRow = { ...sampleListing, sale_price: 1799, sale_start_date: FUTURE_SALE_START_2, sale_end_date: FUTURE_SALE_END_2 };
      const variantWithoutSale: VariantRow = { ...sampleVariants[0], sale_price: null, sale_start_date: null, sale_end_date: null };
      const ps = mapListingToJumiaProducts(listingOnSale, [variantWithoutSale], brand, currency);
      const sp = ps[0].price.salePrice;
      expect(sp).toBeDefined();
      expect(sp!.value).toBe(1799);
      expect(sp!.startAt).toBe(FUTURE_SALE_START_2);
      expect(sp!.endAt).toBe(FUTURE_SALE_END_2);
    });

    it("a variant's own sale price overrides the listing-level fallback", () => {
      const listingOnSale: ListingRow = { ...sampleListing, sale_price: 1799, sale_start_date: FUTURE_SALE_START_2, sale_end_date: FUTURE_SALE_END_2 };
      const ps = mapListingToJumiaProducts(listingOnSale, sampleVariants, brand, currency);
      // sampleVariants[0] already carries its own sale_price: 1899 (see fixture above)
      expect(ps[0].price.salePrice!.value).toBe(1899);
    });

    // The exact bug fix 2 closes: a sale price stated without both dates
    // used to ship as {"value": X} (JSON.stringify drops undefined keys),
    // and Jumia rejected it: "Attribute [Product.Price.SalePrice.StartAt]
    // with invalid value [null]." Now the whole key is omitted instead.
    it("omits salePrice entirely when dates are missing, rather than sending a partial one", () => {
      const variantNoDates: VariantRow = { ...sampleVariants[0], sale_start_date: null, sale_end_date: null };
      const ps = mapListingToJumiaProducts(sampleListing, [variantNoDates], brand, currency);
      expect(ps[0].price.salePrice).toBeUndefined();
    });

    it("omits salePrice when the end date has already passed", () => {
      const pastEnd: VariantRow = { ...sampleVariants[0], sale_start_date: "2020-01-01", sale_end_date: "2020-01-10" };
      const ps = mapListingToJumiaProducts(sampleListing, [pastEnd], brand, currency);
      expect(ps[0].price.salePrice).toBeUndefined();
    });

    it("omits salePrice when it isn't lower than the regular price", () => {
      const notCheaper: VariantRow = { ...sampleVariants[0], sale_price: 2199, global_price: 2199 };
      const ps = mapListingToJumiaProducts(sampleListing, [notCheaper], brand, currency);
      expect(ps[0].price.salePrice).toBeUndefined();
    });
  });

  describe("category code safety", () => {
    it("refuses to build a payload when category_code is missing/zero", () => {
      const noCategoryListing: ListingRow = {
        ...sampleListing,
        category_code: null,
        category_path: null,
        category_id:   null,
      };
      // Should THROW rather than silently sending category: { code: 0, ... }
      expect(() =>
        mapListingToJumiaProducts(noCategoryListing, [], brand, currency)
      ).toThrow(/JUMIA_NO_CATEGORY_CODE/);
    });

    it("refuses to build a payload when category_code is non-numeric", () => {
      const badCategoryListing: ListingRow = {
        ...sampleListing,
        category_code: "cat-mob",            // legacy mock id
        category_path: null,
        category_id:   "cat-mob",
      };
      expect(() =>
        mapListingToJumiaProducts(badCategoryListing, [], brand, currency)
      ).toThrow(/JUMIA_NO_CATEGORY_CODE/);
    });
  });

  describe("payload size sanity", () => {
    it("a single-product payload is well under 1KB compressed", () => {
      const products = mapListingToJumiaProducts(sampleListing, [], brand, currency);
      const json = JSON.stringify({ shopId: "00000000-0000-0000-0000-000000000099", products });
      // Postman docs cap us at 1000 records per feed for size reasons.
      // One realistic product should be ~1–3KB.
      expect(json.length).toBeGreaterThan(200);
      expect(json.length).toBeLessThan(10_000);
    });
  });

  describe("schema diff vs Postman spec", () => {
    it("does not include deprecated/wrong field names", () => {
      const products = mapListingToJumiaProducts(sampleListing, sampleVariants, brand, currency);
      const json = JSON.stringify(products);
      // Common past mistakes — these should NEVER appear in the wire payload
      expect(json).not.toContain("gtin_barcode");
      expect(json).not.toContain("seller_sku");   // snake_case wrong
      expect(json).not.toContain("parent_sku");
      // additionalCategories is officially deprecated per PDF page 5
      expect(json).not.toContain("additionalCategories");
    });

    it("does include the correct field names per spec", () => {
      const products = mapListingToJumiaProducts(sampleListing, [], brand, currency);
      const json = JSON.stringify(products);
      expect(json).toContain('"barcodeEan"');
      expect(json).toContain('"sellerSku"');
      expect(json).toContain('"parentSku"');
      expect(json).toContain('"translations"');
    });
  });

  // Confirmed live on listing eb1e3508: auto-analyze writes TWO different
  // descriptions — rich HTML into listings.description (Pass A) and a
  // plain-text one into dynamic_attributes.description, when the category
  // schema happens to define a "description" attribute. Sending both means
  // Jumia receives two contradictory descriptions for one product, and the
  // attribute copy risks the same "Attribute [x] is not visible for
  // category [y]" rejection that has already failed pushes here.
  describe("duplicate description attribute", () => {
    const withDupe: ListingRow = {
      ...sampleListing,
      description: "<p>The <strong>real</strong> rich-text description that Jumia should show.</p>",
      dynamic_attributes: {
        description:         "A different, plain-text description the AI wrote into the schema attribute.",
        product_description: "Yet another copy under the alias spelling.",
        ram:                 "8 GB",
      },
    };

    const p = mapListingToJumiaProducts(withDupe, [], brand, currency)[0];
    const attrNames = (p.attributes ?? []).map((a) => a.name.toLowerCase());

    it("sends the COLUMN as the product description", () => {
      // description is a translation object ({ value, translations[] }),
      // not a bare string — see buildBaseProduct.
      const value = JSON.stringify(p.description);
      expect(value).toContain("real");
      expect(value).not.toContain("plain-text description");
    });

    it("never sends description as an attribute alongside it", () => {
      expect(attrNames).not.toContain("description");
      expect(attrNames).not.toContain("product_description");
    });

    it("still sends genuine category attributes", () => {
      // The skip must be surgical — dropping real schema attributes would
      // be a much worse bug than the duplicate it fixes.
      expect(attrNames).toContain("ram");
    });

    it("still sends highlights as short_description from the column", () => {
      const short = (p.attributes ?? []).find((a) => a.name === "short_description");
      expect(short?.value).toContain("6.6-inch");
    });
  });

  describe("category-schema attribute sanitisation", () => {
    // Confirmed live: material_family="Fabric" was sent for a category
    // whose material_family enum never contains the literal string
    // "Fabric" (Jumia's real lists use "Textile"/specific fabric names) —
    // Jumia rejected the WHOLE feed over that one mismatched value, with
    // no earlier check catching it.
    const materialFamilySchema: JumiaCategoryAttribute[] = [
      {
        name: "material_family",
        label: "Material family",
        type: "multi",
        allowed_values: ["Textile", "Metal", "Plastic", "Wood", "Canvas"],
        required: false,
        is_variant: false,
      },
    ];

    it("drops an attribute whose value isn't one of the category's allowed_values", () => {
      const listing = { ...sampleListing, material_family: "Fabric" };
      const products = mapListingToJumiaProducts(listing, [], brand, currency, materialFamilySchema);
      const names = products[0].attributes.map((a) => a.name);
      expect(names).not.toContain("material_family");
    });

    it("keeps an attribute whose value IS one of the category's allowed_values", () => {
      const listing = { ...sampleListing, material_family: "Metal" };
      const products = mapListingToJumiaProducts(listing, [], brand, currency, materialFamilySchema);
      const attr = products[0].attributes.find((a) => a.name === "material_family");
      expect(attr?.value).toBe("Metal");
    });

    it("sends the SCHEMA's spelling, not the seller's, on a case near-miss", () => {
      // Previously this matched case-insensitively but sent the seller's
      // own casing ("metal"). Jumia's own comparison may not be as
      // forgiving as ours, and we know the exact string it accepts — so
      // send that one.
      const listing = { ...sampleListing, material_family: "metal" };
      const products = mapListingToJumiaProducts(listing, [], brand, currency, materialFamilySchema);
      const attr = products[0].attributes.find((a) => a.name === "material_family");
      expect(attr?.value).toBe("Metal");
    });

    it("trims a multi-value attribute down to only the valid picks", () => {
      const listing = { ...sampleListing, material_family: "Metal, Fabric, Wood" };
      const products = mapListingToJumiaProducts(listing, [], brand, currency, materialFamilySchema);
      const attr = products[0].attributes.find((a) => a.name === "material_family");
      expect(attr?.value).toBe("Metal,Wood");
    });

    it("DROPS an attribute the category's schema doesn't declare", () => {
      // This test previously asserted the opposite — that an attribute
      // with no schema entry was passed through untouched. That behaviour
      // is what produced three of the seven rejections on record:
      //
      //   "Attribute [color_family] is not visible for category [Laptops]"
      //   "Attribute [main_material] is not visible for category [Laptops]"
      //   "Attribute [graphics_memory] is not visible for category [Laptops]"
      //
      // Jumia rejects the ENTIRE feed over one undeclared attribute, so
      // passing it through costs the seller the whole product to keep a
      // field that was never going to be accepted.
      const listing = { ...sampleListing, main_material: "Aluminium" };
      const products = mapListingToJumiaProducts(listing, [], brand, currency, materialFamilySchema);
      const names = products[0].attributes.map((a) => a.name);
      expect(names).not.toContain("main_material");
    });

    it("still sends everything the schema DOES declare", () => {
      // The counterweight: dropping is only safe if it is precise.
      const listing = { ...sampleListing, material_family: "Metal" };
      const products = mapListingToJumiaProducts(listing, [], brand, currency, materialFamilySchema);
      expect(products[0].attributes.map((a) => a.name)).toContain("material_family");
    });

    it("is a no-op when no schema is passed (backward compatible)", () => {
      const listing = { ...sampleListing, material_family: "Fabric" };
      const products = mapListingToJumiaProducts(listing, [], brand, currency);
      const attr = products[0].attributes.find((a) => a.name === "material_family");
      expect(attr?.value).toBe("Fabric");
    });
  });

  describe("required attribute backed by an empty column", () => {
    // The live rejection this closes, three times on record:
    //   "The column [product_weight] is missing from the file."
    // Jumia throws away EVERY product in the feed over it.
    //
    // product_weight is column-mapped (→ weight_kg). When the column was
    // empty, buildAttributes read the column, got "", and dropped the
    // attribute — discarding the value sitting in dynamic_attributes the
    // whole time. One of the three rejected listings had
    // "product_weight": "1.3" in there when the feed went out without it.
    const weightSchema: JumiaCategoryAttribute[] = [
      {
        name: "product_weight",
        label: "Weight (kg)",
        type: "string",
        allowed_values: [],
        required: true,
        is_variant: false,
      },
    ];

    it("falls back to the dynamic_attributes value when the column is empty", () => {
      const listing: ListingRow = {
        ...sampleListing,
        weight_kg: null,
        dynamic_attributes: { product_weight: "1.3" },
      };
      const products = mapListingToJumiaProducts(listing, [], brand, currency, weightSchema);
      const attr = products[0].attributes.find((a) => a.name === "product_weight");
      expect(attr?.value).toBe("1.3");
    });

    it("still prefers the COLUMN when it has a value", () => {
      // The whole point of the column-mapped rule: the column is what the
      // editors write and what the seller sees, so a dynamic copy can
      // only ever be equal or stale. A seller who corrects the weight
      // must not have the old one pushed.
      const listing: ListingRow = {
        ...sampleListing,
        weight_kg: 2.5,
        dynamic_attributes: { product_weight: "1.3" },
      };
      const products = mapListingToJumiaProducts(listing, [], brand, currency, weightSchema);
      const attr = products[0].attributes.find((a) => a.name === "product_weight");
      expect(attr?.value).toBe("2.5 kg");
    });

    it("does NOT resurrect a stale copy for an OPTIONAL attribute", () => {
      // Scoping matters. An optional column left empty can be a seller
      // deliberately clearing it, and reviving an old AI value would
      // overrule them. A required field has no valid empty state, so
      // there is nothing to overrule — that asymmetry is the rule.
      const optional: JumiaCategoryAttribute[] = [
        { ...weightSchema[0], required: false },
      ];
      const listing: ListingRow = {
        ...sampleListing,
        weight_kg: null,
        dynamic_attributes: { product_weight: "1.3" },
      };
      const products = mapListingToJumiaProducts(listing, [], brand, currency, optional);
      expect(products[0].attributes.map((a) => a.name)).not.toContain("product_weight");
    });

    it("leaves the attribute out when there is no value anywhere", () => {
      // Never invented. A weight the seller has to pay shipping on is
      // exactly the kind of field this codebase refuses to guess.
      const listing: ListingRow = {
        ...sampleListing,
        weight_kg: null,
        dynamic_attributes: {},
      };
      const products = mapListingToJumiaProducts(listing, [], brand, currency, weightSchema);
      expect(products[0].attributes.map((a) => a.name)).not.toContain("product_weight");
    });
  });

  describe("category-aware attribute naming (aliases)", () => {
    // Jumia uses DIFFERENT attribute names for the SAME logical field
    // across categories — "color" in some, "colour" in others; "weight",
    // "weight_kg" or "product_weight" depending on category. Hardcoding
    // one spelling meant a category using the other one had the value
    // dropped outright by preflightAttributes as "not visible for
    // category", even though that category genuinely accepts the field
    // under its own name.
    const colourSchema: JumiaCategoryAttribute[] = [
      { name: "colour", label: "Colour", type: "string", allowed_values: [], required: false, is_variant: false },
    ];

    it("sends the value under the schema's own spelling when it differs from the default", () => {
      const products = mapListingToJumiaProducts(sampleListing, [], brand, currency, colourSchema);
      const names = products[0].attributes.map((a) => a.name);
      expect(names).not.toContain("color");
      const attr = products[0].attributes.find((a) => a.name === "colour");
      expect(attr?.value).toBe("Navy Blue");
    });

    it("still prefers the default spelling when the schema declares it", () => {
      const colorSchema: JumiaCategoryAttribute[] = [
        { name: "color", label: "Color", type: "string", allowed_values: [], required: false, is_variant: false },
      ];
      const products = mapListingToJumiaProducts(sampleListing, [], brand, currency, colorSchema);
      const attr = products[0].attributes.find((a) => a.name === "color");
      expect(attr?.value).toBe("Navy Blue");
    });

    it("falls back to the default spelling (and lets preflight drop it) when the schema declares neither alias", () => {
      const neitherSchema: JumiaCategoryAttribute[] = [
        { name: "ram", label: "RAM", type: "string", allowed_values: [], required: false, is_variant: false },
      ];
      const products = mapListingToJumiaProducts(sampleListing, [], brand, currency, neitherSchema);
      const names = products[0].attributes.map((a) => a.name);
      expect(names).not.toContain("color");
      expect(names).not.toContain("colour");
    });

    it("sends weight under the schema's 'weight' spelling instead of the default 'product_weight'", () => {
      const weightAliasSchema: JumiaCategoryAttribute[] = [
        { name: "weight", label: "Weight", type: "string", allowed_values: [], required: false, is_variant: false },
      ];
      const products = mapListingToJumiaProducts(sampleListing, [], brand, currency, weightAliasSchema);
      const names = products[0].attributes.map((a) => a.name);
      expect(names).not.toContain("product_weight");
      const attr = products[0].attributes.find((a) => a.name === "weight");
      expect(attr?.value).toBe("0.213 kg");
    });
  });

  describe("length/width/height — combined vs. per-dimension attributes", () => {
    // Some categories declare size_l/size_w/size_h as three separate
    // (often required, numeric) attributes rather than one free-text
    // "product_measures" field. Always collapsing into the combined
    // string meant those categories never got size_l/size_w/size_h under
    // their own names at all — Jumia rejected "product_measures" as
    // undeclared AND separately reported the three as missing, for a
    // value the seller had actually supplied.
    const dimensionSchema: JumiaCategoryAttribute[] = [
      { name: "size_l", label: "Length (cm)", type: "number", allowed_values: [], required: true, is_variant: false },
      { name: "size_w", label: "Width (cm)",  type: "number", allowed_values: [], required: true, is_variant: false },
      { name: "size_h", label: "Height (cm)", type: "number", allowed_values: [], required: true, is_variant: false },
    ];

    it("sends size_l/size_w/size_h as their own bare-number attributes when the schema declares them separately", () => {
      const products = mapListingToJumiaProducts(sampleListing, [], brand, currency, dimensionSchema);
      const attrs = products[0].attributes;
      expect(attrs.find((a) => a.name === "size_l")?.value).toBe("16.1");
      expect(attrs.find((a) => a.name === "size_w")?.value).toBe("7.7");
      expect(attrs.find((a) => a.name === "size_h")?.value).toBe("0.8");
      expect(attrs.map((a) => a.name)).not.toContain("product_measures");
    });

    it("falls back to the combined product_measures string when the schema doesn't declare the dimensions separately", () => {
      const noDimensionSchema: JumiaCategoryAttribute[] = [
        { name: "product_measures", label: "Measurements", type: "string", allowed_values: [], required: false, is_variant: false },
      ];
      const products = mapListingToJumiaProducts(sampleListing, [], brand, currency, noDimensionSchema);
      const attr = products[0].attributes.find((a) => a.name === "product_measures");
      expect(attr?.value).toBe("L: 16.1 cm × W: 7.7 cm × H: 0.8 cm");
    });

    it("still sends the combined product_measures string when no schema is passed at all", () => {
      const products = mapListingToJumiaProducts(sampleListing, [], brand, currency);
      const attr = products[0].attributes.find((a) => a.name === "product_measures");
      expect(attr?.value).toBe("L: 16.1 cm × W: 7.7 cm × H: 0.8 cm");
    });
  });
});

describe("what the seller is told about what was sent", () => {
  // The audit behind this: every place the payload differs from what the
  // editor shows. Each of these was applied silently and written only to
  // a server log, so a seller could type a value, submit, see "success",
  // and have Jumia receive something else with no way to find out.

  it("stays SILENT about a field the category doesn't declare", () => {
    // Caught by this test before it shipped: the payload sprays a fixed
    // set of universal fields at every listing, so a category declaring
    // none of them produced TWENTY notes on a perfectly good push. The
    // editor never rendered those fields either, so nothing the seller
    // can see changed — and a list that long on every submit is one they
    // learn to scroll past, costing the real findings their only chance
    // of being read.
    const schema: JumiaCategoryAttribute[] = [
      { name: "material_family", label: "Material family", type: "multi",
        allowed_values: ["Metal"], required: false, is_variant: false },
    ];
    const notes: string[] = [];
    mapListingToJumiaProducts(
      { ...sampleListing, main_material: "Aluminium", material_family: "Metal" },
      [], brand, currency, schema, notes,
    );
    expect(notes.join(" ")).not.toContain("main_material");
  });

  it("reports a value the category rejects outright", () => {
    const schema: JumiaCategoryAttribute[] = [
      { name: "material_family", label: "Material family", type: "multi",
        allowed_values: ["Metal", "Wood"], required: false, is_variant: false },
    ];
    const notes: string[] = [];
    mapListingToJumiaProducts(
      { ...sampleListing, material_family: "Fabric" },
      [], brand, currency, schema, notes,
    );
    // "Fabric" is the value that once cost a whole feed.
    expect(notes.join(" ")).toContain("Material family");
  });

  it("reports a value trimmed to the category's length cap", () => {
    const schema: JumiaCategoryAttribute[] = [
      { name: "model", label: "Model", type: "string",
        allowed_values: [], required: false, is_variant: false, max_length: 5 },
    ];
    const notes: string[] = [];
    mapListingToJumiaProducts(
      { ...sampleListing, model: "A very long model name" },
      [], brand, currency, schema, notes,
    );
    expect(notes.join(" ")).toMatch(/Model was .*5/);
  });

  it("reports the brand being stripped from the title", () => {
    // Required — Jumia rejects a title repeating the brand — but the
    // seller kept seeing their own title and never learnt a different one
    // went out.
    const notes: string[] = [];
    mapListingToJumiaProducts(
      { ...sampleListing, title: "Sony WH-1000XM5 Wireless Headphones", brand: "Sony" },
      [], { code: 1, name: "Sony" }, currency, [], notes,
    );
    expect(notes.join(" ")).toContain("Sony");
    expect(notes.join(" ")).toContain("removed from the title");
  });

  it("says NOTHING when the payload matches what the seller typed", () => {
    // The counterweight. A list that cries wolf is one sellers learn to
    // scroll past, so a clean push has to stay silent.
    const schema: JumiaCategoryAttribute[] = [
      { name: "material_family", label: "Material family", type: "multi",
        allowed_values: ["Metal"], required: false, is_variant: false },
    ];
    const notes: string[] = [];
    mapListingToJumiaProducts(
      { ...sampleListing, material_family: "Metal", main_material: null, model: null,
        title: "Plain Product Title Here", brand: "Generic" },
      [], { code: 1, name: "Generic" }, currency, schema, notes,
    );
    expect(notes).toEqual([]);
  });

  it("does not report a spelling snap or a line-break rewrite", () => {
    // Both are equivalences, not losses: "metal" -> "Metal" is the exact
    // string Jumia accepts, and a <br> renders as the line the seller
    // typed. Listing them would train people to ignore the list.
    const schema: JumiaCategoryAttribute[] = [
      { name: "material_family", label: "Material family", type: "multi",
        allowed_values: ["Metal"], required: false, is_variant: false },
    ];
    const notes: string[] = [];
    mapListingToJumiaProducts(
      { ...sampleListing, material_family: "metal", main_material: null, model: null,
        title: "Plain Product Title Here", brand: "Generic" },
      [], { code: 1, name: "Generic" }, currency, schema, notes,
    );
    expect(notes).toEqual([]);
  });
});
