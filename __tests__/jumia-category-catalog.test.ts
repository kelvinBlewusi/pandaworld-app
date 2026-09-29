/**
 * The category catalog loader (lib/jumia/categories.ts).
 *
 * Downloading the catalog was most of the project's Supabase egress: two
 * paged reads of ~8.6 MB each (listable, then the full tree, which differ
 * by one row) for every new server instance. It's now one compact
 * category_catalog() call per instance, shared by every reader, with the
 * old paged read kept as a fallback.
 */

const rpc = jest.fn();
const pagedReads: { from: number; to: number }[] = [];
let pagedRows: Record<string, unknown>[] = [];

function pagedQuery() {
  const q = {
    select: () => q,
    order:  () => q,
    range:  (from: number, to: number) => {
      pagedReads.push({ from, to });
      return Promise.resolve({ data: pagedRows.slice(from, to + 1), error: null });
    },
  };
  return q;
}

jest.mock("@/lib/supabase/server", () => ({
  createServerClient: () => ({ rpc: (...args: unknown[]) => rpc(...args), from: () => pagedQuery() }),
}));

import {
  getAllCategoriesForTree,
  getLeafCategories,
  getListableCategories,
  invalidateListableCategoriesCache,
} from "@/lib/jumia/categories";

// category_catalog()'s column order: code, name, path, parent_code, level,
// is_leaf, attribute_set_sid, attribute_set_name.
const TUPLES = [
  [100, "Phones & Tablets", "Phones & Tablets", null, 1, false, null, null],
  [101, "Power Banks", "Phones & Tablets > Power Banks", 100, 2, true, "sid-1", "Accessories"],
  [102, "Watches", "Fashion > Watches", 200, 2, false, "sid-2", "Watches"],
];

beforeEach(() => {
  invalidateListableCategoriesCache();
  rpc.mockReset();
  pagedReads.length = 0;
  pagedRows = [];
});

it("reads the catalog once, in one call, for every kind of reader", async () => {
  rpc.mockResolvedValue({ data: TUPLES, error: null });

  const all = await getAllCategoriesForTree();
  const listable = await getListableCategories();
  const leaves = await getLeafCategories();

  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc).toHaveBeenCalledWith("category_catalog");
  expect(pagedReads).toHaveLength(0);

  expect(all[1]).toEqual({
    code: 101, name: "Power Banks", path: "Phones & Tablets > Power Banks", parent_code: 100,
    level: 2, is_leaf: true, attribute_set_sid: "sid-1", attribute_set_name: "Accessories",
  });
  expect(all.map((c) => c.code)).toEqual([100, 101, 102]);
  // Listable = has an attribute set (a listable parent like Watches counts).
  expect(listable.map((c) => c.code)).toEqual([101, 102]);
  expect(leaves.map((c) => c.code)).toEqual([101]);
});

it("falls back to paging the table when the function isn't there", async () => {
  rpc.mockResolvedValue({ data: null, error: { message: "Could not find the function public.category_catalog" } });
  pagedRows = TUPLES.map(([code, name, path, parent_code, level, is_leaf, attribute_set_sid, attribute_set_name]) =>
    ({ code, name, path, parent_code, level, is_leaf, attribute_set_sid, attribute_set_name }));

  const listable = await getListableCategories();

  expect(listable.map((c) => c.code)).toEqual([101, 102]);
  expect(pagedReads.length).toBeGreaterThan(0);
});

it("reloads after the cache is invalidated", async () => {
  rpc.mockResolvedValue({ data: TUPLES, error: null });
  await getAllCategoriesForTree();
  invalidateListableCategoriesCache();
  await getAllCategoriesForTree();
  expect(rpc).toHaveBeenCalledTimes(2);
});
