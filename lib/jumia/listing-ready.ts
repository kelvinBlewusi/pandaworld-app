/**
 * Last-mile gate run right before POST /feeds/products/create — the whole
 * point is to catch what Jumia would reject the feed for anyway, locally,
 * where a fix costs nothing and doesn't burn a rejected submission.
 *
 * Two independent checks, both real rejection classes seen live:
 *
 *   1. Restricted words (lib/ai/restricted-words.ts) — already run during
 *      AI drafting, but nothing re-checked the FINAL text right before it
 *      left the building. Real rejection: "The highlighted word has been
 *      placed on the blacklist... The Attribute [description] contains the
 *      restricted words: supreme" — "supreme" isn't even in our own list,
 *      which is exactly why a local strip can't be trusted as the only
 *      layer; this still strips what IS on the list and holds the push when
 *      a word survives stripping, rather than shipping it and finding out
 *      from Jumia.
 *
 *   2. Jumia's own prohibited-product-types / restricted-brands reference
 *      (lib/jumia/prohibited-catalog.ts, converted from the vendor
 *      workbook) — categories/keywords Jumia blocks per country, and brands
 *      it forbids per QC category, independent of anything our own
 *      restricted-words list covers (that list is wording; this is
 *      product/brand identity).
 *
 * Mutates the given products' text in place when a restricted word can be
 * stripped cleanly (see buildJumiaPayload) — the caller gets back the same
 * array with cleaned text plus a note explaining what changed, not silence.
 */

import { findRestrictedWords, stripRestrictedWords } from "@/lib/ai/restricted-words";
import { checkProhibitedCategory, checkRestrictedBrand } from "@/lib/jumia/prohibited-catalog";
import type { ListingRow } from "@/lib/supabase/types";

interface MinimalJumiaProduct {
  name:        { value: string };
  description: { value: string };
  attributes:  { name: string; value: string }[];
}

export interface ListingReadyResult {
  /** False when something here must block the push entirely. */
  ok:       boolean;
  /** Reasons nothing was sent — only populated when ok is false. */
  blockers: string[];
  /** Non-blocking, seller-facing notes (a word was stripped, a category
   *  needs a licence Jumia's sheet lists for this country, ...). */
  warnings: string[];
}

function scrubRestrictedWords(products: MinimalJumiaProduct[]): { blockers: string[]; warnings: string[] } {
  const blockers: string[] = [];
  const warnings: string[] = [];

  const scrubField = (label: string, get: () => string, set: (v: string) => void) => {
    const original = get();
    const found = findRestrictedWords(original);
    if (found.length === 0) return;

    const stripped = stripRestrictedWords(original);
    const stillPresent = findRestrictedWords(stripped);
    if (stillPresent.length > 0) {
      blockers.push(
        `${label} still contains a restricted word (${stillPresent.join(", ")}) even after stripping what could be removed automatically — edit it and resubmit.`,
      );
      return;
    }
    set(stripped);
    warnings.push(`${label}: removed restricted word(s) (${found.join(", ")}) before sending`);
  };

  for (const product of products) {
    scrubField("title", () => product.name.value, (v) => { product.name.value = v; });
    scrubField("description", () => product.description.value, (v) => { product.description.value = v; });
    for (const attr of product.attributes) {
      scrubField(attr.name, () => attr.value, (v) => { attr.value = v; });
    }
  }

  return { blockers, warnings };
}

export function assertListingReady(
  listing:     ListingRow,
  countryCode: string,
  products:    MinimalJumiaProduct[],
): ListingReadyResult {
  const blockers: string[] = [];
  const warnings: string[] = [];

  const words = scrubRestrictedWords(products);
  blockers.push(...words.blockers);
  warnings.push(...words.warnings);

  const categoryCheck = checkProhibitedCategory(countryCode, [
    listing.title, listing.description, listing.category_path,
  ]);
  if (categoryCheck.blocked) {
    blockers.push(
      `This looks like "${categoryCheck.blocked.keyword}" — Jumia blocks that product type in ${countryCode}, so nothing was sent.`,
    );
  }
  for (const w of categoryCheck.warnings) {
    warnings.push(`"${w.keyword}" needs "${w.status}" in ${countryCode} per Jumia's own rules — make sure that's in order`);
  }

  const brandCheck = checkRestrictedBrand(listing.brand, listing.category_path);
  if (brandCheck.status === "forbidden") {
    blockers.push(brandCheck.detail ?? `${listing.brand} is a forbidden brand for this category on Jumia, so nothing was sent.`);
  } else if (brandCheck.status === "qc" && brandCheck.detail) {
    warnings.push(brandCheck.detail);
  }

  return { ok: blockers.length === 0, blockers, warnings };
}
