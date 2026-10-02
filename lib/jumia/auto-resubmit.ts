/**
 * Sending a listing back to Jumia, without asking the seller, when Jumia
 * turned it down only for fields its category doesn't show.
 *
 * "Attribute [x] is not visible for category [y]" is never about the
 * seller's product: our copy of the category's fields lists some Jumia
 * won't take there. logFeedOutcome (lib/jumia/feed-outcomes.ts) drops the
 * named fields from that copy as soon as the rejection is logged, so
 * pushing again is the whole fix, and it used to wait for the seller to tap
 * Fix. Jumia names these a few at a time: a freezer filed under
 * Refrigerators was refused for seven fields, resubmitted by hand, then
 * refused for four more (live, 2026-10-02).
 *
 * Capped at MAX_REJECTIONS_A_DAY for the listing, so a category Jumia keeps
 * finding new complaints about ends with the seller's Fix message rather
 * than a loop.
 */

import { createServerClient } from "@/lib/supabase/server";
import { classifyJumiaRejection, extractRejectionText } from "@/lib/jumia/rejection-remedy";
import { pushListingToJumia } from "@/lib/jumia/push-listing";

const MAX_REJECTIONS_A_DAY = 3;

/**
 * Push the listing again when `rejection` is only "not visible for
 * category" complaints. True when it went back to Jumia, so the caller
 * tells the seller nothing yet. Never throws.
 */
export async function resubmitWithoutHiddenFields(
  userId:    string,
  listingId: string,
  rejection: string | null,
): Promise<boolean> {
  if (!rejection) return false;
  if (classifyJumiaRejection(extractRejectionText(rejection)).kind !== "not_visible_attributes") return false;
  try {
    // Counted by feed, not by row: a listing with variants logs one row per
    // variant for the same rejection.
    const db = createServerClient();
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data } = await db
      .from("jumia_feed_outcomes")
      .select("feed_id")
      .eq("listing_id", listingId)
      .eq("outcome", "rejected")
      .gt("created_at", since);
    const rejections = new Set(((data ?? []) as { feed_id: string | null }[]).map((r) => r.feed_id)).size;
    if (rejections > MAX_REJECTIONS_A_DAY) return false;

    const result = await pushListingToJumia(userId, listingId);
    if (!result.ok) {
      console.warn(`[auto-resubmit] ${listingId} couldn't go back to Jumia: ${result.message}`);
    }
    return result.ok;
  } catch (e) {
    console.warn(`[auto-resubmit] ${listingId} failed: ${(e as Error).message}`);
    return false;
  }
}
