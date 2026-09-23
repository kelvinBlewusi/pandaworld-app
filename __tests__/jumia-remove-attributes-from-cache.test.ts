/**
 * removeAttributesFromCache — the correction step for the
 * "not_visible_attributes" rejection remedy (lib/jumia/rejection-remedy.ts).
 * Live rejection (2026-09-21, category 1022994 "Compact Refrigerators"):
 * Jumia's real per-category validation rejects several attributes our
 * cached schema still lists as valid. This deletes exactly the named rows
 * so preflightAttributes (lib/jumia/preflight.ts) — which already drops
 * anything not present in the cached schema — naturally excludes them from
 * every future push, with no redraft required.
 *
 * It also records each name into jumia_excluded_attributes (2026-09-23):
 * a plain delete alone didn't last — the next cold-cache fetch for this
 * category (a different listing, a nightly or admin resync) silently
 * reinserted the same names from Jumia's own still-wrong schema response,
 * so the category regressed to rejecting every future listing filed
 * there. See upsertAttributes' own tests for the read side of that fix.
 */

interface DeleteCall {
  categoryCode: number;
  names:        string[];
}
interface ExcludeCall {
  rows: { category_code: number; name: string }[];
  onConflict: string;
}

const deleteCalls:  DeleteCall[]  = [];
const excludeCalls: ExcludeCall[] = [];

function makeFakeDb() {
  return {
    from(name: string) {
      if (name === "jumia_category_attributes") {
        return {
          delete() {
            let categoryCode: number | undefined;
            return {
              eq(col: string, value: number) {
                if (col !== "category_code") throw new Error(`unexpected eq column ${col}`);
                categoryCode = value;
                return {
                  in(nameCol: string, names: string[]) {
                    if (nameCol !== "name") throw new Error(`unexpected in column ${nameCol}`);
                    deleteCalls.push({ categoryCode: categoryCode as number, names });
                    return Promise.resolve({ data: null, error: null });
                  },
                };
              },
            };
          },
        };
      }
      if (name === "jumia_excluded_attributes") {
        return {
          upsert(rows: { category_code: number; name: string }[], opts: { onConflict: string }) {
            excludeCalls.push({ rows, onConflict: opts.onConflict });
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      throw new Error(`unexpected table ${name}`);
    },
  };
}

jest.mock("@/lib/supabase/server", () => ({
  createServerClient: () => makeFakeDb(),
}));

import { removeAttributesFromCache } from "@/lib/jumia/categories";

describe("removeAttributesFromCache", () => {
  beforeEach(() => {
    deleteCalls.length = 0;
    excludeCalls.length = 0;
  });

  it("deletes exactly the named attributes for the given category", async () => {
    await removeAttributesFromCache(1022994, ["color_family", "main_material", "manufacturer_txt"]);
    expect(deleteCalls).toEqual([
      { categoryCode: 1022994, names: ["color_family", "main_material", "manufacturer_txt"] },
    ]);
  });

  it("does nothing when given an empty list of names", async () => {
    await removeAttributesFromCache(1022994, []);
    expect(deleteCalls).toEqual([]);
    expect(excludeCalls).toEqual([]);
  });

  it("also records every removed name as permanently excluded for that category", async () => {
    await removeAttributesFromCache(1022994, ["color_family", "main_material"]);
    expect(excludeCalls).toEqual([
      {
        rows: [
          { category_code: 1022994, name: "color_family" },
          { category_code: 1022994, name: "main_material" },
        ],
        onConflict: "category_code,name",
      },
    ]);
  });
});
