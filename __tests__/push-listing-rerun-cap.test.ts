/**
 * Regression test for a real production loop, reproduced live on
 * 2026-09-19: "Fix & resubmit" kept re-queuing an Electric Kettle listing
 * whose capacity_liter was a genuine 1.7 (Jumia wants a whole number) and
 * a Baby Carrier whose "Navy Blue" variation value Jumia never accepted —
 * four and three consecutive redraft-resubmit cycles respectively, each
 * one hitting the identical async rejection, with the seller never once
 * told to stop tapping and use the editor instead.
 *
 * shouldBlockRepeatedAutoFix (lib/jumia/rejection-remedy.ts) exists
 * specifically to cap this at one automatic attempt per rejection
 * fingerprint. It was defeated because pushListingToJumia cleared
 * jumia_rerun_fingerprint/jumia_rerun_count the moment Jumia's create call
 * merely QUEUED the listing as "pending_approval" — not when Jumia's
 * async review actually resolved it. Every "Fix & resubmit" tap queued
 * successfully, wiping the counter, so the async rejection that followed
 * always looked like a fresh problem to the next tap.
 */

import { FakeDb } from "./helpers/fake-supabase";

const db = new FakeDb();

jest.mock("@/lib/supabase/server", () => ({
  createServerClient: () => db,
}));

let pushProductsResult: { success: boolean; jumia_ref: string | null; raw: unknown; error?: string; adjustments?: string[] } = {
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
    id:                      "listing-1",
    user_id:                 USER,
    status:                  "draft",
    title:                   "Electric Kettle - Stainless Steel, 1.7L Capacity",
    description:             "A".repeat(60),
    selling_price:           100,
    category_code:           "1",
    brand:                   "Generic",
    images:                  ["https://cdn.test/1.jpg"],
    sku:                     "SKU-1",
    jumia_synced_at:         null,
    jumia_rerun_fingerprint: "rerun:attribute [capacity_liter] with the value [1.7] should be a number without decimals.",
    jumia_rerun_count:       1,
    ...patch,
  }];
}

beforeEach(() => {
  db.tables.listings = [];
  db.tables.variants = [];
  pushProductsResult = { success: true, jumia_ref: "feed-1", raw: null };
  feedStatusResult = null;
  feedProductDetailsResult = null;
});

describe("pushListingToJumia — synchronous queue success", () => {
  it("does NOT clear the rerun loop-cap bookkeeping merely because Jumia queued the listing", async () => {
    seedListing();

    const result = await pushListingToJumia(USER, "listing-1");

    expect(result.ok).toBe(true);
    const row = db.tables.listings[0];
    expect(row.status).toBe("pending_approval");
    // The bug: this used to be wiped to null/0 right here, before Jumia's
    // async review ever ran — defeating shouldBlockRepeatedAutoFix for the
    // exact rejection that was still in flight.
    expect(row.jumia_rerun_fingerprint).toBe(
      "rerun:attribute [capacity_liter] with the value [1.7] should be a number without decimals.",
    );
    expect(row.jumia_rerun_count).toBe(1);
  });
});

describe("refreshPendingFeedStatus — genuine async resolution", () => {
  it("clears the rerun loop-cap bookkeeping once Jumia confirms the listing is actually live", async () => {
    seedListing({ status: "pending_approval", jumia_ref: "feed-1" });
    feedStatusResult = { status: "DONE", total: 1, success: 1, failed: 0, errors: [], raw: null };
    feedProductDetailsResult = [{ sellerSku: "SKU-1", productSid: "sid-1", qcStatus: "approved", errors: [] }];

    const resolution = await refreshPendingFeedStatus("tok", {
      id: "listing-1", status: "pending_approval", jumia_ref: "feed-1",
    });

    expect(resolution.status).toBe("live");
    const row = db.tables.listings[0];
    expect(row.status).toBe("live");
    expect(row.jumia_rerun_fingerprint).toBeNull();
    expect(row.jumia_rerun_count).toBe(0);
  });

  it("leaves the bookkeeping in place when the async review rejects the listing again — this is the case the cap protects", async () => {
    seedListing({ status: "pending_approval", jumia_ref: "feed-1" });
    feedStatusResult = { status: "DONE", total: 1, success: 0, failed: 1, errors: [], raw: null };
    feedProductDetailsResult = [{
      sellerSku: "SKU-1", productSid: null, qcStatus: "rejected",
      errors: ["Attribute [capacity_liter] with the value [1.7] should be a number without decimals."],
    }];

    const resolution = await refreshPendingFeedStatus("tok", {
      id: "listing-1", status: "pending_approval", jumia_ref: "feed-1",
    });

    expect(resolution.status).toBe("failed");
    const row = db.tables.listings[0];
    expect(row.status).toBe("failed");
    // Still set — the next "Fix & resubmit" tap must recognise this as the
    // same rejection it already tried once, and hand back to the seller
    // instead of redrafting the identical value a third time.
    expect(row.jumia_rerun_fingerprint).toBe(
      "rerun:attribute [capacity_liter] with the value [1.7] should be a number without decimals.",
    );
    expect(row.jumia_rerun_count).toBe(1);
  });

  it("surfaces EVERY distinct rejection reason across all rejected variants, not just the first", async () => {
    // A real multi-SKU feed can fail different variants for genuinely
    // different reasons in the same round trip. Reporting only the first
    // meant a seller who fixed it still got rejected again on the next
    // "Fix & resubmit" tap purely because the SECOND reason was never
    // surfaced until then.
    seedListing({ status: "pending_approval", jumia_ref: "feed-1" });
    feedStatusResult = { status: "DONE", total: 2, success: 0, failed: 2, errors: [], raw: null };
    feedProductDetailsResult = [
      {
        sellerSku: "SKU-1", productSid: null, qcStatus: "rejected",
        errors: ["Attribute [capacity_liter] with the value [1.7] should be a number without decimals."],
      },
      {
        sellerSku: "SKU-2", productSid: null, qcStatus: "rejected",
        errors: ["Attribute [variation] with the value [Navy Blue] is not one of the allowed options."],
      },
    ];

    const resolution = await refreshPendingFeedStatus("tok", {
      id: "listing-1", status: "pending_approval", jumia_ref: "feed-1",
    });

    expect(resolution.status).toBe("failed");
    expect(resolution.error).toContain("capacity_liter");
    expect(resolution.error).toContain("variation");
    expect(resolution.error).toContain(" | ");
  });

  it("deduplicates an identical reason repeated across multiple rejected variants", async () => {
    seedListing({ status: "pending_approval", jumia_ref: "feed-1" });
    feedStatusResult = { status: "DONE", total: 2, success: 0, failed: 2, errors: [], raw: null };
    const sameError = "Attribute [capacity_liter] with the value [1.7] should be a number without decimals.";
    feedProductDetailsResult = [
      { sellerSku: "SKU-1", productSid: null, qcStatus: "rejected", errors: [sameError] },
      { sellerSku: "SKU-2", productSid: null, qcStatus: "rejected", errors: [sameError] },
    ];

    const resolution = await refreshPendingFeedStatus("tok", {
      id: "listing-1", status: "pending_approval", jumia_ref: "feed-1",
    });

    expect(resolution.error).toBe(sameError);
  });
});
