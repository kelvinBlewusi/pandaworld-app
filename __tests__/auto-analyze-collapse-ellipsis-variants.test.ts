/**
 * collapseDuplicateEllipsisVariants (lib/actions/auto-analyze.ts).
 *
 * Real live case, 2026-09-23: a Backpacks listing whose note said "black
 * and grey" — the category's own variant axis is SIZE-only (18", ...,
 * S/M/L/XL, "One Size Fits All"), so neither colour matched it and BOTH
 * rows independently fell back to reconcileDraftVariation's "..."
 * placeholder, producing two variants with the identical value. Jumia's
 * own duplicate-variation validation rejects two rows sharing a variation
 * value under one parentSku — the same shape as the sandal incident this
 * session's mapListingToJumiaProducts fix closed. This collapses every
 * row that fell back to "..." down to a single one before it ever reaches
 * the variants table.
 */

import { collapseDuplicateEllipsisVariants } from "@/lib/actions/auto-analyze";

interface Row { variation: string; seller_sku: string }

function row(variation: string, seller_sku: string): Row {
  return { variation, seller_sku };
}

describe("collapseDuplicateEllipsisVariants", () => {
  it("collapses two ellipsis rows down to the first one, dropping the rest", () => {
    const rows = [row("...", "SKU-1"), row("...", "SKU-2")];
    expect(collapseDuplicateEllipsisVariants(rows)).toEqual([row("...", "SKU-1")]);
  });

  it("collapses three or more ellipsis rows down to just the first", () => {
    const rows = [row("...", "SKU-1"), row("...", "SKU-2"), row("...", "SKU-3")];
    expect(collapseDuplicateEllipsisVariants(rows)).toEqual([row("...", "SKU-1")]);
  });

  it("leaves a single ellipsis row untouched", () => {
    const rows = [row("...", "SKU-1")];
    expect(collapseDuplicateEllipsisVariants(rows)).toEqual(rows);
  });

  it("leaves rows untouched when none of them are the ellipsis placeholder", () => {
    const rows = [row("M", "SKU-1"), row("L", "SKU-2"), row("XL", "SKU-3")];
    expect(collapseDuplicateEllipsisVariants(rows)).toEqual(rows);
  });

  it("keeps every real, distinct value and only collapses the ellipsis duplicates mixed in among them", () => {
    // e.g. seller named "black, grey, size 40" — "40" resolves to a real
    // axis value while "black"/"grey" both fall back to "...". The real
    // value must survive; only the "..." duplicates collapse.
    const rows = [row("...", "SKU-1"), row("40\"", "SKU-2"), row("...", "SKU-3")];
    expect(collapseDuplicateEllipsisVariants(rows)).toEqual([
      row("40\"", "SKU-2"),
      row("...", "SKU-1"),
    ]);
  });

  it("does nothing for an empty list", () => {
    expect(collapseDuplicateEllipsisVariants([])).toEqual([]);
  });
});
