/**
 * Sending a listing back to Jumia, without asking the seller, when the
 * rejection is one we can fix ourselves:
 *
 * - Fields its category doesn't show ("Attribute [x] is not visible for
 *   category [y]"): never about the seller's product. logFeedOutcome
 *   (lib/jumia/feed-outcomes.ts) drops the named fields from our copy of
 *   the category as the rejection is logged, so pushing again is the whole
 *   fix. Jumia names these a few at a time: a freezer filed under
 *   Refrigerators was refused for seven fields, then four more (live,
 *   2026-10-02). Silent: nothing about the listing changes.
 * - Banned words, when they're all that's wrong ("The Attribute
 *   [description] contains the restricted words : camouflage"). The words
 *   are learned as the rejection is logged, and the push strips learned
 *   words, so again pushing is the fix. A costume set sat rejected for
 *   "camouflage" because the seller never tapped Fix (2026-10-04).
 * - A brand this shop isn't approved for, named in the listing's text by
 *   Jumia's quality check ("Restricted Brand: Police in NAME - Seller not
 *   in approved list"): the word comes out of this listing's text. Not
 *   learned for everyone, since a shop approved for the brand may use it.
 *
 * The seller is told what was taken out (the `note`), in the same message
 * as the rest of that run's results. Capped at MAX_REJECTIONS_A_DAY for the
 * listing, so a listing Jumia keeps finding new complaints about ends with
 * the seller's Fix message rather than a loop.
 */

import { createServerClient } from "@/lib/supabase/server";
import { classifyJumiaRejection, extractRejectionText } from "@/lib/jumia/rejection-remedy";
import { pushListingToJumia } from "@/lib/jumia/push-listing";
import {
  onlyRestrictedWordsInRejection,
  restrictedWordsInJumiaRejection,
  restrictedBrandWordsInRejection,
  removeWordsFromText,
} from "@/lib/ai/restricted-words";
import { rememberRestrictedWords } from "@/lib/jumia/learned-restricted-words";

const MAX_REJECTIONS_A_DAY = 3;

export interface AutoResubmitted {
  /** What the seller is told was changed; null when nothing about the listing changed. */
  note: string | null;
}

const quoted = (words: string[]) => words.map((w) => `"${w}"`).join(", ");
const them = (words: string[]) => (words.length === 1 ? "it" : "them");

/**
 * Take a refused brand word out of the listing's own text. True when the
 * text had it: when it didn't, a push would only meet the same rejection.
 * Fix & resubmit does the same (lib/whatsapp/intake.ts).
 */
export async function removeBrandWords(listingId: string, words: string[]): Promise<boolean> {
  const db = createServerClient();
  const { data: row } = await db
    .from("listings")
    .select("title, description, highlights")
    .eq("id", listingId)
    .maybeSingle();
  if (!row) return false;
  const patch: Record<string, string> = {};
  for (const field of ["title", "description", "highlights"] as const) {
    const before = (row[field] as string | null) ?? "";
    const after = removeWordsFromText(before, words, { line: field === "title" });
    if (after !== before) patch[field] = after;
  }
  if (Object.keys(patch).length === 0) return false;
  const { error } = await db.from("listings").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", listingId);
  if (error) throw new Error(error.message);
  return true;
}

/**
 * What to change for this rejection, done, and what to tell the seller;
 * null when it isn't one we fix ourselves.
 */
async function prepareFix(listingId: string, text: string): Promise<AutoResubmitted | null> {
  if (classifyJumiaRejection(text).kind === "not_visible_attributes") return { note: null };

  if (onlyRestrictedWordsInRejection(text)) {
    const words = restrictedWordsInJumiaRejection(text);
    // Usually learned already, as the rejection was logged; again here so
    // this process strips them on the push below.
    await rememberRestrictedWords(words, text);
    return { note: `Jumia doesn't allow ${quoted(words)} in listings, so I took ${them(words)} out and sent it back to Jumia.` };
  }

  const brandWords = restrictedBrandWordsInRejection(text);
  if (brandWords.length > 0 && (await removeBrandWords(listingId, brandWords))) {
    return {
      note: `Jumia's quality check doesn't let your shop use ${quoted(brandWords)} in the listing, so I took ${them(brandWords)} out and sent it back to Jumia.`,
    };
  }
  return null;
}

/**
 * Push the listing again when `rejection` is one we can fix ourselves (see
 * the module comment). Returns what the seller is told when it went back
 * to Jumia, null when it's left to the seller's Fix tap. Never throws.
 */
export async function resubmitAutomatically(
  userId:    string,
  listingId: string,
  rejection: string | null,
): Promise<AutoResubmitted | null> {
  if (!rejection) return null;
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
    if (rejections > MAX_REJECTIONS_A_DAY) return null;

    const fix = await prepareFix(listingId, extractRejectionText(rejection));
    if (!fix) return null;

    const result = await pushListingToJumia(userId, listingId);
    if (!result.ok) {
      console.warn(`[auto-resubmit] ${listingId} couldn't go back to Jumia: ${result.message}`);
      return null;
    }
    return fix;
  } catch (e) {
    console.warn(`[auto-resubmit] ${listingId} failed: ${(e as Error).message}`);
    return null;
  }
}
