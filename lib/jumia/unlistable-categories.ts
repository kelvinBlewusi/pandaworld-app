/**
 * Per-country record of categories Jumia refuses to accept listings in —
 * see supabase/migrations/2026-09-27_jumia-unlistable-categories.sql for
 * why this exists. Written from logFeedOutcome whenever Jumia rejects a
 * listing with its "can't list products in this category" error; read by
 * runAutoAnalyze so the AI never offers a category already refused for
 * the seller's country.
 */

import { createServerClient } from "@/lib/supabase/server";

// Jumia's wording: "You can't list products in this category. Please
// choose a different (more specific) category and try again." Matches a
// straight or curly apostrophe (or none).
const UNLISTABLE_CATEGORY_RE = /can.?t list products in this category/i;

export function isUnlistableCategoryError(error: string | null | undefined): boolean {
  return !!error && UNLISTABLE_CATEGORY_RE.test(error);
}

/** Drop blocked codes from a candidate list. Returns the same array when nothing is blocked. */
export function withoutBlocked<T extends { code: number | string }>(rows: T[], blocked: Set<number>): T[] {
  return blocked.size > 0 ? rows.filter((r) => !blocked.has(Number(r.code))) : rows;
}

/** The seller's Jumia country, from their own connection. Null when they have none. */
export async function sellerCountry(userId: string): Promise<string | null> {
  const db = createServerClient();
  const { data } = await db
    .from("jumia_connections")
    .select("country")
    .eq("user_id", userId)
    .maybeSingle();
  return (data?.country as string | null | undefined) ?? null;
}

/**
 * Block a category for a country. Best-effort and never throws — this runs
 * inside outcome logging, which must not fail a push. A select-then-write
 * rather than a DB function keeps it to plain table access; a concurrent
 * duplicate insert just loses one count increment, and only the row's
 * existence matters for blocking.
 */
export async function recordUnlistableCategory(
  country: string,
  categoryCode: number,
  error: string | null,
): Promise<void> {
  try {
    const db = createServerClient();
    const { data: existing } = await db
      .from("jumia_unlistable_categories")
      .select("rejection_count")
      .eq("country", country)
      .eq("category_code", categoryCode)
      .maybeSingle();

    const now = new Date().toISOString();
    if (existing) {
      await db
        .from("jumia_unlistable_categories")
        .update({
          rejection_count: ((existing.rejection_count as number | null) ?? 1) + 1,
          last_error:      error,
          last_seen_at:    now,
        })
        .eq("country", country)
        .eq("category_code", categoryCode);
    } else {
      await db.from("jumia_unlistable_categories").insert({
        country,
        category_code:   categoryCode,
        rejection_count: 1,
        last_error:      error,
        first_seen_at:   now,
        last_seen_at:    now,
      });
    }
  } catch (e) {
    console.warn(`[unlistable-categories] failed to record ${country}/${categoryCode}: ${(e as Error).message}`);
  }
}

/**
 * Admin unblock (/admin/blocked-categories). Takes effect on the next
 * analyze — the blocklist isn't cached. If Jumia still refuses the
 * category, the next rejection simply blocks it again.
 */
export async function unblockCategory(country: string, categoryCode: number): Promise<void> {
  const db = createServerClient();
  const { error } = await db
    .from("jumia_unlistable_categories")
    .delete()
    .eq("country", country)
    .eq("category_code", categoryCode);
  if (error) throw new Error(error.message);
}

/**
 * Category codes blocked for a country. Empty when the country is unknown
 * (a seller with no Jumia connection) or on any read failure — failing
 * open just means today's behaviour, never a blank candidate list.
 */
export async function blockedCategoryCodes(country: string | null): Promise<Set<number>> {
  if (!country) return new Set();
  try {
    const db = createServerClient();
    const { data } = await db
      .from("jumia_unlistable_categories")
      .select("category_code")
      .eq("country", country);
    return new Set(((data ?? []) as { category_code: number }[]).map((r) => Number(r.category_code)));
  } catch (e) {
    console.warn(`[unlistable-categories] failed to read blocklist for ${country}: ${(e as Error).message}`);
    return new Set();
  }
}
