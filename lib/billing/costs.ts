/**
 * What AI work has actually cost, from the per-call log in ai_usage
 * (lib/ai/usage.ts), set against what the same work earns in credits —
 * the numbers on /admin/billing that credit prices are checked against.
 */

import { createServerClient } from "@/lib/supabase/server";
import { SEARCH_QUERY_USD, type AiFeature } from "@/lib/ai/usage";

/** Google Search grounding is free up to this many queries a month (Gemini 3). */
export const FREE_SEARCH_QUERIES_PER_MONTH = 5_000;

export interface FeatureCost {
  feature:       AiFeature;
  runs:          number;
  calls:         number;
  tokenUsd:      number;
  searchQueries: number;
  /** Average token cost of one run (one autofill, one draft), USD. */
  usdPerRun:     number | null;
}

export interface UsageRow {
  feature:        string;
  run_id:         string | null;
  cost_usd:       number | string | null;
  search_queries: number | null;
}

/** Group logged calls into per-feature totals. Calls outside a run count as their own run. */
export function summarizeCosts(rows: UsageRow[]): FeatureCost[] {
  const byFeature = new Map<string, { runs: Set<string>; calls: number; usd: number; searches: number }>();
  rows.forEach((r, i) => {
    const f = byFeature.get(r.feature) ?? { runs: new Set<string>(), calls: 0, usd: 0, searches: 0 };
    f.runs.add(r.run_id ?? `call-${i}`);
    f.calls += 1;
    f.usd += Number(r.cost_usd ?? 0);
    f.searches += r.search_queries ?? 0;
    byFeature.set(r.feature, f);
  });
  return Array.from(byFeature.entries())
    .map(([feature, f]) => ({
      feature:       feature as AiFeature,
      runs:          f.runs.size,
      calls:         f.calls,
      tokenUsd:      f.usd,
      searchQueries: f.searches,
      usdPerRun:     f.runs.size > 0 ? f.usd / f.runs.size : null,
    }))
    .sort((a, b) => b.runs - a.runs);
}

/**
 * What search grounding would cost this month: nothing up to the free
 * allowance, SEARCH_QUERY_USD a query beyond it.
 */
export function searchOverageUsd(queriesThisMonth: number): number {
  return Math.max(0, queriesThisMonth - FREE_SEARCH_QUERIES_PER_MONTH) * SEARCH_QUERY_USD;
}

export interface UnitCosts {
  /** Extension autofills and their average cost — each one is charged. */
  autofills:     { count: number; usdEach: number | null };
  /**
   * WhatsApp / web listings: only the ones that go live are charged, so
   * every draft, redraft, category refill and fix is paid for by them.
   */
  listings:      { drafts: number; live: number; usdPerLive: number | null };
}

/** What each thing a seller pays for actually costs us. */
export function unitCosts(costs: FeatureCost[], liveListings: number): UnitCosts {
  const fill = costs.find((c) => c.feature === "extension_fill");
  const listingWork = costs.filter((c) => c.feature !== "extension_fill");
  const listingUsd = listingWork.reduce((sum, c) => sum + c.tokenUsd, 0);
  return {
    autofills: { count: fill?.runs ?? 0, usdEach: fill?.usdPerRun ?? null },
    listings:  {
      drafts:     costs.find((c) => c.feature === "listing_draft")?.runs ?? 0,
      live:       liveListings,
      usdPerLive: liveListings > 0 ? listingUsd / liveListings : null,
    },
  };
}

/** Listings that went live on Jumia since `since` (jumia_live_listings). */
export async function liveListingsSince(since: Date): Promise<number> {
  const db = createServerClient();
  const { count, error } = await db
    .from("jumia_live_listings")
    .select("listing_id", { count: "exact", head: true })
    .gte("went_live_at", since.toISOString());
  if (error) throw new Error(`Couldn't count live listings: ${error.message}`);
  return count ?? 0;
}

/** Logged calls since `since`, newest first, capped (the admin page's window). */
export async function usageSince(since: Date, cap = 20_000): Promise<UsageRow[]> {
  const db = createServerClient();
  const { data, error } = await db
    .from("ai_usage")
    .select("feature, run_id, cost_usd, search_queries")
    .gte("created_at", since.toISOString())
    .order("created_at", { ascending: false })
    .limit(cap);
  if (error) throw new Error(`Couldn't read ai_usage: ${error.message}`);
  return (data ?? []) as UsageRow[];
}
