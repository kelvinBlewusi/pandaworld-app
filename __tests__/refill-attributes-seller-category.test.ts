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

jest.mock("@/lib/actions/ai", () => ({
  extractAttributesForCategory: async () => ({
    dynamic_attributes: { color: "Black" },
    field_sources:      { "dynamic_attributes.color": "ai" },
    field_confidence:   {},
  }),
}));

jest.mock("@/lib/jumia/categories", () => ({
  getCategoryByCode: async (code: number) => ({
    code, name: `Category ${code}`, path: `A > Category ${code}`, parent_code: null, level: 2,
    is_leaf: true, attribute_set_sid: `sid-${code}`, attribute_set_name: null,
  }),
  getCategoryAttributes:    async () => [{ name: "color" }],
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
