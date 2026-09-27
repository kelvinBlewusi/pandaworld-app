/**
 * Per-call AI cost logging (lib/ai/usage.ts) — the measured spend credit
 * prices get set from.
 */

import { FakeDb } from "./helpers/fake-supabase";

const db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({
  createServerClient: () => db,
}));

import { readUsage, recordAiUsage, tokenCostUsd, withAiUsageContext } from "@/lib/ai/usage";

const rows = () => (db.tables.ai_usage ?? []) as Record<string, unknown>[];

beforeEach(() => {
  db.tables.ai_usage = [];
});

describe("readUsage", () => {
  it("reads the newer SDK's counts, thinking tokens included", () => {
    expect(readUsage({
      usageMetadata: { promptTokenCount: 5000, candidatesTokenCount: 800, thoughtsTokenCount: 300, totalTokenCount: 6100 },
    })).toEqual({ promptTokens: 5000, outputTokens: 800, thoughtTokens: 300, searchQueries: 0 });
  });

  it("derives thinking tokens from the total when the older SDK doesn't break them out", () => {
    expect(readUsage({ usageMetadata: { promptTokenCount: 5000, candidatesTokenCount: 800, totalTokenCount: 6000 } }))
      .toMatchObject({ thoughtTokens: 200 });
  });

  it("counts Google Search queries the model ran", () => {
    expect(readUsage({
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      candidates: [{ groundingMetadata: { webSearchQueries: ["power bank 20000mah", "oraimo power bank"] } }],
    })).toMatchObject({ searchQueries: 2 });
  });

  it("is all zeros when a response has no usage block", () => {
    expect(readUsage(undefined)).toEqual({ promptTokens: 0, outputTokens: 0, thoughtTokens: 0, searchQueries: 0 });
  });
});

describe("tokenCostUsd", () => {
  it("prices input and output (thinking bills as output)", () => {
    // 10k in at $0.25/M + (2k out + 1k thinking) at $1.50/M
    expect(tokenCostUsd({ model: "gemini-3.1-flash-lite", promptTokens: 10_000, outputTokens: 2_000, thoughtTokens: 1_000 }))
      .toBeCloseTo(0.0025 + 0.0045, 10);
  });

  it("is null for a model without a known price", () => {
    expect(tokenCostUsd({ model: "some-new-model", promptTokens: 1, outputTokens: 1, thoughtTokens: 0 })).toBeNull();
  });
});

describe("recordAiUsage", () => {
  const call = { model: "gemini-2.5-flash-lite", backend: "vertex" as const, promptTokens: 1000, outputTokens: 100, thoughtTokens: 0, searchQueries: 0 };

  it("tags every call in a run with the run's feature, user, listing and one shared run id", async () => {
    await withAiUsageContext({ feature: "listing_draft", userId: "u1", listingId: "l1" }, async () => {
      await recordAiUsage(call);
      await recordAiUsage(call);
    });

    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toMatchObject({ feature: "listing_draft", user_id: "u1", listing_id: "l1" });
    expect(rows()[0].run_id).toBeTruthy();
    expect(rows()[1].run_id).toBe(rows()[0].run_id);
    expect(rows()[0].cost_usd).toBeCloseTo(0.00014, 10);
  });

  it("keeps the outer run when runs nest (a refill inside a draft)", async () => {
    await withAiUsageContext({ feature: "listing_draft", listingId: "l1" }, async () => {
      await withAiUsageContext({ feature: "category_refill", listingId: "l1" }, () => recordAiUsage(call));
    });
    expect(rows()[0]).toMatchObject({ feature: "listing_draft" });
  });

  it("gives separate runs separate ids", async () => {
    await withAiUsageContext({ feature: "extension_fill" }, () => recordAiUsage(call));
    await withAiUsageContext({ feature: "extension_fill" }, () => recordAiUsage(call));
    expect(rows()[0].run_id).not.toBe(rows()[1].run_id);
  });

  it("files a call outside any run as 'other'", async () => {
    await recordAiUsage(call);
    expect(rows()[0]).toMatchObject({ feature: "other", run_id: null });
  });
});
