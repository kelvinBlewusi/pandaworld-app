/**
 * A rejection we can fix ourselves goes back to Jumia without the seller
 * tapping Fix (lib/jumia/auto-resubmit.ts), a few times a day at most:
 * fields the category doesn't show, banned words, and a brand word Jumia's
 * quality check refused in the listing's text.
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

import { resubmitAutomatically } from "@/lib/jumia/auto-resubmit";
import { learnedRestrictedWords } from "@/lib/ai/restricted-words";

const resubmitWithoutHiddenFields = async (userId: string, listingId: string, rejection: string | null) =>
  (await resubmitAutomatically(userId, listingId, rejection)) !== null;

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

it("says nothing to the seller about hidden fields: the listing didn't change", async () => {
  rejections(1);
  expect(await resubmitAutomatically("user_1", "listing-1", hidden)).toEqual({ note: null });
});

describe("banned words", () => {
  const CAMOUFLAGE =
    "The highlighted word has been placed on the blacklist, prohibiting its usage in Ghana\n" +
    "The Attribute [ description ] contains the restricted words : camouflage;";

  // Live 2026-10-04: a costume set sat rejected for "camouflage" because
  // the seller never tapped Fix.
  it("sends it back, the word learned so the push strips it, and says what came out", async () => {
    rejections(1);
    const result = await resubmitAutomatically("user_1", "listing-1", CAMOUFLAGE);

    expect(result).toEqual({ note: 'Jumia doesn\'t allow "camouflage" in listings, so I took it out and sent it back to Jumia.' });
    expect(pushed).toEqual(["listing-1"]);
    expect(learnedRestrictedWords()).toContain("camouflage");
  });

  it("leaves it to the seller when something else is wrong too", async () => {
    rejections(1);
    expect(await resubmitAutomatically("user_1", "listing-1", `${CAMOUFLAGE}\nThe column [product_weight] is missing from the file.`)).toBeNull();
    expect(pushed).toEqual([]);
  });
});

describe("a brand word refused in quality check", () => {
  const POLICE = "quality check: Restricted Brand: Police in NAME - Seller not in approved list";

  beforeEach(() => {
    db.tables.listings = [{
      id: "listing-1",
      title: "Police Officer Role Play Costume Set - Vest, Handcuffs",
      description: "<p>A police officer costume for kids.</p>",
      highlights: null,
    }];
  });

  // Live 2026-10-05: the word, not the product, was the trouble.
  it("takes it out of the listing's text, sends it back, and says so", async () => {
    rejections(1);
    const result = await resubmitAutomatically("user_1", "listing-1", POLICE);

    expect(result).toEqual({ note: 'Jumia\'s quality check doesn\'t let your shop use "Police" in the listing, so I took it out and sent it back to Jumia.' });
    expect(db.tables.listings[0].title).toBe("Officer Role Play Costume Set - Vest, Handcuffs");
    expect(db.tables.listings[0].description).toBe("<p>A officer costume for kids.</p>");
    expect(pushed).toEqual(["listing-1"]);
    // Not learned for everyone: a shop approved for the brand may use it.
    expect(learnedRestrictedWords()).not.toContain("police");
  });

  it("leaves it to the seller when the word isn't in the text any more", async () => {
    rejections(1);
    db.tables.listings[0].title = "Officer Role Play Costume Set";
    db.tables.listings[0].description = "<p>A costume for kids.</p>";
    expect(await resubmitAutomatically("user_1", "listing-1", POLICE)).toBeNull();
    expect(pushed).toEqual([]);
  });
});

describe("autoFixKind", () => {
  it("names the fix for each kind of rejection the bot handles, and nothing for the rest", async () => {
    const { autoFixKind } = await import("@/lib/jumia/auto-resubmit");
    expect(autoFixKind(hidden)).toBe("hidden_fields");
    expect(autoFixKind("The Attribute [ description ] contains the restricted words : camouflage;")).toBe("banned_words");
    expect(autoFixKind("quality check: Restricted Brand: Police in NAME - Seller not in approved list")).toBe("brand_words");
    expect(autoFixKind("quality check: Kindly Provide Product's Health/Food Regulation Registration Number.")).toBeNull();
    expect(autoFixKind(null)).toBeNull();
  });
});
