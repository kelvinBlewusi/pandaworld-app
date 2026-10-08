/**
 * One variant unless the seller's notes name options (owner's request,
 * 2026-10-03). The Describe prompt already says so; a single product still
 * came back as two variants, the second unlabelled, and its submit stopped
 * on "Variant 2 has no Variation label". Runs the real pipeline, with only
 * the AI calls and the category catalogue stubbed.
 */

import { FakeDb } from "./helpers/fake-supabase";

const db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({
  createServerClient: () => db,
}));

const aiCalls: string[] = [];
// What the Describe pass proposes, per test.
let describedVariations: { label: string; sku_suffix: string }[] = [];
let pickCandidates: { code: number; liveExample?: string }[] = [];
jest.mock("@/lib/actions/ai", () => ({
  ...jest.requireActual("@/lib/actions/ai"),
  aiPassA_describeProduct: async () => ({
    title: "Portable Power Bank 20000mAh Fast Charging", brand: null, keywords: ["power bank"], summary: "A power bank.",
    description: "A high capacity portable power bank. ".repeat(10), highlights: "20000mAh",
    color: null, color_family: null, weight_kg: null, main_material: null, material_family: null,
    model: null, warranty_duration: null, warranty_text: null, warranty_address: null, production_country: null,
    intended_use_case: "charging phones on the go", environment: "personal", variations: describedVariations,
  }),
  aiPassB0_pickDepartment: async () => {
    aiCalls.push("department");
    return { primary: { name: "Phones & Tablets", path: "Phones & Tablets", confidence: 0.9 }, alternates: [] };
  },
  aiPassBC_pickAndFill: async (_images: string[], candidates: { code: number; name: string; path: string; liveExample?: string }[]) => {
    aiCalls.push("pick");
    pickCandidates = candidates;
    const c = candidates[0];
    return {
      ok: true, noCandidateFits: false, needsUserConfirmation: false,
      primary: { code: c.code, name: c.name, path: c.path, confidence: 0.9 }, alternates: [],
      dynamic_attributes: {}, field_sources: {}, field_confidence: {},
    };
  },
  aiPassB_rankCategory: async () => {
    aiCalls.push("rank");
    return { primary: null, alternates: [], needsUserConfirmation: true };
  },
  extractAttributesForCategory: async (_images: string[], code: number) => {
    aiCalls.push(`fill:${code}`);
    return { dynamic_attributes: {}, field_sources: {}, field_confidence: {} };
  },
  aiExpandDescription: async (d: string) => d,
  aiMatchAllowedValue: async () => null,
}));

jest.mock("@/lib/ai/embeddings", () => ({
  ...jest.requireActual("@/lib/ai/embeddings"),
  warmEmbeddingBackend: async () => {},
}));

jest.mock("@/lib/jumia/category-search", () => ({
  ...jest.requireActual("@/lib/jumia/category-search"),
  searchCategoriesByEmbeddingMulti: async (_q: string, _n: number, depts: string[]) => depts.map(() => []),
}));

const leaf = (code: number, path: string) => ({
  code, path, name: path.split(" > ").pop()!, parent_code: null, level: 3, is_leaf: true,
  attribute_set_sid: `sid-${code}`, attribute_set_name: null,
});
const AI_PICK      = leaf(1000176, "Phones & Tablets > Accessories > Portable Power Banks");
const SELLER_PICK  = leaf(1000279, "Phones & Tablets > Mobile Accessories > Portable Power Banks & Battery Packs");
let listable = [AI_PICK, SELLER_PICK];
// The chosen category's attributes: none (a free-text variation) unless a test sets a closed list.
let categoryAttrs: unknown[] = [];

jest.mock("@/lib/jumia/categories", () => ({
  ...jest.requireActual("@/lib/jumia/categories"),
  getListableCategories:   async () => listable,
  getAllCategoriesForTree: async () => listable,
  getCategoryAttributes:   async () => categoryAttrs,
  fetchAttributesFromJumia: async () => [],
  upsertAttributes:        async () => {},
}));

jest.mock("@/lib/jumia/api", () => ({
  ...jest.requireActual("@/lib/jumia/api"),
  getValidJumiaCredentials: async () => { throw new Error("not connected"); },
}));

import { runAutoAnalyze } from "@/lib/actions/auto-analyze";

const USER = "user_1";
const LISTING_ID = "listing-1";

beforeEach(() => {
  aiCalls.length = 0;
  pickCandidates = [];
  listable = [AI_PICK, SELLER_PICK];
  categoryAttrs = [];
  db.tables.jumia_live_listings = [];
  db.tables.variants = [];
  db.tables.jumia_connections = [];
  db.tables.jumia_unlistable_categories = [];
  db.tables.listings = [{
    id: LISTING_ID, user_id: USER, images: ["https://cdn.test/a.jpg"], sku: "PB20K",
    title: "Old title", description: "Old description", brand: "Generic", selling_price: 150, quantity: 5,
    category_code: null, category_path: null, field_sources: {}, field_confidence: {}, dynamic_attributes: {},
  }];
  describedVariations = [
    { label: "Black", sku_suffix: "BLK" },
    { label: "White", sku_suffix: "WHT" },
  ];
});

const variationsSaved = () => (db.tables.variants ?? []).map((v) => v.variation);

describe("how many variants a draft gets", () => {
  it("keeps one when the seller's notes say nothing about options", async () => {
    await runAutoAnalyze(USER, LISTING_ID, "price 150");

    expect(variationsSaved()).toEqual(["Black"]);
  });

  it("keeps one when there are no notes at all", async () => {
    await runAutoAnalyze(USER, LISTING_ID, null);

    expect(variationsSaved()).toEqual(["Black"]);
  });

  it("keeps every option the notes name", async () => {
    await runAutoAnalyze(USER, LISTING_ID, "comes in black and white, price 150");

    expect(variationsSaved()).toEqual(["Black", "White"]);
  });

  it("never saves a variant without a label", async () => {
    describedVariations = [{ label: "Black", sku_suffix: "BLK" }, { label: "  ", sku_suffix: "V" }];

    await runAutoAnalyze(USER, LISTING_ID, "colours: black");

    expect(variationsSaved()).toEqual(["Black"]);
  });
});

// Owner, 2026-10-08: "in times when it is a plain text field for the
// variation what is entered is what is used?" The seller's own list (the web
// form's Sizes field writes "Sizes: …") is the variations, not a check on
// what the photos suggested.
describe("the seller's own list of variations", () => {
  it("is used as typed where the category's variation is free text", async () => {
    await runAutoAnalyze(USER, LISTING_ID, "Price: 200\nQuantity: 10\nSizes: Cream\nColour: Cream");
    expect(variationsSaved()).toEqual(["Cream"]);
  });

  it("is matched to the category's own list, size names included, in the seller's order", async () => {
    categoryAttrs = [{ name: "size", label: "Size", type: "enum", is_variant: true, is_mandatory: false, allowed_values: ["S", "M", "L", "XL"] }];
    await runAutoAnalyze(USER, LISTING_ID, "Price: 130\nSizes: Small, Large and Medium");
    expect(variationsSaved()).toEqual(["S", "L", "M"]);
  });

  it("leaves one the list can't match as \"...\", for the bot to ask about", async () => {
    categoryAttrs = [{ name: "size", label: "Size", type: "enum", is_variant: true, is_mandatory: false, allowed_values: ["S", "M", "L", "XL"] }];
    await runAutoAnalyze(USER, LISTING_ID, "Sizes: Huge");
    expect(variationsSaved()).toEqual(["..."]);
  });
});

