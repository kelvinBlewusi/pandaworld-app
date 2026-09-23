/**
 * removeAttributesFromCache — the correction step for the
 * "not_visible_attributes" rejection remedy (lib/jumia/rejection-remedy.ts).
 * Live rejection (2026-09-21, category 1022994 "Compact Refrigerators"):
 * Jumia's real per-category validation rejects several attributes our
 * cached schema still lists as valid. This deletes exactly the named rows
 * so preflightAttributes (lib/jumia/preflight.ts) — which already drops
 * anything not present in the cached schema — naturally excludes them from
 * every future push, with no redraft required.
 */

interface Call {
  categoryCode: number;
  names:        string[];
}

const calls: Call[] = [];

function makeFakeDb() {
  return {
    from(name: string) {
      if (name !== "jumia_category_attributes") throw new Error(`unexpected table ${name}`);
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
                  calls.push({ categoryCode: categoryCode as number, names });
                  return Promise.resolve({ data: null, error: null });
                },
              };
            },
          };
        },
      };
    },
  };
}

jest.mock("@/lib/supabase/server", () => ({
  createServerClient: () => makeFakeDb(),
}));

import { removeAttributesFromCache } from "@/lib/jumia/categories";

describe("removeAttributesFromCache", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("deletes exactly the named attributes for the given category", async () => {
    await removeAttributesFromCache(1022994, ["color_family", "main_material", "manufacturer_txt"]);
    expect(calls).toEqual([
      { categoryCode: 1022994, names: ["color_family", "main_material", "manufacturer_txt"] },
    ]);
  });

  it("does nothing when given an empty list of names", async () => {
    await removeAttributesFromCache(1022994, []);
    expect(calls).toEqual([]);
  });
});
