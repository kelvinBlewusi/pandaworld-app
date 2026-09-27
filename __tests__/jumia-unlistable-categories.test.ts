/**
 * Per-country category blocklist (lib/jumia/unlistable-categories.ts).
 *
 * Real case, 2026-09-27: a power bank was rejected in "Portable Power
 * Banks" with Jumia's "You can't list products in this category", and the
 * fix-and-resubmit redraft went straight to "External Battery Packs", which
 * Jumia also refused. The redraft only avoided the one category it had just
 * failed on, and nothing remembered either rejection for the next seller.
 * Now any such rejection blocks that category for the seller's country.
 * Blocking is per country because each Jumia country runs its own Vendor
 * Center.
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
  blockedCategoryCodes,
  isUnlistableCategoryError,
  unblockCategory,
  withoutBlocked,
} from "@/lib/jumia/unlistable-categories";

const JUMIA_ERROR = "You can't list products in this category. Please choose a different (more specific) category and try again.";

function blocklist() {
  return (db.tables.jumia_unlistable_categories ?? []) as Record<string, unknown>[];
}

beforeEach(() => {
  db.tables.listings = [
    { id: "listing-gh", user_id: "user_gh" },
    { id: "listing-ng", user_id: "user_ng" },
    { id: "listing-none", user_id: "user_unconnected" },
  ];
  db.tables.jumia_connections = [
    { user_id: "user_gh", country: "GH" },
    { user_id: "user_ng", country: "NG" },
  ];
  db.tables.jumia_feed_outcomes = [];
  db.tables.jumia_unlistable_categories = [];
});

describe("isUnlistableCategoryError", () => {
  it("matches Jumia's wording with a straight, curly, or missing apostrophe", () => {
    expect(isUnlistableCategoryError(JUMIA_ERROR)).toBe(true);
    expect(isUnlistableCategoryError("You can’t list products in this category.")).toBe(true);
    expect(isUnlistableCategoryError("You cant list products in this category")).toBe(true);
  });

  it("doesn't match other rejections, which say nothing about the category itself", () => {
    expect(isUnlistableCategoryError("This product is only allowed for Verified Sellers Only")).toBe(false);
    expect(isUnlistableCategoryError("Brand is invalid")).toBe(false);
    expect(isUnlistableCategoryError(null)).toBe(false);
    expect(isUnlistableCategoryError(undefined)).toBe(false);
  });
});

describe("logFeedOutcome: recording the blocklist", () => {
  it("resolves the country from the listing's owner when the caller doesn't pass one", async () => {
    await logFeedOutcome({ listingId: "listing-gh", categoryCode: "1000176", outcome: "rejected", rawError: JUMIA_ERROR });

    expect(db.tables.jumia_feed_outcomes[0]).toMatchObject({ country: "GH" });
    expect(blocklist()).toEqual([expect.objectContaining({ country: "GH", category_code: 1000176, last_error: JUMIA_ERROR })]);
  });

  it("blocks after one rejection, and counts further ones on the same row", async () => {
    await logFeedOutcome({ listingId: "listing-gh", categoryCode: "1000176", outcome: "rejected", rawError: JUMIA_ERROR });
    await logFeedOutcome({ listingId: "listing-gh", categoryCode: "1000176", outcome: "rejected", rawError: JUMIA_ERROR });

    expect(blocklist()).toHaveLength(1);
    expect(blocklist()[0]).toMatchObject({ rejection_count: 2 });
  });

  it("keys the block by country, so the same category stays open elsewhere", async () => {
    await logFeedOutcome({ listingId: "listing-gh", categoryCode: "1000176", outcome: "rejected", rawError: JUMIA_ERROR });

    expect(await blockedCategoryCodes("GH")).toEqual(new Set([1000176]));
    expect(await blockedCategoryCodes("NG")).toEqual(new Set());
  });

  it("prefers the caller's country over the lookup", async () => {
    await logFeedOutcome({ listingId: "listing-gh", country: "KE", categoryCode: "1000176", outcome: "rejected", rawError: JUMIA_ERROR });
    expect(blocklist()[0]).toMatchObject({ country: "KE" });
  });

  it("doesn't block on any other rejection: the product was the problem, not the category", async () => {
    await logFeedOutcome({ listingId: "listing-gh", categoryCode: "1000176", outcome: "rejected", rawError: "Brand is invalid" });
    expect(blocklist()).toHaveLength(0);
  });

  it("doesn't block on a live or locally blocked outcome", async () => {
    await logFeedOutcome({ listingId: "listing-gh", categoryCode: "1000176", outcome: "live", rawError: JUMIA_ERROR });
    await logFeedOutcome({ listingId: "listing-gh", categoryCode: "1000176", outcome: "blocked_locally", rawError: JUMIA_ERROR });
    expect(blocklist()).toHaveLength(0);
  });

  it("doesn't block when the seller has no Jumia connection, since there's no country to block it in", async () => {
    await logFeedOutcome({ listingId: "listing-none", categoryCode: "1000176", outcome: "rejected", rawError: JUMIA_ERROR });

    expect(db.tables.jumia_feed_outcomes).toHaveLength(1);
    expect(blocklist()).toHaveLength(0);
  });

  it("ignores a missing or non-numeric category code", async () => {
    await logFeedOutcome({ listingId: "listing-gh", outcome: "rejected", rawError: JUMIA_ERROR });
    await logFeedOutcome({ listingId: "listing-gh", categoryCode: "abc", outcome: "rejected", rawError: JUMIA_ERROR });
    expect(blocklist()).toHaveLength(0);
  });
});

describe("blockedCategoryCodes", () => {
  it("is empty for an unknown country, so a seller with no connection keeps today's behaviour", async () => {
    db.tables.jumia_unlistable_categories = [{ country: "GH", category_code: 1000176 }];
    expect(await blockedCategoryCodes(null)).toEqual(new Set());
  });
});

describe("unblockCategory", () => {
  it("removes only that country's row", async () => {
    db.tables.jumia_unlistable_categories = [
      { country: "GH", category_code: 1000176 },
      { country: "NG", category_code: 1000176 },
      { country: "GH", category_code: 1017621 },
    ];

    await unblockCategory("GH", 1000176);

    expect(await blockedCategoryCodes("GH")).toEqual(new Set([1017621]));
    expect(await blockedCategoryCodes("NG")).toEqual(new Set([1000176]));
  });
});

describe("withoutBlocked", () => {
  it("drops blocked codes whether the rows carry them as numbers or strings", () => {
    const rows = [{ code: 1000176 }, { code: "1017621" }, { code: 1000279 }];
    expect(withoutBlocked(rows, new Set([1000176, 1017621]))).toEqual([{ code: 1000279 }]);
  });

  it("returns the input untouched when nothing is blocked", () => {
    const rows = [{ code: 1 }];
    expect(withoutBlocked(rows, new Set())).toBe(rows);
  });
});
