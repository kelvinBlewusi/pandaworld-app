/**
 * The category catalog loader (lib/jumia/categories.ts).
 *
 * One copy of the catalog per server process, shared by every reader and by
 * concurrent callers. On 2026-09-29 two drafting runs started six catalog
 * loads at once: the database timed out, both runs overran Vercel's 60s
 * limit, and a 3-product batch sat for 6 minutes.
 */

const pageRequests: { from: number; to: number; order: string[] }[] = [];
let tableRows: Record<string, unknown>[] = [];

function pagedQuery() {
  const order: string[] = [];
  const q = {
    select: () => q,
    order:  (col: string) => { order.push(col); return q; },
    range:  (from: number, to: number) => {
      pageRequests.push({ from, to, order });
      // Let other callers run before this page answers, as a real request would.
      return new Promise((resolve) => setTimeout(() => resolve({ data: tableRows.slice(from, to + 1), error: null }), 5));
    },
  };
  return q;
}

jest.mock("@/lib/supabase/server", () => ({
  createServerClient: () => ({ from: () => pagedQuery() }),
}));

import {
  getAllCategoriesForTree,
  getLeafCategories,
  getListableCategories,
  invalidateListableCategoriesCache,
} from "@/lib/jumia/categories";

// In primary-key order, as the table pages come back.
const ROWS = [
  { code: 100, name: "Phones & Tablets", path: "Phones & Tablets", parent_code: null, level: 1, is_leaf: false, attribute_set_sid: null, attribute_set_name: null },
  { code: 101, name: "Power Banks", path: "Phones & Tablets > Power Banks", parent_code: 100, level: 2, is_leaf: true, attribute_set_sid: "sid-1", attribute_set_name: "Accessories" },
  { code: 102, name: "Watches", path: "Fashion > Watches", parent_code: 200, level: 2, is_leaf: false, attribute_set_sid: "sid-2", attribute_set_name: "Watches" },
  { code: 103, name: "Earbuds", path: "Electronics > Earbuds", parent_code: 300, level: 2, is_leaf: true, attribute_set_sid: "sid-3", attribute_set_name: "Audio" },
];

beforeEach(() => {
  invalidateListableCategoriesCache();
  pageRequests.length = 0;
  tableRows = ROWS;
});

it("loads the catalog once for concurrent readers of every kind", async () => {
  const [all, listable, leaves, again] = await Promise.all([
    getAllCategoriesForTree(),
    getListableCategories(),
    getLeafCategories(),
    getListableCategories(),
  ]);

  // One paged load (one parallel batch of pages), not one per caller.
  const firstPages = pageRequests.filter((r) => r.from === 0);
  expect(firstPages).toHaveLength(1);
  // Read in key order, which the database serves from its index.
  expect(pageRequests[0].order).toEqual(["code"]);

  // Sorted by name for callers, as they always got it.
  expect(all.map((c) => c.name)).toEqual(["Earbuds", "Phones & Tablets", "Power Banks", "Watches"]);
  // Listable = has an attribute set (a listable parent like Watches counts).
  expect(listable.map((c) => c.code)).toEqual([103, 101, 102]);
  expect(again).toBe(listable);
  expect(leaves.map((c) => c.code)).toEqual([103, 101]);
});

it("serves later reads from the cache", async () => {
  await getAllCategoriesForTree();
  const loaded = pageRequests.length;
  await getListableCategories();
  expect(pageRequests.length).toBe(loaded);
});

it("reloads after the cache is invalidated", async () => {
  await getAllCategoriesForTree();
  invalidateListableCategoriesCache();
  await getAllCategoriesForTree();
  expect(pageRequests.filter((r) => r.from === 0)).toHaveLength(2);
});
