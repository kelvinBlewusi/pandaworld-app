/**
 * refillAttributesForCategory records a category switch as the seller's
 * choice (field_sources.category_code = "user"), which is what stops a
 * later redraft from re-picking it (see runAutoAnalyze). Every category
 * switch through it is a seller's: the editor's category picker, WhatsApp's
 * category buttons and its category question. A same-category refill (the
 * editor's "Fill empty fields with AI") chooses nothing, so it mustn't
 * claim the category for the seller.
 */

import { FakeDb } from "./helpers/fake-supabase";

const db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({
  createServerClient: () => db,
}));

let extracted: Record<string, string> = { color: "Black" };
jest.mock("@/lib/actions/ai", () => ({
  extractAttributesForCategory: async () => ({
    dynamic_attributes: extracted,
    field_sources:      Object.fromEntries(Object.keys(extracted).map((k) => [`dynamic_attributes.${k}`, "ai"])),
    field_confidence:   {},
  }),
}));

let schema: { name: string; type?: string; allowed_values?: string[] }[] = [{ name: "color" }];

jest.mock("@/lib/jumia/categories", () => ({
  getCategoryByCode: async (code: number) => ({
    code, name: `Category ${code}`, path: `A > Category ${code}`, parent_code: null, level: 2,
    is_leaf: true, attribute_set_sid: `sid-${code}`, attribute_set_name: null,
  }),
  getCategoryAttributes:    async () => schema,
  fetchAttributesFromJumia: async () => [],
  upsertAttributes:         async () => {},
}));

jest.mock("@/lib/jumia/api", () => ({
  getValidJumiaCredentials: async () => ({ accessToken: "tok" }),
}));

jest.mock("@/lib/jumia/category-corrections", () => ({
  logCategoryCorrection: async () => {},
}));

import { refillAttributesForCategory } from "@/lib/jumia/refill-attributes";

beforeEach(() => {
  extracted = { color: "Black" };
  schema = [{ name: "color" }];
});

function seedListing(patch: Record<string, unknown> = {}) {
  db.tables.listings = [{
    id: "listing-1", user_id: "user_1", images: ["https://cdn.test/a.jpg"],
    category_code: "100", category_path: "A > Category 100",
    dynamic_attributes: {}, field_sources: {}, field_confidence: {}, category_alternates: [],
    ...patch,
  }];
}

describe("refillAttributesForCategory — who chose the category", () => {
  it("marks a switch to a different category as the seller's", async () => {
    seedListing();

    const result = await refillAttributesForCategory("user_1", "listing-1", 200);

    expect(result.ok).toBe(true);
    expect(db.tables.listings[0].category_code).toBe("200");
    expect(db.tables.listings[0].field_sources).toMatchObject({ category_code: "user", "dynamic_attributes.color": "ai" });
  });

  it("leaves it unmarked on a same-category refill", async () => {
    seedListing();

    await refillAttributesForCategory("user_1", "listing-1", 100);

    expect(db.tables.listings[0].field_sources).not.toHaveProperty("category_code");
  });

  it("keeps an existing seller mark on a same-category refill", async () => {
    seedListing({ field_sources: { category_code: "user" } });

    await refillAttributesForCategory("user_1", "listing-1", 100);

    expect(db.tables.listings[0].field_sources).toMatchObject({ category_code: "user" });
  });
});

// Live, 2026-10-01: a shower cream switched from Body Sunscreens to Body
// Washes lost every AI value with the old category, the new fill skipped
// the weight, and the product was held for "Weight (kg)".
describe("refillAttributesForCategory — what carries over a category switch", () => {
  it("keeps an earlier value the new fill left out, and copies a weight into its column", async () => {
    schema = [{ name: "color" }, { name: "product_weight" }];
    seedListing({ dynamic_attributes: { product_weight: "0.3", old_only: "x" }, field_sources: { "dynamic_attributes.product_weight": "ai" } });

    await refillAttributesForCategory("user_1", "listing-1", 200);

    const row = db.tables.listings[0];
    expect(row.dynamic_attributes).toEqual({ color: "Black", product_weight: "0.3" });
    expect(row.weight_kg).toBe(0.3);
    expect(row.field_sources).toMatchObject({ weight_kg: "ai" });
  });

  it("copies a weight the new fill gave into an empty column", async () => {
    schema = [{ name: "product_weight" }];
    extracted = { product_weight: "0.45 kg" };
    seedListing();

    await refillAttributesForCategory("user_1", "listing-1", 200);

    expect(db.tables.listings[0].weight_kg).toBe(0.45);
  });

  it("never replaces a weight already set", async () => {
    schema = [{ name: "product_weight" }];
    extracted = { product_weight: "2" };
    seedListing({ weight_kg: 0.5 });

    await refillAttributesForCategory("user_1", "listing-1", 200);

    expect(db.tables.listings[0].weight_kg).toBe(0.5);
  });

  it("drops an earlier value the new category doesn't accept", async () => {
    schema = [{ name: "color" }, { name: "skin_type", allowed_values: ["Dry", "Oily", "All skin types"] }];
    seedListing({ dynamic_attributes: { skin_type: "Sensitive" } });

    await refillAttributesForCategory("user_1", "listing-1", 200);

    expect(db.tables.listings[0].dynamic_attributes).not.toHaveProperty("skin_type");
  });
});

// Live, 2026-10-02: switching a pair of earrings to Drop & Dangle filled
// Age Group with "Female", and the product was held over it.
describe("refillAttributesForCategory — only values the new category accepts", () => {
  const AGE = { name: "age_group", type: "enum", allowed_values: ["25-64  Years", "15-24 Years", "0-14 Years", "65 Years +"] };

  it("clears an AI value that isn't one of the field's options", async () => {
    schema = [{ name: "color" }, AGE];
    extracted = { color: "Black", age_group: "Female" };
    seedListing();

    await refillAttributesForCategory("user_1", "listing-1", 200);

    const row = db.tables.listings[0];
    expect(row.dynamic_attributes).toEqual({ color: "Black" });
    expect(row.field_sources).not.toHaveProperty("dynamic_attributes.age_group");
  });

  it("corrects an AI value that's only spelt differently", async () => {
    schema = [{ name: "gender", type: "enum", allowed_values: ["Female", "Male", "Unisex"] }];
    extracted = { gender: "female" };
    seedListing();

    await refillAttributesForCategory("user_1", "listing-1", 200);

    expect(db.tables.listings[0].dynamic_attributes).toEqual({ gender: "Female" });
  });

  it("leaves the seller's own value as they wrote it", async () => {
    schema = [AGE];
    extracted = {};
    seedListing({ dynamic_attributes: { age_group: "Adults" }, field_sources: { "dynamic_attributes.age_group": "user" } });

    await refillAttributesForCategory("user_1", "listing-1", 200);

    expect(db.tables.listings[0].dynamic_attributes).toEqual({ age_group: "Adults" });
  });

  it("clears a column-held value the new category refuses", async () => {
    schema = [{ name: "color_family", type: "enum", allowed_values: ["Black", "White"] }];
    extracted = {};
    seedListing({ color_family: "Gold" });

    await refillAttributesForCategory("user_1", "listing-1", 200);

    expect(db.tables.listings[0].color_family).toBeNull();
  });
});
