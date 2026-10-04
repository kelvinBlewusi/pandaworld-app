/**
 * Pay when live, through the real push and feed-status code: a WhatsApp /
 * web listing is held for at submission, charged when Jumia confirms it
 * live, and released when Jumia rejects it (lib/jumia/push-listing.ts,
 * lib/billing/extension-credits.ts).
 */

import { FakeDb } from "./helpers/fake-supabase";

const db = new FakeDb();

jest.mock("@/lib/supabase/server", () => ({
  createServerClient: () => db,
}));

let pushed = 0;
let feedStatusResult: { status: string; total: number; success: number; failed: number; errors: unknown[]; raw: unknown } | null = null;
let feedProductDetailsResult: { sellerSku: string; productSid: string | null; qcStatus: string | null; errors: string[] }[] | null = null;

jest.mock("@/lib/jumia/api", () => ({
  getValidJumiaCredentials: async () => ({ accessToken: "tok", shopId: "shop-1", currency: "GHS", country: "GH" }),
  pushProductsToJumia:      async () => { pushed++; return { success: true, jumia_ref: "feed-1", raw: null }; },
  buildJumiaPayload:        async () => ({ products: [], adjustments: [], missingRequired: [] }),
  markNeedsReconnect:       async () => {},
  getFeedStatus:            async () => feedStatusResult,
  getFeedProductDetails:    async () => feedProductDetailsResult,
}));

import { pushListingToJumia, refreshPendingFeedStatus } from "@/lib/jumia/push-listing";
import { _resetBillingModeCache } from "@/lib/billing/mode";
import { LIVE_LISTING_CREDIT_COST } from "@/lib/billing/credit-packs";
import { _resetPriceMinimumCache } from "@/lib/jumia/price-minimums";

const USER = "user_1";
const COST = LIVE_LISTING_CREDIT_COST;

function seed(balance: number) {
  db.tables.app_settings = [{ key: "billing_enabled", value: true }];
  db.tables.extension_credits = [{ user_id: USER, balance }];
  db.tables.extension_credit_transactions = [];
  db.tables.variants = [];
  db.tables.jumia_feed_outcomes = [];
  db.tables.jumia_price_minimums = [];
  db.tables.listings = [{
    id:              "listing-1",
    user_id:         USER,
    status:          "draft",
    title:           "Electric Kettle - Stainless Steel, 1.7L Capacity",
    description:     "A".repeat(60),
    selling_price:   100,
    category_code:   "1",
    brand:           "Generic",
    images:          ["https://cdn.test/1.jpg"],
    sku:             "SKU-1",
    jumia_synced_at: null,
  }];
  _resetBillingModeCache();
  _resetPriceMinimumCache();
}

const listing = () => db.tables.listings[0];
const balance = () => db.tables.extension_credits[0].balance;

async function resolveFeed(outcome: "live" | "rejected") {
  feedStatusResult = { status: "DONE", total: 1, success: outcome === "live" ? 1 : 0, failed: outcome === "live" ? 0 : 1, errors: [], raw: null };
  feedProductDetailsResult = [{
    sellerSku:  "SKU-1",
    productSid: outcome === "live" ? "sid-1" : null,
    qcStatus:   outcome === "live" ? "approved" : "rejected",
    errors:     outcome === "live" ? [] : ["Image is blurry"],
  }];
  return refreshPendingFeedStatus("tok", { id: "listing-1", status: "pending_approval", jumia_ref: "feed-1" }, { skipNotify: true });
}

beforeEach(() => {
  pushed = 0;
  feedStatusResult = null;
  feedProductDetailsResult = null;
});

it("holds the listing's price at submission and charges it once Jumia confirms it live", async () => {
  seed(10);

  expect(await pushListingToJumia(USER, "listing-1")).toMatchObject({ ok: true });
  expect(listing()).toMatchObject({ status: "pending_approval", credits_due: COST });
  expect(balance()).toBe(10); // held, not taken

  expect(await resolveFeed("live")).toMatchObject({ status: "live" });
  expect(balance()).toBe(10 - COST);
  expect(listing().credits_due).toBeNull();
});

it("charges nothing when Jumia rejects the listing", async () => {
  seed(10);
  await pushListingToJumia(USER, "listing-1");

  expect(await resolveFeed("rejected")).toMatchObject({ status: "failed" });
  expect(balance()).toBe(10);
  expect(listing().credits_due).toBeNull();
  expect(db.tables.extension_credit_transactions).toHaveLength(0);
});

it("refuses to submit, before anything reaches Jumia, when the seller can't cover it", async () => {
  seed(COST - 0.5);

  expect(await pushListingToJumia(USER, "listing-1")).toMatchObject({ ok: false, code: "insufficient_credits" });
  expect(pushed).toBe(0);
  expect(listing().status).toBe("draft");
});

// Live 2026-10-04: a product went at GHS 3 against Jumia's GHS 8.81 floor
// for Ghana. Once Jumia has named the floor, it's caught here, before
// anything reaches Jumia or a credit is held.
it("refuses a price below Jumia's lowest for the country, before anything reaches Jumia", async () => {
  seed(10);
  db.tables.jumia_price_minimums = [{ country: "GH", currency: "GHS", min_price: 8.81 }];
  listing().selling_price = 3;

  expect(await pushListingToJumia(USER, "listing-1")).toEqual({
    ok: false,
    code: "validation",
    message: "price GHS 3 is below the lowest Jumia allows (GHS 8.81) — set a higher price",
  });
  expect(pushed).toBe(0);
  expect(listing()).toMatchObject({ status: "draft" });
  expect(listing().credits_due ?? null).toBeNull();
});

it("checks each variant's own price against the minimum too", async () => {
  seed(10);
  db.tables.jumia_price_minimums = [{ country: "GH", currency: "GHS", min_price: 8.81 }];
  db.tables.variants = [
    { id: "v1", listing_id: "listing-1", variation: "Small", seller_sku: "SKU-1-S", quantity: 1, global_price: 5 },
    { id: "v2", listing_id: "listing-1", variation: "Large", seller_sku: "SKU-1-L", quantity: 1, global_price: 120 },
  ];

  expect(await pushListingToJumia(USER, "listing-1")).toMatchObject({ ok: false, code: "validation" });
  expect(pushed).toBe(0);
});

// Each variant goes at its own price, so the listing's own doesn't matter
// once every variant has one.
it("goes by the variants' own prices when they have them", async () => {
  seed(10);
  db.tables.jumia_price_minimums = [{ country: "GH", currency: "GHS", min_price: 8.81 }];
  listing().selling_price = 3;
  db.tables.variants = [
    { id: "v1", listing_id: "listing-1", variation: "Small", seller_sku: "SKU-1-S", quantity: 1, global_price: 90 },
    { id: "v2", listing_id: "listing-1", variation: "Large", seller_sku: "SKU-1-L", quantity: 1, global_price: 120 },
  ];

  expect(await pushListingToJumia(USER, "listing-1")).toMatchObject({ ok: true });
  expect(pushed).toBe(1);
});

it("lets a price at or above the minimum through", async () => {
  seed(10);
  db.tables.jumia_price_minimums = [{ country: "GH", currency: "GHS", min_price: 8.81 }];
  listing().selling_price = 8.81;

  expect(await pushListingToJumia(USER, "listing-1")).toMatchObject({ ok: true });
  expect(pushed).toBe(1);
});
