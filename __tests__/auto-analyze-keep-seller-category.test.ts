/**
 * A category the seller chose themselves survives a redraft.
 *
 * Fix & resubmit redrafts a listing (runAutoAnalyze) for rejections that
 * have nothing to do with its category — a title, a missing attribute —
 * and the redraft used to re-pick the category from scratch every time. A
 * seller who had just told the WhatsApp bot which category Vendor Center
 * accepts could have the product quietly moved somewhere else by the next
 * unrelated fix. Runs the real pipeline, with only the AI calls and the
 * category catalogue stubbed.
 */

import { FakeDb } from "./helpers/fake-supabase";

const db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({
  createServerClient: () => db,
}));

const aiCalls: string[] = [];
let pickCandidates: { code: number; liveExample?: string }[] = [];
jest.mock("@/lib/actions/ai", () => ({
  ...jest.requireActual("@/lib/actions/ai"),
  aiPassA_describeProduct: async () => ({
    title: "Portable Power Bank 20000mAh Fast Charging", brand: null, keywords: ["power bank"], summary: "A power bank.",
    description: "A high capacity portable power bank. ".repeat(10), highlights: "20000mAh",
    color: null, color_family: null, weight_kg: null, main_material: null, material_family: null,
    model: null, warranty_duration: null, warranty_text: null, warranty_address: null, production_country: null,
    intended_use_case: "charging phones on the go", environment: "personal", variations: [],
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

jest.mock("@/lib/jumia/categories", () => ({
  ...jest.requireActual("@/lib/jumia/categories"),
  getListableCategories:   async () => listable,
  getAllCategoriesForTree: async () => listable,
  getCategoryAttributes:   async () => [],
  fetchAttributesFromJumia: async () => [],
  upsertAttributes:        async () => {},
}));

jest.mock("@/lib/jumia/api", () => ({
  ...jest.requireActual("@/lib/jumia/api"),
  getValidJumiaCredentials: async () => { throw new Error("not connected"); },
}));

import { runAutoAnalyze, sellerChosenCategoryCode } from "@/lib/actions/auto-analyze";

const USER = "user_1";
const LISTING_ID = "listing-1";

function seedListing(patch: Record<string, unknown> = {}) {
  db.tables.listings = [{
    id: LISTING_ID, user_id: USER, images: ["https://cdn.test/a.jpg"],
    title: "Old title", description: "Old description", brand: "Generic",
    category_code: String(SELLER_PICK.code), category_path: SELLER_PICK.path,
    category_alternates: [{ code: AI_PICK.code, name: AI_PICK.name, path: AI_PICK.path, confidence: 0.6 }],
    field_sources: { category_code: "user" }, field_confidence: {}, dynamic_attributes: {},
    ...patch,
  }];
}
const listing = () => db.tables.listings[0];

beforeEach(() => {
  aiCalls.length = 0;
  pickCandidates = [];
  db.tables.jumia_live_listings = [];
  listable = [AI_PICK, SELLER_PICK];
  db.tables.variants = [];
  db.tables.jumia_connections = [];
  db.tables.jumia_unlistable_categories = [];
});

describe("runAutoAnalyze with a seller-chosen category", () => {
  it("keeps the seller's category and never asks the AI to pick one", async () => {
    seedListing();

    const result = await runAutoAnalyze(USER, LISTING_ID, "Jumia rejected the title");

    expect(result.ok).toBe(true);
    expect(aiCalls).toEqual([`fill:${SELLER_PICK.code}`]);
    expect(listing().category_code).toBe(String(SELLER_PICK.code));
    expect(listing().category_path).toBe(SELLER_PICK.path);
    // Still marked as the seller's for the next redraft...
    expect(listing().field_sources).toMatchObject({ category_code: "user" });
    // ...and the last AI suggestions survive for the category question.
    expect(listing().category_alternates).toEqual([expect.objectContaining({ code: AI_PICK.code })]);
    // The rest of the draft is still redone.
    expect(listing().title).not.toBe("Old title");
  });

  it("falls back to the AI's pick, and drops the seller mark, once the seller's category is no longer listable", async () => {
    seedListing();
    listable = [AI_PICK];

    const result = await runAutoAnalyze(USER, LISTING_ID, null);

    expect(result.ok).toBe(true);
    expect(aiCalls).toContain("department");
    expect(listing().category_code).toBe(String(AI_PICK.code));
    expect(listing().field_sources).not.toHaveProperty("category_code");
  });

  it("picks with the AI as before when the category was the AI's own", async () => {
    seedListing({ field_sources: {} });

    await runAutoAnalyze(USER, LISTING_ID, null);

    expect(aiCalls).toContain("department");
    expect(aiCalls).toContain("pick");
  });
});

describe("sellerChosenCategoryCode", () => {
  it("is the category code when the seller chose it", () => {
    expect(sellerChosenCategoryCode({ category_code: "1000279", field_sources: { category_code: "user" } })).toBe(1000279);
  });

  it("is null when the AI chose it, or there's no category", () => {
    expect(sellerChosenCategoryCode({ category_code: "1000279", field_sources: { category_code: "ai" } })).toBeNull();
    expect(sellerChosenCategoryCode({ category_code: "1000279", field_sources: {} })).toBeNull();
    expect(sellerChosenCategoryCode({ category_code: null, field_sources: { category_code: "user" } })).toBeNull();
  });
});

// lib/jumia/live-listings.ts: a category a similar product already went
// live in (same country) is offered to the AI first, marked, even when
// the text search ranked something else higher.
describe("runAutoAnalyze with a similar live listing", () => {
  beforeEach(() => {
    db.tables.jumia_connections = [{ user_id: USER, country: "GH" }];
    db.tables.jumia_live_listings = [{
      listing_id: "live-1", country: "GH", category_code: SELLER_PICK.code,
      title: "20000mAh Power Bank - 4 Built-in Cables, Smart Display", went_live_at: "2026-09-27T21:16:00Z",
    }];
    seedListing({ field_sources: {}, category_code: null, category_path: null });
  });

  it("puts the live listing's category first, marked with that listing's title", async () => {
    await runAutoAnalyze(USER, LISTING_ID, null);

    expect(pickCandidates[0]).toMatchObject({
      code: SELLER_PICK.code,
      liveExample: "20000mAh Power Bank - 4 Built-in Cables, Smart Display",
    });
    // Retrieval's own candidates are still offered alongside it.
    expect(pickCandidates.map((c) => c.code)).toContain(AI_PICK.code);
    expect(pickCandidates.filter((c) => c.liveExample)).toHaveLength(1);
  });

  it("never offers a live category Jumia has since refused in the seller's country", async () => {
    db.tables.jumia_unlistable_categories = [{ country: "GH", category_code: SELLER_PICK.code }];

    await runAutoAnalyze(USER, LISTING_ID, null);

    expect(pickCandidates.map((c) => c.code)).not.toContain(SELLER_PICK.code);
  });

  it("doesn't learn from another country's live listings", async () => {
    db.tables.jumia_connections = [{ user_id: USER, country: "NG" }];

    await runAutoAnalyze(USER, LISTING_ID, null);

    expect(pickCandidates.some((c) => c.liveExample)).toBe(false);
  });
});
