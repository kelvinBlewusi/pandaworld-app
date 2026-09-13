/**
 * Category catalog freshness — the single-row `jumia_category_sync_health`
 * table (see supabase/migrations/2026-09-13_category-sync-health.sql)
 * written by the nightly /api/cron/check-category-freshness cron and read
 * by the admin categories page. Sync itself stays admin-triggered (see
 * AGENTS.md's category-resolution section); this only answers "has our
 * cached catalog actually drifted from Jumia's live one?" — a question
 * nothing previously checked automatically.
 */

import { createServerClient } from "@/lib/supabase/server";

export interface CategorySyncHealth {
  checkedAt:  string;
  localCount: number;
  liveCount:  number;
  isStale:    boolean;
  error:      string | null;
}

/** A drift past this many categories (either direction) counts as
 *  "stale" — small day-to-day fluctuation from Jumia adding/retiring a
 *  handful of categories is normal and not worth flagging. */
const STALE_DRIFT_THRESHOLD = 25;

export function isDriftStale(localCount: number, liveCount: number): boolean {
  return Math.abs(localCount - liveCount) > STALE_DRIFT_THRESHOLD;
}

export async function getCategorySyncHealth(): Promise<CategorySyncHealth | null> {
  const db = createServerClient();
  const { data } = await db
    .from("jumia_category_sync_health")
    .select("checked_at, local_count, live_count, is_stale, error")
    .eq("id", 1)
    .maybeSingle();
  if (!data) return null;
  return {
    checkedAt:  data.checked_at as string,
    localCount: data.local_count as number,
    liveCount:  data.live_count as number,
    isStale:    data.is_stale as boolean,
    error:      (data.error as string | null) ?? null,
  };
}

export async function recordCategorySyncHealth(input: {
  localCount: number;
  liveCount:  number;
  error?:     string | null;
}): Promise<void> {
  const db = createServerClient();
  const isStale = isDriftStale(input.localCount, input.liveCount);
  await db.from("jumia_category_sync_health").upsert({
    id:          1,
    checked_at:  new Date().toISOString(),
    local_count: input.localCount,
    live_count:  input.liveCount,
    is_stale:    isStale,
    error:       input.error ?? null,
  });
}
