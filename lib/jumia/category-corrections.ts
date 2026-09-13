/**
 * Best-effort telemetry for refillAttributesForCategory()'s category-switch
 * path — see supabase/migrations/2026-09-13_category-corrections.sql for
 * why: a running log of AI-picked-category → seller-corrected-category
 * pairs is what turns "this one listing got miscategorized" into "this
 * category is systematically wrong for this kind of product," which needs
 * data across many corrections rather than a single anecdote to see.
 */

import { createServerClient } from "@/lib/supabase/server";

export async function logCategoryCorrection(params: {
  listingId: string;
  previousCategoryCode: number | null;
  previousCategoryPath: string | null;
  previousConfidence: number | null;
  newCategoryCode: number;
  newCategoryPath: string | null;
}): Promise<void> {
  try {
    const db = createServerClient();
    await db.from("category_corrections").insert({
      listing_id:             params.listingId,
      previous_category_code: params.previousCategoryCode,
      previous_category_path: params.previousCategoryPath,
      previous_confidence:    params.previousConfidence,
      new_category_code:      params.newCategoryCode,
      new_category_path:      params.newCategoryPath,
    });
  } catch (e) {
    console.warn(`[category-corrections] failed to log correction for listing ${params.listingId}: ${(e as Error).message}`);
  }
}
