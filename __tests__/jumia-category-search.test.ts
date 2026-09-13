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
