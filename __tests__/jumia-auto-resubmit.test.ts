/**
 * A listing Jumia refused only for fields its category doesn't show goes
 * back without the seller tapping Fix (lib/jumia/auto-resubmit.ts), a few
 * times a day at most.
 */
import { FakeDb } from "./helpers/fake-supabase";

let db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({ createServerClient: () => db }));

const pushed: string[] = [];
let pushOk = true;
jest.mock("@/lib/jumia/push-listing", () => ({
  pushListingToJumia: async (_userId: string, listingId: string) => {
    pushed.push(listingId);
    return pushOk ? { ok: true } : { ok: false, code: "validation", message: "price is required." };
  },
}));

import { resubmitWithoutHiddenFields } from "@/lib/jumia/auto-resubmit";

const hidden = "Attribute [warranty_type] is not visible for category [Refrigerators]. Attribute [product_line] is not visible for category [Refrigerators].";

function rejections(n: number) {
  db.tables.jumia_feed_outcomes = Array.from({ length: n }, (_, i) => ({
    listing_id: "listing-1", feed_id: `feed-${i}`, outcome: "rejected", created_at: new Date().toISOString(),
  }));
}

beforeEach(() => {
  db = new FakeDb();
  pushed.length = 0;
  pushOk = true;
});

it("sends a listing refused only for hidden fields straight back", async () => {
  rejections(1);
  expect(await resubmitWithoutHiddenFields("user_1", "listing-1", hidden)).toBe(true);
  expect(pushed).toEqual(["listing-1"]);
});

it("counts one rejection per feed, however many variants it logged", async () => {
  rejections(3);
  db.tables.jumia_feed_outcomes.push({ listing_id: "listing-1", feed_id: "feed-0", outcome: "rejected", created_at: new Date().toISOString() });
  expect(await resubmitWithoutHiddenFields("user_1", "listing-1", hidden)).toBe(true);
});

it("leaves it to the seller after three rejections in a day", async () => {
  rejections(4);
  expect(await resubmitWithoutHiddenFields("user_1", "listing-1", hidden)).toBe(false);
  expect(pushed).toEqual([]);
});

it("leaves any other rejection to the seller", async () => {
  rejections(1);
  expect(await resubmitWithoutHiddenFields("user_1", "listing-1", `${hidden} The column [product_weight] is missing from the file.`)).toBe(false);
  expect(await resubmitWithoutHiddenFields("user_1", "listing-1", null)).toBe(false);
  expect(pushed).toEqual([]);
});

it("tells the caller when the push itself didn't go", async () => {
  rejections(1);
  pushOk = false;
  expect(await resubmitWithoutHiddenFields("user_1", "listing-1", hidden)).toBe(false);
});
