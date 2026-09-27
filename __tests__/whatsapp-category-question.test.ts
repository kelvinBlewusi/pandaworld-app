/**
 * Reading the seller's answer to "which category does Vendor Center accept
 * for this product?" (lib/whatsapp/category-question.ts). Switching to a
 * category the seller didn't mean costs another Jumia rejection, so only an
 * exact name is ever applied without showing it back first.
 */

import { FakeDb } from "./helpers/fake-supabase";

const db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({
  createServerClient: () => db,
}));

import type { JumiaCategoryRow } from "@/lib/jumia/categories";
import {
  CATEGORY_SKIP_RE,
  categoryListRow,
  looksLikeCategoryAnswer,
  matchCategoryAnswer,
  refusedCategoryCodes,
  suggestCategories,
} from "@/lib/whatsapp/category-question";

function cat(code: number, path: string, patch: Partial<JumiaCategoryRow> = {}): JumiaCategoryRow {
  return {
    code,
    name:               path.split(" > ").pop()!,
    path,
    parent_code:        null,
    level:              path.split(" > ").length,
    is_leaf:            true,
    attribute_set_sid:  `sid-${code}`,
    attribute_set_name: null,
    ...patch,
  };
}

const POWER_BANKS      = cat(1, "Phones & Tablets > Accessories > Power Banks");
const EXTERNAL_BANKS   = cat(2, "Electronics > Accessories > External Power Banks");
const CHARGERS_PHONES  = cat(3, "Phones & Tablets > Accessories > Chargers");
const CHARGERS_ELEC    = cat(4, "Electronics > Accessories > Chargers");
const BATTERY_PACKS    = cat(5, "Phones & Tablets > Accessories > Portable Power Banks & Battery Packs");
const LEAVES = [POWER_BANKS, EXTERNAL_BANKS, CHARGERS_PHONES, CHARGERS_ELEC, BATTERY_PACKS];

describe("matchCategoryAnswer", () => {
  it("applies an exact name, ignoring case and plurals", () => {
    expect(matchCategoryAnswer("power bank", LEAVES, new Set())).toEqual({
      kind: "match", category: { code: 1, name: "Power Banks", path: POWER_BANKS.path },
    });
  });

  it("reads '&' and 'and' as the same word", () => {
    const answer = matchCategoryAnswer("Portable power banks and battery packs", LEAVES, new Set());
    expect(answer).toMatchObject({ kind: "match", category: { code: 5 } });
  });

  it("doesn't treat a name as matching a longer one that merely ends with it", () => {
    // "External Power Banks" ends in "power banks" but is a different category.
    const answer = matchCategoryAnswer("Power Banks", LEAVES, new Set());
    expect(answer).toMatchObject({ kind: "match", category: { code: 1 } });
  });

  it("asks which one when several categories share the name", () => {
    const answer = matchCategoryAnswer("Chargers", LEAVES, new Set());
    expect(answer).toMatchObject({ kind: "choose", exact: true });
    expect((answer as { options: { code: number }[] }).options.map((o) => o.code).sort()).toEqual([3, 4]);
  });

  it("settles a shared name when the seller types the path", () => {
    const answer = matchCategoryAnswer("Electronics > Accessories > Chargers", LEAVES, new Set());
    expect(answer).toMatchObject({ kind: "match", category: { code: 4 } });
  });

  it("uses the one left when the other category with that name is refused", () => {
    const answer = matchCategoryAnswer("Chargers", LEAVES, new Set([3]));
    expect(answer).toMatchObject({ kind: "match", category: { code: 4 } });
  });

  it("says so when the only category by that name is refused", () => {
    expect(matchCategoryAnswer("Power Banks", LEAVES, new Set([1]))).toEqual({ kind: "refused", name: "Power Banks" });
  });

  it("offers near matches as a list rather than guessing, and never a refused one", () => {
    const answer = matchCategoryAnswer("powerbank external", LEAVES, new Set([1]));
    expect(answer).toMatchObject({ kind: "choose", exact: false });
    const codes = (answer as { options: { code: number }[] }).options.map((o) => o.code);
    expect(codes).toContain(2);
    expect(codes).not.toContain(1);
  });

  it("finds nothing for text that names no category", () => {
    expect(matchCategoryAnswer("zzqx", LEAVES, new Set())).toEqual({ kind: "none" });
  });
});

describe("suggestCategories", () => {
  it("puts the AI's own alternates first, then title matches, without duplicates", () => {
    const suggestions = suggestCategories(
      { title: "Fast phone charger", category_alternates: [{ code: 5 }, { code: 5 }] },
      LEAVES,
    );
    expect(suggestions[0].code).toBe(5);
    expect(new Set(suggestions.map((s) => s.code)).size).toBe(suggestions.length);
    expect(suggestions.map((s) => s.code)).toEqual(expect.arrayContaining([3, 4]));
  });

  it("only suggests from the pickable set the caller passes", () => {
    const suggestions = suggestCategories(
      { title: "Power bank", category_alternates: [{ code: 1 }] },
      LEAVES.filter((c) => c.code !== 1),
    );
    expect(suggestions.map((s) => s.code)).not.toContain(1);
  });
});

describe("refusedCategoryCodes", () => {
  beforeEach(() => {
    db.tables.jumia_connections = [{ user_id: "user_gh", country: "GH" }];
    db.tables.jumia_unlistable_categories = [
      { country: "GH", category_code: 1 },
      { country: "NG", category_code: 2 },
    ];
  });

  it("is the seller's country's blocklist plus the category the listing is in now", async () => {
    expect(await refusedCategoryCodes("user_gh", "5")).toEqual(new Set([1, 5]));
  });

  it("still refuses the current category for a seller with no country", async () => {
    expect(await refusedCategoryCodes("user_unknown", "5")).toEqual(new Set([5]));
  });
});

describe("looksLikeCategoryAnswer", () => {
  it.each(["Power Banks", "phones > accessories > chargers", "Kettles"])("accepts %p", (text) => {
    expect(looksLikeCategoryAnswer(text)).toBe(true);
  });

  it.each(["3", "submit all", "submit 2", "2: change the price to 150", "fix:abc", "ok", "Thanks!", "x".repeat(121)])(
    "lets go of %p so it's handled normally",
    (text) => {
      expect(looksLikeCategoryAnswer(text)).toBe(false);
    },
  );
});

describe("CATEGORY_SKIP_RE", () => {
  it.each(["skip", "No", "I don't know", "not sure which one", "idk", "no idea"])("treats %p as a skip", (text) => {
    expect(CATEGORY_SKIP_RE.test(text)).toBe(true);
  });

  it("doesn't mistake an answer that starts with 'no' for a skip", () => {
    expect(CATEGORY_SKIP_RE.test("No, it's Power Banks")).toBe(false);
  });
});

describe("categoryListRow", () => {
  it("uses the name as the title and where it sits as the subtitle", () => {
    expect(categoryListRow("L1", { code: 1, name: "Power Banks", path: POWER_BANKS.path })).toEqual({
      id: "recat:L1:1", title: "Power Banks", description: "Phones & Tablets > Accessories",
    });
  });

  it("keeps the end of a long path, which says more than its start", () => {
    const path = `${"Very Long Department Name > ".repeat(5)}Leaf`;
    const row = categoryListRow("L1", { code: 9, name: "Leaf", path });
    expect(row.description!.length).toBeLessThanOrEqual(72);
    expect(row.description!.startsWith("…")).toBe(true);
    expect(row.description!.endsWith("Very Long Department Name")).toBe(true);
  });
});
