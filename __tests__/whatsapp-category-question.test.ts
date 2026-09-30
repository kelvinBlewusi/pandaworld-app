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
  findOnJumiaTip,
  jumiaStorefront,
  looksLikeCategoryAnswer,
  matchCategoryAnswer,
  parseCategoryAnswer,
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
const CABLES_PHONES    = cat(6, "Phones & Tablets > Accessories > Cables");
const LEAVES = [POWER_BANKS, EXTERNAL_BANKS, CHARGERS_PHONES, CHARGERS_ELEC, BATTERY_PACKS, CABLES_PHONES];

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

  // Copied off a Jumia product page: starts at "Home", ends with the
  // product's own name.
  it("reads a product-page breadcrumb, skipping Home and the product name", () => {
    const answer = matchCategoryAnswer(
      "Home > Electronics > Accessories > Chargers > Oraimo 18W Fast Charger",
      LEAVES,
      new Set(),
    );
    expect(answer).toMatchObject({ kind: "match", category: { code: 4 } });
  });

  it.each([
    ["one level per line", "Home\nElectronics\nAccessories\nChargers"],
    ["the › glyph", "Electronics › Accessories › Chargers"],
    ["a spaced slash", "Electronics / Accessories / Chargers"],
  ])("reads a breadcrumb separated by %s", (_label, text) => {
    expect(matchCategoryAnswer(text, LEAVES, new Set())).toMatchObject({ kind: "match", category: { code: 4 } });
  });

  // The public site doesn't always name upper levels the way Vendor Center
  // does; the category's own name still decides it.
  it("tolerates upper levels named differently from Vendor Center", () => {
    const answer = matchCategoryAnswer("Mobile Phones & Gadgets > Phone Accessories > Power Banks", LEAVES, new Set());
    expect(answer).toMatchObject({ kind: "match", category: { code: 1 } });
  });

  it("calls a path refused when it points at the refused category, not a same-named allowed one", () => {
    const answer = matchCategoryAnswer("Phones & Tablets > Accessories > Chargers", LEAVES, new Set([3]));
    expect(answer).toEqual({ kind: "refused", name: "Chargers" });
  });

  it("offers a parent's categories, best fit for the product first", () => {
    const answer = matchCategoryAnswer("Phones & Tablets", LEAVES, new Set(), { title: "USB Charging Cable 1m" });
    expect(answer).toMatchObject({ kind: "choose", exact: false, under: "Phones & Tablets" });
    const codes = (answer as { options: { code: number }[] }).options.map((o) => o.code);
    expect(codes[0]).toBe(6);
    expect(codes.sort()).toEqual([1, 3, 5, 6]);
  });

  it("uses a category page link's name", () => {
    const answer = matchCategoryAnswer("https://www.jumia.com.gh/power-banks/", LEAVES, new Set());
    expect(answer).toMatchObject({ kind: "match", category: { code: 1 } });
  });

  it("flags a product page link, which doesn't carry its category", () => {
    expect(matchCategoryAnswer("https://www.jumia.com.gh/oraimo-power-bank-20000mah-12345.html", LEAVES, new Set()))
      .toEqual({ kind: "product_link" });
  });
});

// Real 2026-09-30 answers for a body lotion Jumia had refused twice. A
// breadcrumb copied off jumia.com.gh reached us with no separators at all,
// and the bot answered with cycling accessories and safety shoes.
describe("matchCategoryAnswer without separators", () => {
  const BODY_LOTIONS     = cat(1006357, "Health & Beauty > Beauty & Personal Care > Personal Care > Skin Care > Body > Moisturizers > Lotions");
  const BODY_LOTIONS_OLD = cat(1015946, "Health & Beauty > Personal Care > Skin Care > Body > Moisturizers > Lotions");
  const BODY_BUTTER_OLD  = cat(1015932, "Health & Beauty > Personal Care > Skin Care > Body > Moisturizers > Body Butter");
  const BABY_LOTIONS     = cat(1000269, "Health & Beauty > Baby & Child Care > Personal Care > Baby Skin Care > Lotions");
  const FACE_LOTIONS     = cat(1006849, "Health & Beauty > Beauty & Personal Care > Personal Care > Skin Care > Face > Cleansers > Creams & Lotions > Lotions");
  const DERMO_BODY_CARE  = cat(1029447, "Health & Beauty > Dermocosmetics > Skin Care > Body Care");
  const CYCLING_CARE     = cat(1006483, "Sporting Goods > Outdoor Recreation > Cycling > Accessories > Personal Care Products");
  // Every other "Lotions" Jumia has.
  const OTHER_LOTIONS = [
    cat(1004180, "Baby Products > Bathing & Skin Care > Skin Care > Lotions"),
    cat(1016188, "Health & Beauty > Personal Care > Skin Care > Face > Cleansers > Creams & Lotions > Lotions"),
    cat(1017174, "Health & Beauty > Sexual Wellness > Sensual Delights > Erotic Massage > Oils & Lotions > Lotions"),
  ];
  const SKIN = [BODY_LOTIONS, BODY_LOTIONS_OLD, BODY_BUTTER_OLD, BABY_LOTIONS, FACE_LOTIONS, DERMO_BODY_CARE, CYCLING_CARE, ...OTHER_LOTIONS];
  const refused = new Set([1015932, 1029447]);
  const codes = (a: unknown) => (a as { options: { code: number }[] }).options.map((o) => o.code).sort();

  it("reads a pasted breadcrumb whose separators were lost", () => {
    const answer = matchCategoryAnswer(
      "Home Health & Beauty Beauty & Personal Care Personal Care Skin Care Body Moisturizers Lotions",
      SKIN, refused,
    );
    expect(answer).toMatchObject({ kind: "match", category: { code: 1006357 } });
  });

  it("reads the last two names typed with or without '>' the same way", () => {
    const withArrow = matchCategoryAnswer("Moisturizers > Lotions", SKIN, refused);
    const spaced    = matchCategoryAnswer("Moisturizers  Lotions", SKIN, refused);
    expect(withArrow).toMatchObject({ kind: "choose", exact: true });
    expect(codes(withArrow)).toEqual([1006357, 1015946]);
    expect(spaced).toEqual(withArrow);
  });

  it("reads a partly separated path", () => {
    const answer = matchCategoryAnswer("Beauty & Personal Care Personal Care > Moisturizers Lotions", SKIN, refused);
    expect(answer).toMatchObject({ kind: "match", category: { code: 1006357 } });
  });

  it("keeps a multi-word name whole", () => {
    expect(matchCategoryAnswer("Body Butter", SKIN, new Set())).toMatchObject({ kind: "match", category: { code: 1015932 } });
    expect(matchCategoryAnswer("Body Butter", SKIN, refused)).toEqual({ kind: "refused", name: "Body Butter" });
  });

  it("still reads a product name at the end of the breadcrumb", () => {
    const answer = matchCategoryAnswer(
      "Home Health & Beauty Beauty & Personal Care Personal Care Skin Care Body Moisturizers Lotions Nivea Cocoa Butter Body Lotion 400ml",
      SKIN, refused,
    );
    expect(answer).toMatchObject({ kind: "match", category: { code: 1006357 } });
  });
});

describe("parseCategoryAnswer", () => {
  it("keeps the seller's wording for display", () => {
    expect(parseCategoryAnswer("Home > Phones & Tablets > Accessories").raw).toEqual(["Phones & Tablets", "Accessories"]);
  });

  it("reads a link without the scheme too", () => {
    expect(parseCategoryAnswer("jumia.com.gh/portable-power-banks").raw).toEqual(["portable power banks"]);
  });
});

describe("findOnJumiaTip", () => {
  it("names the seller's own country's Jumia site", () => {
    expect(jumiaStorefront("GH")).toBe("jumia.com.gh");
    expect(jumiaStorefront("ke")).toBe("jumia.co.ke");
    expect(findOnJumiaTip("NG")).toContain("Search jumia.com.ng for a product like this one");
  });

  it("falls back to plain 'Jumia' for an unknown country", () => {
    expect(jumiaStorefront(null)).toBe("Jumia");
    expect(jumiaStorefront("ZZ")).toBe("Jumia");
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
  it.each([
    "Power Banks",
    "phones > accessories > chargers",
    "Kettles",
    "https://www.jumia.com.gh/power-banks/",
    `Home > Phones & Tablets > Accessories > Power Banks > ${"Oraimo 20000mAh Fast Charging Power Bank ".repeat(3)}`,
  ])("accepts %p", (text) => {
    expect(looksLikeCategoryAnswer(text)).toBe(true);
  });

  it.each(["3", "submit all", "submit 2", "2: change the price to 150", "fix:abc", "ok", "Thanks!", "x".repeat(401)])(
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
