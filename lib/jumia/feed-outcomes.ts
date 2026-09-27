/**
 * Write-only regression log: one row per resolved Jumia feed-item outcome
 * (live, rejected by Jumia, or blocked before it ever left the building).
 * Nothing reads this today — it exists so the next "fix a rejection class"
 * pass has the real error string and payload shape to write a test
 * against (see CONTRIBUTING.md), instead of relying on whoever happened
 * to be watching the chat when it happened. See
 * supabase/migrations/2026-09-20_jumia-feed-outcomes.sql.
 *
 * A separate module from lib/jumia/api.ts on purpose: several existing
 * tests do `jest.mock("@/lib/jumia/api", () => ({ ... }))` with an
 * explicit list of exports, and adding fingerprintListingContent there
 * would silently become undefined in every one of them.
 */

import { createHash } from "node:crypto";
import { createServerClient } from "@/lib/supabase/server";
import { JUMIA_API_ENV_NAME } from "@/lib/jumia/oauth";
import { isUnlistableCategoryError, recordUnlistableCategory, sellerCountry } from "@/lib/jumia/unlistable-categories";
import type { ListingRow, VariantRow } from "@/lib/supabase/types";

/**
 * A stable hash of the listing content that actually drives a Jumia
 * payload — title, description, brand, category, dynamic attributes, and
 * each variant's variation/quantity/price. The only way to tell "the same
 * content was rejected again" apart from "different content, new
 * rejection" when reading jumia_feed_outcomes rows back later.
 *
 * Deliberately excludes seller_sku: pushListingToJumia mints a fresh SKU
 * suffix on every retry (see its isRetry branch), so including it would
 * make an unchanged listing fingerprint differently on every single
 * attempt, defeating the entire point. Variants are sorted by variation
 * label (stable across retries) rather than by SKU or array order.
 */
export function fingerprintListingContent(
  listing:  Pick<ListingRow, "title" | "description" | "brand" | "category_code" | "dynamic_attributes">,
  variants: Pick<VariantRow, "variation" | "quantity" | "global_price" | "sale_price">[],
): string {
  const material = JSON.stringify({
    title:              listing.title,
    description:        listing.description,
    brand:              listing.brand,
    category_code:      listing.category_code,
    dynamic_attributes: listing.dynamic_attributes ?? {},
    variants: variants
      .map((v) => ({
        variation:    (v.variation ?? "").trim().toLowerCase(),
        quantity:     v.quantity ?? null,
        global_price: v.global_price ?? null,
        sale_price:   v.sale_price ?? null,
      }))
      .sort((a, b) => a.variation.localeCompare(b.variation)),
  });
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

export type FeedOutcomeKind = "live" | "rejected" | "blocked_locally";

export interface FeedOutcomeInput {
  listingId:           string;
  feedId?:             string | null;
  sellerSku?:          string | null;
  country?:            string | null;
  categoryCode?:       string | null;
  outcome:             FeedOutcomeKind;
  rawError?:           string | null;
  payloadFingerprint?: string | null;
}

export async function logFeedOutcome(input: FeedOutcomeInput): Promise<void> {
  try {
    const db = createServerClient();
    // Some callers (the feed-status resolver) never have the seller in
    // scope, so resolve country from the listing's owner here instead —
    // it's the key for the per-country category blocklist below.
    const country = input.country ?? (await countryForListing(input.listingId));
    await db.from("jumia_feed_outcomes").insert({
      listing_id:          input.listingId,
      feed_id:             input.feedId ?? null,
      seller_sku:          input.sellerSku ?? null,
      country:             country,
      category_code:       input.categoryCode ?? null,
      outcome:             input.outcome,
      raw_error:           input.rawError ?? null,
      payload_fingerprint: input.payloadFingerprint ?? null,
      // Tags the row with whichever Jumia environment produced it, so a
      // rejection caught on the staging branch (STAGING.md) can be told
      // apart from a real seller hitting the same thing in production —
      // both currently write into this one table (shared Supabase
      // project), so without this they're indistinguishable.
      source_env:          JUMIA_API_ENV_NAME,
    });

    const categoryCode = input.categoryCode && /^\d+$/.test(input.categoryCode) ? Number(input.categoryCode) : null;
    if (input.outcome === "rejected" && country && categoryCode && isUnlistableCategoryError(input.rawError)) {
      await recordUnlistableCategory(country, categoryCode, input.rawError ?? null);
    }
  } catch (e) {
    console.warn(`[feed-outcomes] failed to log outcome for ${input.listingId}: ${(e as Error).message}`);
  }
}

async function countryForListing(listingId: string): Promise<string | null> {
  const db = createServerClient();
  const { data } = await db.from("listings").select("user_id").eq("id", listingId).maybeSingle();
  const userId = data?.user_id as string | undefined;
  return userId ? sellerCountry(userId) : null;
}
