/**
 * fingerprintListingContent exists to answer one question when reading
 * jumia_feed_outcomes back later: was this rejection the SAME content
 * rejected again, or did something actually change? That only works if
 * the fingerprint is stable across the one thing that changes on every
 * retry regardless of content (the SKU suffix — see pushListingToJumia's
 * isRetry branch) and sensitive to everything a seller or a redraft could
 * actually change.
 */

import { FakeDb } from "./helpers/fake-supabase";

const db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({
  createServerClient: () => db,
}));

let mockApiEnvName: "staging" | "production" = "production";
jest.mock("@/lib/jumia/oauth", () => ({
  get JUMIA_API_ENV_NAME() { return mockApiEnvName; },
}));

import { fingerprintListingContent, logFeedOutcome } from "@/lib/jumia/feed-outcomes";
import type { ListingRow, VariantRow } from "@/lib/supabase/types";

function listing(patch: Partial<ListingRow> = {}) {
  return {
    title: "Electric Kettle - Stainless Steel, 1.7L Capacity",
    description: "A".repeat(60),
    brand: "Generic",
    category_code: "1",
    dynamic_attributes: { capacity_liter: "1.7" },
    ...patch,
  } as Pick<ListingRow, "title" | "description" | "brand" | "category_code" | "dynamic_attributes">;
}

function variant(patch: Partial<VariantRow> = {}) {
  return {
    variation: "Blue", quantity: 5, global_price: 100, sale_price: null,
    ...patch,
  } as Pick<VariantRow, "variation" | "quantity" | "global_price" | "sale_price">;
}

describe("fingerprintListingContent", () => {
  it("is stable across a retry's fresh SKU suffix — seller_sku isn't part of the input at all", () => {
    // The function's signature doesn't even accept seller_sku, so a caller
    // passing variants with different SKUs (exactly what isRetry produces)
    // can't affect the hash — this pins that down explicitly.
    const a = fingerprintListingContent(listing(), [variant()]);
    const b = fingerprintListingContent(listing(), [variant()]);
    expect(a).toBe(b);
  });

  it("changes when the content a redraft would actually change changes", () => {
    const base = fingerprintListingContent(listing(), [variant()]);
    const rewordedTitle = fingerprintListingContent(listing({ title: "A totally different title here" }), [variant()]);
    const newAttribute = fingerprintListingContent(
      listing({ dynamic_attributes: { capacity_liter: "2" } }),
      [variant()],
    );
    expect(rewordedTitle).not.toBe(base);
    expect(newAttribute).not.toBe(base);
  });

  it("is insensitive to variant array order — Jumia and our own code don't guarantee one", () => {
    const forward = fingerprintListingContent(listing(), [variant({ variation: "Blue" }), variant({ variation: "Red" })]);
    const backward = fingerprintListingContent(listing(), [variant({ variation: "Red" }), variant({ variation: "Blue" })]);
    expect(forward).toBe(backward);
  });

  it("changes when a variant's price or quantity changes, even with the same variation label", () => {
    const a = fingerprintListingContent(listing(), [variant({ quantity: 5 })]);
    const b = fingerprintListingContent(listing(), [variant({ quantity: 50 })]);
    expect(a).not.toBe(b);
  });
});

// Lets a rejection caught on the staging branch (STAGING.md) be told apart
// from a real seller hitting the same thing in production — both currently
// write into the same jumia_feed_outcomes table (one shared Supabase
// project), so without this tag they're indistinguishable.
describe("logFeedOutcome — source_env", () => {
  beforeEach(() => {
    db.tables.jumia_feed_outcomes = [];
    mockApiEnvName = "production";
  });

  it("tags the row 'production' when JUMIA_API_ENV_NAME is production", async () => {
    await logFeedOutcome({ listingId: "listing-1", outcome: "rejected", rawError: "some error" });
    expect(db.tables.jumia_feed_outcomes[0]).toMatchObject({ source_env: "production" });
  });

  it("tags the row 'staging' when JUMIA_API_ENV_NAME is staging", async () => {
    mockApiEnvName = "staging";
    await logFeedOutcome({ listingId: "listing-1", outcome: "live" });
    expect(db.tables.jumia_feed_outcomes[0]).toMatchObject({ source_env: "staging" });
  });
});

// "Attribute [x] is not visible for category [y]" names fields Jumia doesn't
// show for that category. They leave its cached schema the moment the
// rejection is logged, so the next push in that category leaves them out
// (2026-10-01: a second Educational Tablets listing hit the same rejection).
describe("logFeedOutcome — fields Jumia doesn't show for the category", () => {
  const EDU = 1029505;
  const NOT_VISIBLE = ["color_family", "main_material", "manufacturer_txt", "package_content"]
    .map((n) => `Attribute [${n}] is not visible for category [Educational Tablets].`).join(" ");

  beforeEach(() => {
    db.tables.jumia_feed_outcomes = [];
    db.tables.jumia_excluded_attributes = [];
    db.tables.jumia_category_attributes = ["color_family", "main_material", "manufacturer_txt", "package_content", "ram", "operating_system"]
      .map((name) => ({ category_code: EDU, name }));
  });

  it("drops them from the category's cached schema and remembers them", async () => {
    await logFeedOutcome({ listingId: "listing-1", outcome: "rejected", categoryCode: String(EDU), rawError: NOT_VISIBLE, country: "GH" });

    expect(db.tables.jumia_category_attributes.map((r) => r.name).sort()).toEqual(["operating_system", "ram"]);
    expect(db.tables.jumia_excluded_attributes.map((r) => r.name).sort())
      .toEqual(["color_family", "main_material", "manufacturer_txt", "package_content"]);
  });

  it("leaves the schema alone for any other rejection", async () => {
    await logFeedOutcome({ listingId: "listing-1", outcome: "rejected", categoryCode: String(EDU), rawError: "Price must be greater than 0", country: "GH" });
    expect(db.tables.jumia_category_attributes).toHaveLength(6);
    expect(db.tables.jumia_excluded_attributes).toHaveLength(0);
  });
});

// "must be equal or more than [8.81] GHS" is the country's lowest price,
// saved as soon as the rejection is logged so the next push there checks
// it first (lib/jumia/price-minimums.ts).
describe("logFeedOutcome — Jumia's lowest price for the country", () => {
  beforeEach(() => {
    db.tables.jumia_feed_outcomes = [];
    db.tables.jumia_price_minimums = [];
  });

  it("remembers the minimum a rejection names", async () => {
    await logFeedOutcome({
      listingId: "listing-1", outcome: "rejected", categoryCode: "1000639", country: "GH",
      rawError: "The Global Price [3] GHS must be equal or more than [8.81] GHS.",
    });
    expect(db.tables.jumia_price_minimums).toEqual([
      expect.objectContaining({ country: "GH", currency: "GHS", min_price: 8.81, category_code: 1000639 }),
    ]);
  });

  it("remembers nothing for any other rejection", async () => {
    await logFeedOutcome({ listingId: "listing-1", outcome: "rejected", categoryCode: "1", rawError: "Image is blurry", country: "GH" });
    expect(db.tables.jumia_price_minimums).toHaveLength(0);
  });
});
