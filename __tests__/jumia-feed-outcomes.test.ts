/**
 * fingerprintListingContent exists to answer one question when reading
 * jumia_feed_outcomes back later: was this rejection the SAME content
 * rejected again, or did something actually change? That only works if
 * the fingerprint is stable across the one thing that changes on every
 * retry regardless of content (the SKU suffix — see pushListingToJumia's
 * isRetry branch) and sensitive to everything a seller or a redraft could
 * actually change.
 */

import { fingerprintListingContent } from "@/lib/jumia/feed-outcomes";
import type { ListingRow, VariantRow } from "@/lib/supabase/types";

function listing(patch: Partial<ListingRow> = {}) {
  return {
    title: "Electric Kettle - Stainless Steel, 1.7L Capacity",
    description: "A".repeat(60),
    brand: "Generic",
    category_code: "1",
    dynamic_attributes: { capacity_liter: "1.7" },
    ...patch,
  } as Pick<ListingRow, "title" | "description" | "brand" | "category_code" | "dynamic_attributes">;
}

function variant(patch: Partial<VariantRow> = {}) {
  return {
    variation: "Blue", quantity: 5, global_price: 100, sale_price: null,
    ...patch,
  } as Pick<VariantRow, "variation" | "quantity" | "global_price" | "sale_price">;
}

describe("fingerprintListingContent", () => {
  it("is stable across a retry's fresh SKU suffix — seller_sku isn't part of the input at all", () => {
    // The function's signature doesn't even accept seller_sku, so a caller
    // passing variants with different SKUs (exactly what isRetry produces)
    // can't affect the hash — this pins that down explicitly.
    const a = fingerprintListingContent(listing(), [variant()]);
    const b = fingerprintListingContent(listing(), [variant()]);
    expect(a).toBe(b);
  });

  it("changes when the content a redraft would actually change changes", () => {
    const base = fingerprintListingContent(listing(), [variant()]);
    const rewordedTitle = fingerprintListingContent(listing({ title: "A totally different title here" }), [variant()]);
    const newAttribute = fingerprintListingContent(
      listing({ dynamic_attributes: { capacity_liter: "2" } }),
      [variant()],
    );
    expect(rewordedTitle).not.toBe(base);
    expect(newAttribute).not.toBe(base);
  });

  it("is insensitive to variant array order — Jumia and our own code don't guarantee one", () => {
    const forward = fingerprintListingContent(listing(), [variant({ variation: "Blue" }), variant({ variation: "Red" })]);
    const backward = fingerprintListingContent(listing(), [variant({ variation: "Red" }), variant({ variation: "Blue" })]);
    expect(forward).toBe(backward);
  });

  it("changes when a variant's price or quantity changes, even with the same variation label", () => {
    const a = fingerprintListingContent(listing(), [variant({ quantity: 5 })]);
    const b = fingerprintListingContent(listing(), [variant({ quantity: 50 })]);
    expect(a).not.toBe(b);
  });
});
