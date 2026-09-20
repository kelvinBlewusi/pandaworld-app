/**
 * Regression coverage for recomputeIsLeafForAllCategories, rewritten
 * 2026-09-20 after a live incident: the old O(n²) all-pairs prefix scan
 * (~768,000,000 string comparisons for the real 27,720-row table) is
 * almost certainly why is_leaf sat wrong for nearly every category in
 * production — 27,719 of 27,720 rows read false — silently turning the
 * AI's "prefer a leaf over a parent category" ranking into a no-op. The
 * new version only checks each row's IMMEDIATE parent, which is enough
 * because Jumia's category feed returns every level of the tree (not
 * just leaves), so a genuine descendant several levels down always
 * implies a direct child too. These tests exist to keep that equivalence
 * true, especially across more than one level of depth.
 */

interface CategoryRow {
  code:    number;
  path:    string;
  is_leaf: boolean | null;
}

function makeFakeDb(rows: CategoryRow[]) {
  const table = rows.map((r) => ({ ...r }));
  const upserted: Array<{ code: number; is_leaf: boolean }> = [];

  return {
    table,
    upserted,
    from(name: string) {
      if (name !== "jumia_categories") throw new Error(`unexpected table ${name}`);
      return {
        select() {
          return {
            range(from: number, to: number) {
              return Promise.resolve({ data: table.slice(from, to + 1), error: null });
            },
          };
        },
        upsert(payload: Array<{ code: number; is_leaf: boolean }>) {
          upserted.push(...payload);
          for (const u of payload) {
            const row = table.find((r) => r.code === u.code);
            if (row) row.is_leaf = u.is_leaf;
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };
}

let fakeDb: ReturnType<typeof makeFakeDb>;

jest.mock("@/lib/supabase/server", () => ({
  createServerClient: () => fakeDb,
}));

import { recomputeIsLeafForAllCategories } from "@/lib/jumia/categories";

describe("recomputeIsLeafForAllCategories", () => {
  it("marks a category with a child as non-leaf, and a childless one as a leaf", async () => {
    fakeDb = makeFakeDb([
      { code: 1, path: "Home & Office > Home & Kitchen > Home Decor", is_leaf: false },
      { code: 2, path: "Home & Office > Home & Kitchen > Home Decor > Curtains", is_leaf: false },
      { code: 3, path: "Miscellaneous", is_leaf: false },
    ]);

    await recomputeIsLeafForAllCategories();

    expect(fakeDb.table.find((r) => r.code === 1)?.is_leaf).toBe(false); // Home Decor has a child
    expect(fakeDb.table.find((r) => r.code === 2)?.is_leaf).toBe(true);  // Curtains has none
    expect(fakeDb.table.find((r) => r.code === 3)?.is_leaf).toBe(true);  // top-level, no children
  });

  it("marks every ancestor non-leaf through more than one level", () => {
    return (async () => {
      fakeDb = makeFakeDb([
        { code: 10, path: "A", is_leaf: false },
        { code: 11, path: "A > B", is_leaf: false },
        { code: 12, path: "A > B > C", is_leaf: false },
      ]);

      await recomputeIsLeafForAllCategories();

      // A grandparent has no DIRECT child in this fixture, only a
      // grandchild — checking only the immediate level is only correct
      // because every intermediate node is itself a real row (as Jumia's
      // feed guarantees); "A > B" being a real row is what lets "A" see
      // it as a direct child and come out non-leaf too.
      expect(fakeDb.table.find((r) => r.code === 10)?.is_leaf).toBe(false);
      expect(fakeDb.table.find((r) => r.code === 11)?.is_leaf).toBe(false);
      expect(fakeDb.table.find((r) => r.code === 12)?.is_leaf).toBe(true);
    })();
  });

  it("is case-insensitive about path casing", async () => {
    fakeDb = makeFakeDb([
      { code: 20, path: "Fashion > Shoes", is_leaf: false },
      { code: 21, path: "FASHION > SHOES > Sneakers", is_leaf: false },
    ]);

    await recomputeIsLeafForAllCategories();

    expect(fakeDb.table.find((r) => r.code === 20)?.is_leaf).toBe(false);
    expect(fakeDb.table.find((r) => r.code === 21)?.is_leaf).toBe(true);
  });

  it("only writes back rows whose is_leaf actually changed", async () => {
    fakeDb = makeFakeDb([
      { code: 30, path: "Electronics > Kettles > Electric Kettles", is_leaf: true },
      { code: 31, path: "Electronics > Kettles", is_leaf: false },
    ]);

    const result = await recomputeIsLeafForAllCategories();

    expect(result).toEqual({ updated: 0, total: 2 });
    expect(fakeDb.upserted).toEqual([]);
  });

  it("reports how many rows changed", async () => {
    fakeDb = makeFakeDb([
      { code: 40, path: "Electronics > Kettles > Electric Kettles", is_leaf: false },
      { code: 41, path: "Electronics > Kettles", is_leaf: true },
    ]);

    const result = await recomputeIsLeafForAllCategories();

    expect(result).toEqual({ updated: 2, total: 2 });
  });
});
