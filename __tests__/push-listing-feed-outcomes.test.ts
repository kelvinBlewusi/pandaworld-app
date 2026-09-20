/**
 * Regression coverage for item 9 of the post-20-product-batch review:
 * every resolved Jumia feed outcome (live, rejected, or blocked before it
 * ever left the building) should land in jumia_feed_outcomes, so a future
 * rejection-class fix has a real fixture to test against instead of
 * relying on whoever was watching the chat when it happened. See
 * CONTRIBUTING.md and lib/jumia/feed-outcomes.ts.
 */

import { FakeDb } from "./helpers/fake-supabase";

const db = new FakeDb();

jest.mock("@/lib/supabase/server", () => ({
  createServerClient: () => db,
}));

let pushProductsResult: { success: boolean; jumia_ref: string | null; raw: unknown; error?: string; blocked?: "missing_required"; adjustments?: string[] } = {
  success: true, jumia_ref: "feed-1", raw: null,
};
let feedStatusResult: { status: string; total: number; success: number; failed: number; errors: unknown[]; raw: unknown } | null = null;
let feedProductDetailsResult: { sellerSku: string; productSid: string | null; qcStatus: string | null; errors: string[] }[] | null = null;

jest.mock("@/lib/jumia/api", () => ({
  getValidJumiaCredentials: async () => ({ accessToken: "tok", shopId: "shop-1", currency: "GHS", country: "GH" }),
  pushProductsToJumia:      async () => pushProductsResult,
  buildJumiaPayload:        async () => ({ products: [], adjustments: [], missingRequired: [] }),
  markNeedsReconnect:       async () => {},
  getFeedStatus:            async () => feedStatusResult,
  getFeedProductDetails:    async () => feedProductDetailsResult,
}));

import { pushListingToJumia, refreshPendingFeedStatus } from "@/lib/jumia/push-listing";

const USER = "user_1";

function seedListing(patch: Record<string, unknown> = {}) {
  db.tables.listings = [{
    id:             "listing-1",
    user_id:        USER,
    status:         "draft",
    title:          "Electric Kettle - Stainless Steel, 1.7L Capacity",
    description:    "A".repeat(60),
    selling_price:  100,
    category_code:  "1",
    brand:          "Generic",
    images:         ["https://cdn.test/1.jpg"],
    sku:            "SKU-1",
    jumia_synced_at: null,
    ...patch,
  }];
}

function outcomes() {
  return (db.tables.jumia_feed_outcomes ?? []) as Record<string, unknown>[];
}

beforeEach(() => {
  db.tables.listings = [];
  db.tables.variants = [];
  db.tables.jumia_feed_outcomes = [];
  pushProductsResult = { success: true, jumia_ref: "feed-1", raw: null };
  feedStatusResult = null;
  feedProductDetailsResult = null;
});

describe("pushListingToJumia — outcome logging", () => {
  it("stores a payload fingerprint on success but logs no outcome yet — the push only queued, it didn't resolve", async () => {
    seedListing();

    const result = await pushListingToJumia(USER, "listing-1");

    expect(result.ok).toBe(true);
    expect(db.tables.listings[0].jumia_payload_fingerprint).toEqual(expect.any(String));
    expect(outcomes()).toHaveLength(0);
  });

  it("logs a blocked_locally outcome when the category needs attributes we never sent", async () => {
    seedListing();
    pushProductsResult = {
      success: false, jumia_ref: null, raw: null, blocked: "missing_required",
      error: "This category requires Product Weight.",
    };

    await pushListingToJumia(USER, "listing-1");

    expect(outcomes()).toHaveLength(1);
    expect(outcomes()[0]).toMatchObject({
      listing_id: "listing-1",
      feed_id:    null,
      outcome:    "blocked_locally",
      raw_error:  "This category requires Product Weight.",
    });
    expect(outcomes()[0].payload_fingerprint).toEqual(expect.any(String));
  });

  it('logs "rejected" (not blocked_locally) when Jumia\'s create-feed endpoint itself answered with a real error', async () => {
    seedListing();
    // raw non-null is exactly how pushProductsToJumia tells apart "Jumia
    // actually responded" from every local-refusal branch (which returns
    // raw: null) — see the comment above this call site in push-listing.ts.
    pushProductsResult = {
      success: false, jumia_ref: null,
      raw: { errors: ["Required field [Product.Brand.Code] is missing or null."] },
      error: "Required field [Product.Brand.Code] is missing or null.",
    };

    await pushListingToJumia(USER, "listing-1");

    expect(outcomes()).toHaveLength(1);
    expect(outcomes()[0]).toMatchObject({
      outcome:   "rejected",
      raw_error: "Required field [Product.Brand.Code] is missing or null.",
    });
  });

  it("logs blocked_locally for a payload refused before it ever reached Jumia (buildJumiaPayload's own error, raw: null)", async () => {
    seedListing();
    pushProductsResult = {
      success: false, jumia_ref: null, raw: null,
      error: 'Variation "Navy Blue" isn\'t one of this category\'s stocked options (Black, White, Navy) — pick one of those.',
    };

    await pushListingToJumia(USER, "listing-1");

    expect(outcomes()[0].outcome).toBe("blocked_locally");
  });
});

describe("refreshPendingFeedStatus — outcome logging", () => {
  it("logs a live outcome per SKU once Jumia confirms every variant went through", async () => {
    seedListing({ status: "pending_approval", jumia_ref: "feed-1", jumia_payload_fingerprint: "fp-abc" });
    feedStatusResult = { status: "DONE", total: 1, success: 1, failed: 0, errors: [], raw: null };
    feedProductDetailsResult = [{ sellerSku: "SKU-1", productSid: "sid-1", qcStatus: "approved", errors: [] }];

    await refreshPendingFeedStatus("tok", { id: "listing-1", status: "pending_approval", jumia_ref: "feed-1" });

    expect(outcomes()).toHaveLength(1);
    expect(outcomes()[0]).toMatchObject({
      listing_id:          "listing-1",
      feed_id:             "feed-1",
      seller_sku:          "SKU-1",
      outcome:             "live",
      raw_error:           null,
      payload_fingerprint: "fp-abc",
      category_code:       "1",
    });
  });

  it("logs a rejected outcome with the real Jumia error string for the SKU that failed, live for the ones that didn't", async () => {
    seedListing({ status: "pending_approval", jumia_ref: "feed-1", jumia_payload_fingerprint: "fp-xyz" });
    feedStatusResult = { status: "DONE", total: 2, success: 1, failed: 1, errors: [], raw: null };
    feedProductDetailsResult = [
      { sellerSku: "SKU-1-Blue", productSid: "sid-1", qcStatus: "approved", errors: [] },
      {
        sellerSku: "SKU-1-Navy", productSid: null, qcStatus: "rejected",
        errors: ["Attribute [capacity_liter] with the value [1.7] should be a number without decimals."],
      },
    ];

    await refreshPendingFeedStatus("tok", { id: "listing-1", status: "pending_approval", jumia_ref: "feed-1" });

    expect(outcomes()).toHaveLength(2);
    const live = outcomes().find((o) => o.seller_sku === "SKU-1-Blue");
    const rejected = outcomes().find((o) => o.seller_sku === "SKU-1-Navy");
    expect(live).toMatchObject({ outcome: "live", raw_error: null });
    expect(rejected).toMatchObject({
      outcome:   "rejected",
      raw_error: "Attribute [capacity_liter] with the value [1.7] should be a number without decimals.",
    });
  });

  it("falls back to one listing-level row when Jumia gives no per-item detail", async () => {
    seedListing({ status: "pending_approval", jumia_ref: "feed-1" });
    feedStatusResult = { status: "ERROR", total: 1, success: 0, failed: 1, errors: ["Feed processing failed"], raw: null };
    feedProductDetailsResult = [];

    await refreshPendingFeedStatus("tok", { id: "listing-1", status: "pending_approval", jumia_ref: "feed-1" });

    expect(outcomes()).toHaveLength(1);
    expect(outcomes()[0]).toMatchObject({ outcome: "rejected", seller_sku: null, raw_error: "Feed processing failed" });
  });

  it("does not re-log an outcome when re-checking an already-resolved listing (diagnose route re-polling)", async () => {
    seedListing({ status: "live", jumia_ref: "feed-1" });
    feedStatusResult = { status: "DONE", total: 1, success: 1, failed: 0, errors: [], raw: null };
    feedProductDetailsResult = [{ sellerSku: "SKU-1", productSid: "sid-1", qcStatus: "approved", errors: [] }];

    await refreshPendingFeedStatus("tok", { id: "listing-1", status: "live", jumia_ref: "feed-1" }, { allowNonPending: true });

    expect(outcomes()).toHaveLength(0);
  });
});
