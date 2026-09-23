/**
 * upsertAttributes — the one choke point every schema-cache writer goes
 * through (auto-analyze's prefetch/fallback/leaf-resolution paths, the
 * admin full-catalog sync). 2026-09-23: it now refuses to reinsert any
 * attribute jumia_excluded_attributes lists for that category — the read
 * side of the durable "not_visible_attributes" fix. Without this, the
 * very next cold-cache fetch for a category removeAttributesFromCache had
 * already corrected would silently bring the same bad attributes back
 * from Jumia's own still-wrong schema response, and every future listing
 * filed there would start hitting the identical rejection again.
 */

interface UpsertCall {
  table: string;
  rows:  Record<string, unknown>[];
}

const upsertCalls: UpsertCall[] = [];
let excludedNames: string[] = [];

function makeFakeDb() {
  return {
    from(name: string) {
      if (name === "jumia_excluded_attributes") {
        return {
          select(_cols: string) {
            return {
              eq(col: string, _value: number) {
                if (col !== "category_code") throw new Error(`unexpected eq column ${col}`);
                return Promise.resolve({ data: excludedNames.map((n) => ({ name: n })), error: null });
              },
            };
          },
        };
      }
      if (name === "jumia_category_attributes") {
        return {
          upsert(rows: Record<string, unknown>[], _opts: { onConflict: string }) {
            upsertCalls.push({ table: name, rows });
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

import { upsertAttributes, type JumiaCategoryAttribute } from "@/lib/jumia/categories";

function attr(name: string): JumiaCategoryAttribute {
  return {
    name, label: name, type: "text", allowed_values: [], required: false, is_variant: false,
  };
}

beforeEach(() => {
  upsertCalls.length = 0;
  excludedNames = [];
});

describe("upsertAttributes — no exclusions", () => {
  it("writes every attribute through unchanged when nothing is excluded", async () => {
    await upsertAttributes(1002300, [attr("color_family"), attr("manufacturer_txt")]);
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].rows.map((r) => r.name)).toEqual(["color_family", "manufacturer_txt"]);
  });

  it("does nothing for an empty attribute list", async () => {
    await upsertAttributes(1002300, []);
    expect(upsertCalls).toHaveLength(0);
  });
});

describe("upsertAttributes — durable exclusions (2026-09-23 Android Tablets/Phones incident)", () => {
  it("drops attributes jumia_excluded_attributes already lists for this category", async () => {
    excludedNames = ["color_family", "manufacturer_txt"];
    await upsertAttributes(1002300, [attr("color_family"), attr("manufacturer_txt"), attr("battery_feature")]);

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].rows.map((r) => r.name)).toEqual(["battery_feature"]);
  });

  it("writes nothing at all when every incoming attribute is excluded", async () => {
    excludedNames = ["color_family", "manufacturer_txt"];
    await upsertAttributes(1002300, [attr("color_family"), attr("manufacturer_txt")]);
    expect(upsertCalls).toHaveLength(0);
  });

  it("only excludes attributes for the category actually being written — a name excluded elsewhere still passes through here", async () => {
    // Real shape: "manufacturer_txt" might be excluded for category A but
    // perfectly valid for category B — the exclusion check is scoped by
    // category_code (see the .eq("category_code", ...) in the fake db
    // above), so a same-named attribute in a different category is
    // unaffected.
    excludedNames = []; // nothing excluded for THIS category
    await upsertAttributes(1002300, [attr("manufacturer_txt")]);
    expect(upsertCalls[0].rows.map((r) => r.name)).toEqual(["manufacturer_txt"]);
  });

  it("reassigns sort_order densely after filtering, with no gaps", async () => {
    excludedNames = ["b"];
    await upsertAttributes(1002300, [attr("a"), attr("b"), attr("c")]);
    expect(upsertCalls[0].rows.map((r) => [r.name, r.sort_order])).toEqual([
      ["a", 0],
      ["c", 1],
    ]);
  });
});
