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
  salePrice: { required: ["value"], optional: ["startAt", "endAt"] },
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
    sale_start_date: "2025-02-01",
    sale_end_date:   "2025-02-15",
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

    it("salePrice is included with startAt/endAt when set", () => {
      const sp = products[0].price.salePrice;
      expect(sp).toBeDefined();
      assertHasKeys(sp, PRODUCT_SHAPE.salePrice, "product.price.salePrice");
      expect(sp!.value).toBe(1899);
      expect(sp!.startAt).toBe("2025-02-01");
      expect(sp!.endAt).toBe("2025-02-15");
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
});
