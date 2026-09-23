/**
 * resolveNonLeafCategory (lib/actions/auto-analyze.ts) — the hard backstop
 * against pushing a category Jumia will reject outright.
 *
 * Real batch, 2026-09-23: 5 of 7 failures in one 10-listing batch were
 * Jumia's "You can't list products in this category. Please choose a
 * different (more specific) category and try again." — every one of them
 * a category our OWN listableCategories rows already flagged is_leaf=false
 * (Refrigerators & Freezers, Mixers & Blenders, Chargers & Power Adapters,
 * Tabletop Lighting, T-shirts). is_leaf was already surfaced to the AI's
 * pick prompt as a soft hint, but nothing enforced it — a non-leaf pick
 * sailed straight through to a real push every time. This function is the
 * enforcement: re-rank among the non-leaf's own leaf descendants, or
 * signal "nothing to resolve to" so the caller bails to manual pick
 * instead of persisting a guaranteed rejection.
 */

import type { JumiaCategoryRow } from "@/lib/jumia/categories";

type RankResult = { primary: { code: number; name: string; path: string; confidence: number } | null; alternates: unknown[]; needsUserConfirmation: boolean };

let rankResult: RankResult = { primary: null, alternates: [], needsUserConfirmation: true };
const rankCalls: { candidateCodes: number[] }[] = [];
let fillResult: { dynamic_attributes: Record<string, string>; field_sources: Record<string, "ai">; field_confidence: Record<string, unknown> } =
  { dynamic_attributes: {}, field_sources: {}, field_confidence: {} };

jest.mock("@/lib/actions/ai", () => ({
  ...jest.requireActual("@/lib/actions/ai"),
  aiPassB_rankCategory: async (
    _images: string[],
    candidates: { code: number }[],
  ) => {
    rankCalls.push({ candidateCodes: candidates.map((c) => c.code) });
    return rankResult;
  },
  extractAttributesForCategory: async () => fillResult,
}));

let cachedAttrs: Record<number, { name: string }[]> = {};
const fetchFromJumiaCalls: string[] = [];
const upsertCalls: { code: number; attrs: unknown[] }[] = [];

jest.mock("@/lib/jumia/categories", () => ({
  ...jest.requireActual("@/lib/jumia/categories"),
  getCategoryAttributes: async (code: number) => cachedAttrs[code] ?? [],
  fetchAttributesFromJumia: async (_token: string, sid: string) => {
    fetchFromJumiaCalls.push(sid);
    return [{ name: "color" }];
  },
  upsertAttributes: async (code: number, attrs: unknown[]) => {
    upsertCalls.push({ code, attrs });
  },
}));

import { resolveNonLeafCategory } from "@/lib/actions/auto-analyze";

function row(patch: Partial<JumiaCategoryRow> & { code: number; path: string }): JumiaCategoryRow {
  return {
    name: patch.path.split(" > ").pop() ?? patch.path,
    parent_code: null,
    level: patch.path.split(" > ").length,
    is_leaf: false,
    attribute_set_sid: null,
    attribute_set_name: null,
    ...patch,
  };
}

const NON_LEAF = row({ code: 1016069, path: "Electronics > Home Appliances > Refrigerators & Freezers", is_leaf: false });

beforeEach(() => {
  rankResult = { primary: null, alternates: [], needsUserConfirmation: true };
  rankCalls.length = 0;
  fillResult = { dynamic_attributes: {}, field_sources: {}, field_confidence: {} };
  cachedAttrs = {};
  fetchFromJumiaCalls.length = 0;
  upsertCalls.length = 0;
});

describe("resolveNonLeafCategory — no leaf descendant exists", () => {
  it("returns null (bail to manual pick) rather than re-ranking against nothing", async () => {
    const result = await resolveNonLeafCategory(
      NON_LEAF, [NON_LEAF], ["https://cdn.test/a.jpg"], null, null, undefined, null,
    );
    expect(result).toBeNull();
    expect(rankCalls).toHaveLength(0);
  });
});

describe("resolveNonLeafCategory — leaf descendants exist", () => {
  const LEAF_A = row({ code: 1016095, path: "Electronics > Home Appliances > Refrigerators & Freezers > Refrigerators", is_leaf: true, attribute_set_sid: "sid-a" });
  const LEAF_B = row({ code: 1016096, path: "Electronics > Home Appliances > Refrigerators & Freezers > Freezers", is_leaf: true, attribute_set_sid: "sid-b" });
  const UNRELATED_LEAF = row({ code: 999, path: "Fashion > Men's Wear > Shirts", is_leaf: true });
  const pool = [NON_LEAF, LEAF_A, LEAF_B, UNRELATED_LEAF];

  it("only offers the non-leaf's own descendants to the re-rank, never the whole pool", async () => {
    rankResult = { primary: { code: 1016095, name: "Refrigerators", path: LEAF_A.path, confidence: 0.9 }, alternates: [], needsUserConfirmation: false };
    await resolveNonLeafCategory(NON_LEAF, pool, ["https://cdn.test/a.jpg"], null, null, undefined, null);

    expect(rankCalls).toHaveLength(1);
    expect(rankCalls[0].candidateCodes.sort()).toEqual([1016095, 1016096]);
  });

  it("resolves to the re-ranked leaf and fills its attributes", async () => {
    rankResult = { primary: { code: 1016095, name: "Refrigerators", path: LEAF_A.path, confidence: 0.9 }, alternates: [], needsUserConfirmation: false };
    fillResult = { dynamic_attributes: { color: "Silver" }, field_sources: { color: "ai" }, field_confidence: {} };

    const result = await resolveNonLeafCategory(NON_LEAF, pool, ["https://cdn.test/a.jpg"], null, null, undefined, null);

    expect(result).not.toBeNull();
    expect(result!.ranked.primary?.code).toBe(1016095);
    expect(result!.filled.dynamic_attributes).toEqual({ color: "Silver" });
  });

  it("returns null when the model can't pick a leaf either — never falls back to the non-leaf itself", async () => {
    rankResult = { primary: null, alternates: [], needsUserConfirmation: true };
    const result = await resolveNonLeafCategory(NON_LEAF, pool, ["https://cdn.test/a.jpg"], null, null, undefined, null);
    expect(result).toBeNull();
  });

  it("prefetches the leaf's schema from Jumia when it isn't cached yet, then fills from it", async () => {
    rankResult = { primary: { code: 1016095, name: "Refrigerators", path: LEAF_A.path, confidence: 0.9 }, alternates: [], needsUserConfirmation: false };
    cachedAttrs = {}; // cold cache for the leaf

    await resolveNonLeafCategory(NON_LEAF, pool, ["https://cdn.test/a.jpg"], null, null, undefined, "tok");

    expect(fetchFromJumiaCalls).toEqual(["sid-a"]);
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].code).toBe(1016095);
  });

  it("skips the Jumia prefetch when the leaf's schema is already cached", async () => {
    rankResult = { primary: { code: 1016095, name: "Refrigerators", path: LEAF_A.path, confidence: 0.9 }, alternates: [], needsUserConfirmation: false };
    cachedAttrs = { 1016095: [{ name: "color" }] };

    await resolveNonLeafCategory(NON_LEAF, pool, ["https://cdn.test/a.jpg"], null, null, undefined, "tok");

    expect(fetchFromJumiaCalls).toHaveLength(0);
    expect(upsertCalls).toHaveLength(0);
  });
});
