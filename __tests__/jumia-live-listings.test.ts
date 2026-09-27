/**
 * Learning categories from listings that went live
 * (lib/jumia/live-listings.ts). Fixtures are real live Ghana listings,
 * including the miscategorised ones that are the reason a live category is
 * only ever offered to the AI, never applied: a safety helmet live under
 * "Plate Casters", another under "Handlesets".
 */

import { FakeDb } from "./helpers/fake-supabase";

const db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({
  createServerClient: () => db,
}));

jest.mock("@/lib/jumia/oauth", () => ({
  JUMIA_API_ENV_NAME: "production",
}));

import { logFeedOutcome } from "@/lib/jumia/feed-outcomes";
import {
  findProvenCategories,
  productHead,
  productTokens,
  provenCategoriesFor,
  type LiveExample,
} from "@/lib/jumia/live-listings";

const EXAMPLES: LiveExample[] = [
  { title: "20000mAh Power Bank - 4 Built-in Cables, Smart Display", category_code: 1000279 },
  { title: "Electric Kettle - Stainless Steel, 1.8L Capacity", category_code: 1029495 },
  { title: "MOOVED Electric Kettle - Stainless Steel, 1.8L Capacity", category_code: 1022988 },
  { title: "Safety Helmet - Hard Hat, Vented Design", category_code: 1022439 },    // "Plate Casters"
  { title: "Safety Helmet - Adjustable Strap, Hard Hat", category_code: 1027119 }, // "Handlesets"
  { title: "Safety Helmet - Hard Hat, Protective Headwear", category_code: 1023067 },
  { title: "Baby Carrier - Adjustable Straps, Padded Support", category_code: 1001905 },
  { title: "Digital Air Fryer - 5.5L Capacity, 200 Degree Max Temp", category_code: 1029441 },
];

const LISTABLE = new Map<number, { code: number; name: string }>([
  [1000279, { code: 1000279, name: "Portable Power Banks & Battery Packs" }],
  [1029495, { code: 1029495, name: "Electric Kettles" }],
  [1022988, { code: 1022988, name: "Electric Kettles" }],
  [1022439, { code: 1022439, name: "Plate Casters" }],
  [1027119, { code: 1027119, name: "Handlesets" }],
  [1023067, { code: 1023067, name: "Hard Hats" }],
  [1001905, { code: 1001905, name: "Child Carrier Packs" }],
  [1029441, { code: 1029441, name: "Air Fryers" }],
]);

describe("productTokens / productHead", () => {
  it("keeps the words that say what the product is, not its specs", () => {
    expect(productTokens("20000mAh Power Bank - 4 Built-in Cables")).toEqual(["power", "bank", "built", "cable"]);
  });

  it("takes the product name before the feature list", () => {
    expect(productHead("Electric Kettle - Stainless Steel, 1.8L Capacity")).toBe("Electric Kettle");
  });
});

describe("findProvenCategories", () => {
  it("finds the category a similar product went live in", () => {
    const proven = findProvenCategories({ title: "Portable Power Bank 10000mAh - Fast Charging" }, EXAMPLES, LISTABLE);
    expect(proven.map((p) => p.code)).toEqual([1000279]);
    expect(proven[0].exampleTitle).toContain("Power Bank");
  });

  it("matches a longer drafted name that contains the live listing's whole name", () => {
    // Two-way overlap alone scores this 0.44: the draft has extra words.
    const proven = findProvenCategories({ title: "Portable Power Bank 20000mAh Fast Charging" }, EXAMPLES, LISTABLE);
    expect(proven.map((p) => p.code)).toEqual([1000279]);
  });

  it("offers each category similar products went live in, best match first", () => {
    const proven = findProvenCategories({ title: "Cordless Electric Kettle - 1.7L" }, EXAMPLES, LISTABLE);
    expect(proven.map((p) => p.code).sort()).toEqual([1022988, 1029495]);
  });

  it("drops live categories whose own name has nothing to do with the product", () => {
    const proven = findProvenCategories(
      { title: "Construction Safety Helmet - Hard Hat", keywords: ["hard hat", "safety helmet"] },
      EXAMPLES,
      LISTABLE,
      { limit: 5 },
    );
    expect(proven.map((p) => p.code)).toEqual([1023067]);
  });

  it("ignores a live listing that only shares incidental words", () => {
    // "Adjustable Straps" is in the baby carrier's features, not its name.
    expect(findProvenCategories({ title: "Adjustable Laptop Stand - Aluminium" }, EXAMPLES, LISTABLE)).toEqual([]);
  });

  it("skips categories that aren't in the listable set it's given (refused here, or gone)", () => {
    const withoutPowerBanks = new Map(LISTABLE);
    withoutPowerBanks.delete(1000279);
    expect(findProvenCategories({ title: "Power Bank 20000mAh" }, EXAMPLES, withoutPowerBanks)).toEqual([]);
  });

  it("returns at most `limit` categories", () => {
    expect(findProvenCategories({ title: "Electric Kettle" }, EXAMPLES, LISTABLE, { limit: 1 })).toHaveLength(1);
  });
});

describe("provenCategoriesFor", () => {
  beforeEach(() => {
    db.tables.jumia_live_listings = [
      { listing_id: "l1", country: "GH", category_code: 1000279, title: EXAMPLES[0].title, went_live_at: "2026-09-27T21:16:00Z" },
      { listing_id: "l2", country: "NG", category_code: 1029441, title: "Air Fryer 4L", went_live_at: "2026-09-27T21:16:00Z" },
    ];
  });

  const listable = Array.from(LISTABLE.values()).map((c) => ({
    ...c, path: c.name, parent_code: null, level: 1, is_leaf: true, attribute_set_sid: "sid", attribute_set_name: null,
  }));

  it("learns only from the seller's own country", async () => {
    expect((await provenCategoriesFor("GH", { title: "Power Bank 10000mAh" }, listable)).map((p) => p.code)).toEqual([1000279]);
    expect(await provenCategoriesFor("GH", { title: "Digital Air Fryer" }, listable)).toEqual([]);
  });

  it("is empty for a seller with no country", async () => {
    expect(await provenCategoriesFor(null, { title: "Power Bank" }, listable)).toEqual([]);
  });
});

describe("logFeedOutcome: recording live listings", () => {
  beforeEach(() => {
    db.tables.listings = [{ id: "listing-1", user_id: "user_gh", title: "20000mAh Power Bank - 4 Built-in Cables" }];
    db.tables.jumia_connections = [{ user_id: "user_gh", country: "GH" }];
    db.tables.jumia_feed_outcomes = [];
    db.tables.jumia_live_listings = [];
    db.tables.jumia_unlistable_categories = [];
  });

  it("records a live listing with its country, category and title", async () => {
    await logFeedOutcome({ listingId: "listing-1", categoryCode: "1000279", outcome: "live" });

    expect(db.tables.jumia_live_listings).toEqual([expect.objectContaining({
      listing_id: "listing-1", country: "GH", category_code: 1000279, title: "20000mAh Power Bank - 4 Built-in Cables",
    })]);
  });

  it("keeps one row per listing, updated if it goes live again in another category", async () => {
    await logFeedOutcome({ listingId: "listing-1", categoryCode: "1000279", outcome: "live" });
    await logFeedOutcome({ listingId: "listing-1", categoryCode: "1000176", outcome: "live" });

    expect(db.tables.jumia_live_listings).toHaveLength(1);
    expect(db.tables.jumia_live_listings[0]).toMatchObject({ category_code: 1000176 });
  });

  it("doesn't record a rejection", async () => {
    await logFeedOutcome({ listingId: "listing-1", categoryCode: "1000279", outcome: "rejected", rawError: "Brand is invalid" });
    expect(db.tables.jumia_live_listings).toHaveLength(0);
  });
});
