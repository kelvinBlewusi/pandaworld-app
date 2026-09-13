import { getTopLevelDepartments, getSubtreeCategories, searchCategoriesByText } from "@/lib/jumia/category-search";
import type { JumiaCategoryRow } from "@/lib/jumia/categories";

function row(overrides: Partial<JumiaCategoryRow> & { code: number; name: string; path: string }): JumiaCategoryRow {
  return {
    parent_code:        null,
    level:              overrides.path.split(" > ").length,
    is_leaf:            true,
    attribute_set_sid:  "sid",
    attribute_set_name: null,
    ...overrides,
  };
}

const CATALOG: JumiaCategoryRow[] = [
  row({ code: 1, name: "Computing",        path: "Computing" }),
  row({ code: 2, name: "Laptops",          path: "Computing > Computers & Accessories > Computers & Tablets > Laptops" }),
  row({ code: 3, name: "Safety",           path: "Home Improvement > Safety Equipment" }),
  row({ code: 4, name: "Helmets",          path: "Home Improvement > Safety Equipment > Helmets" }),
  row({ code: 5, name: "Hard Hats",        path: "Home Improvement > Safety Equipment > Helmets > Hard Hats" }),
  row({ code: 6, name: "Easels",           path: "Arts & Crafts > Painting Supplies > Easels" }),
  row({ code: 7, name: "Painting Supplies", path: "Arts & Crafts > Painting Supplies", attribute_set_sid: null, is_leaf: false }),
];

describe("getTopLevelDepartments", () => {
  it("returns one representative entry per top-level department, sorted", () => {
    const departments = getTopLevelDepartments(CATALOG);
    expect(departments.map((d) => d.name)).toEqual([
      "Arts & Crafts",
      "Computing",
      "Home Improvement",
    ]);
  });

  it("uses the department name as both name and path", () => {
    const departments = getTopLevelDepartments(CATALOG);
    const homeImprovement = departments.find((d) => d.name === "Home Improvement");
    expect(homeImprovement).toEqual({ name: "Home Improvement", path: "Home Improvement" });
  });
});

describe("getSubtreeCategories", () => {
  it("returns only categories under the given department", () => {
    const subtree = getSubtreeCategories(CATALOG, "Home Improvement");
    expect(subtree.map((c) => c.code).sort()).toEqual([3, 4, 5]);
  });

  it("excludes categories from other departments — confirmed live failure scenario", () => {
    // The actual bug: a safety helmet and a canvas easel both got filed
    // under "Computing > ... > Laptops" when full-catalog retrieval came
    // up empty. Scoping to the correct department must never leak in
    // unrelated categories like Laptops.
    const subtree = getSubtreeCategories(CATALOG, "Home Improvement");
    expect(subtree.some((c) => c.path.includes("Laptops"))).toBe(false);
  });

  it("returns an empty array for a department with no matching rows", () => {
    expect(getSubtreeCategories(CATALOG, "Nonexistent Department")).toEqual([]);
  });
});

describe("department-scoped fuzzy search — end-to-end sanity", () => {
  it("finds the right leaf when searching within the correct department only", () => {
    const subtree = getSubtreeCategories(CATALOG, "Home Improvement");
    const hits = searchCategoriesByText("Hard Hats", subtree, 5);
    expect(hits.some((h) => h.name === "Hard Hats" || h.name === "Helmets")).toBe(true);
    expect(hits.every((h) => h.path.startsWith("Home Improvement"))).toBe(true);
  });
});

// Regression guards for the confirmed live failure: a "Pre-Drawn Canvas Art"
// wall print was pushed to Jumia as "Icing & Decorating Spatulas" at 0.95
// confidence. Root cause was in here — Fuse's bitap matcher caps a pattern at
// 32 chars and chops anything longer into arbitrary mid-word chunks, so the
// caller's real query (title + keywords + use case + environment, always well
// past 32 chars) retrieved nothing at all, and the pipeline fell through to
// noise. See searchCategoriesByText's own comment.
describe("long queries — the 32-char bitap cliff", () => {
  const ART: JumiaCategoryRow[] = [
    row({ code: 10, name: "Pre-Stretched Canvas", path: "Home & Office > Arts, Crafts & Sewing > Painting, Drawing & Art Supplies > Boards & Canvas > Pre-Stretched Canvas" }),
    row({ code: 11, name: "Boards & Canvas",      path: "Home & Office > Arts, Crafts & Sewing > Painting, Drawing & Art Supplies > Boards & Canvas" }),
    row({ code: 12, name: "Wall Art",             path: "Home & Office > Home & Kitchen > Wall Art" }),
    row({ code: 13, name: "Icing & Decorating Spatulas", path: "Home & Office > Home & Kitchen > Kitchen & Dining > Bakeware > Decorating Tools > Icing & Decorating Spatulas" }),
    row({ code: 14, name: "Cake Decorating Supplies",    path: "Home & Office > Home & Kitchen > Event & Party Supplies > Cake Decorating Supplies" }),
  ];

  it("still returns candidates for a query far longer than 32 characters", () => {
    const long = "Pre-Drawn Canvas Art - Cartoon Character Design canvas art painting cartoon home decor";
    expect(long.length).toBeGreaterThan(32);
    // Searched as one pattern this returned literally nothing.
    expect(searchCategoriesByText(long, ART, 8).length).toBeGreaterThan(0);
  });

  it("ranks the actual product category above a category matching one incidental word", () => {
    const long = "Pre-Drawn Canvas Art - Cartoon Character Design canvas art painting cartoon home decor";
    const hits = searchCategoriesByText(long, ART, 8);
    const rank = (code: number) => hits.findIndex((h) => h.code === code);
    // "decor" must not drag the cake/icing categories above the canvas ones.
    expect(rank(10)).toBeGreaterThanOrEqual(0);
    expect(rank(10)).toBeLessThan(rank(13));
    expect(rank(10)).toBeLessThan(rank(14));
  });

  it("does not let a long query collapse to a worse result than its short form", () => {
    const short = "canvas art";
    const long  = `${short} cartoon character design painting home decor craft kids`;
    const topShort = searchCategoriesByText(short, ART, 3).map((h) => h.code);
    const topLong  = searchCategoriesByText(long,  ART, 3).map((h) => h.code);
    // Both forms must still surface a canvas category in the top 3 — the
    // long form used to surface nothing at all.
    expect(topShort.some((c) => c === 10 || c === 11)).toBe(true);
    expect(topLong.some((c) => c === 10 || c === 11)).toBe(true);
  });

  it("weights rare terms over filler that matches much of the department", () => {
    // A term's weight falls as it matches more of the pool. Here "decor"
    // is in a dozen category names and "canvas" in two, so the one word
    // that actually identifies the product has to win — measured on the
    // real catalog, unweighted terms put "Party Decorations & Supplies"
    // and "Fabric Decorating Kits" above "Pre-Stretched Canvas" for a
    // canvas art print, because filler simply outnumbered signal.
    const DECOR_HEAVY: JumiaCategoryRow[] = [
      ...ART,
      ...["Decor Bowls", "Decor Trays", "Decor Signs", "Decor Vases", "Decor Boxes",
          "Decor Mirrors", "Decor Candles", "Decor Baskets", "Decor Clocks", "Decor Frames",
      ].map((name, i) => row({ code: 100 + i, name, path: `Home & Office > Home & Kitchen > Home Decor > ${name}` })),
    ];

    const hits = searchCategoriesByText("canvas decor", DECOR_HEAVY, 5);
    expect(hits[0].code === 10 || hits[0].code === 11).toBe(true);
  });

  it("returns nothing for a query that is all filler", () => {
    expect(searchCategoriesByText("the and for with this", ART, 5)).toEqual([]);
  });
});
