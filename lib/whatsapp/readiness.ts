/**
 * Single "would this push succeed?" brain for the WhatsApp Ready/Held
 * decision (lib/whatsapp/intake.ts's finalizeBatch).
 *
 * Root cause this closes: finalizeBatch decided Ready vs Held from only
 * missingFieldsFor (title/description/price/category/brand/images) and
 * noteWarningsFor (sale-date/variant-claim copy) — it never consulted
 * previewListingPayload / buildJumiaPayload / preflightAttributes /
 * assertListingReady, even though previewListingPayload's own doc comment
 * already said it was "extracted so callers can ask is this ready? ahead
 * of time (e.g. the WhatsApp batch-completion summary)". Staging canary,
 * 2026-09-21: three products that a real push would have rejected or
 * silently corrupted (a kettle capacity Jumia requires whole, a variant
 * value outside the category's stocked options) all came back "✅ Ready".
 *
 * Product rule (locked): ✅ Ready ⇔ a real push would succeed AS THE
 * SELLER TYPED IT — not merely "Jumia's create-feed call wouldn't 4xx
 * after silently dropping something". Reuses previewListingPayload
 * (itself a thin wrapper around buildJumiaPayload — the exact function a
 * real push calls) rather than forking a second payload builder; a
 * preview that could drift from the push would be worse than none,
 * because it would be believed.
 */

import { createServerClient } from "@/lib/supabase/server";
import { previewListingPayload, missingFieldLabels } from "@/lib/jumia/push-listing";
import { isFashionCategory } from "@/lib/jumia/fashion-category";
import type { PreflightReason } from "@/lib/jumia/preflight";
import type { ListingRow } from "@/lib/supabase/types";

export interface ListingReadinessResult {
  /** True only when a real push, as the seller currently has the listing,
   *  would reach Jumia unchanged and uncontested by anything checkable
   *  locally. */
  ready: boolean;
  /** Short, seller-facing reasons this is Held — empty when ready. Already
   *  phrased for a chat line ("needs price", "capacity: ... isn't a whole
   *  number..."), never a raw error code. */
  reasons: string[];
}

/**
 * Preflight reasons that mean a value was DROPPED rather than sent as the
 * seller typed it. The push would still nominally "succeed" (these don't
 * necessarily empty a required field, so missingRequired alone wouldn't
 * catch them) — but silently sending something other than what the
 * seller wrote is exactly the false confidence this assessor exists to
 * catch. Deliberately excludes "truncated", "snapped_enum",
 * "rounded_number" and "line_breaks" — those preserve what the seller
 * meant (a spelling/precision correction Jumia accepts), not a value
 * Jumia refused outright.
 */
const HOLD_WORTHY_PREFLIGHT_REASONS = new Set<PreflightReason>([
  "decimal_mismatch_blocked",
  "invalid_enum",
  "invalid_number",
]);

/** The name lib/jumia/api.ts's BRAND_GENERIC_NON_FASHION fallback carries
 *  — not exported from there, so duplicated here as the one string this
 *  needs: what a fashion listing must never end up with. */
const GENERIC_BRAND_NAME = "generic";

/**
 * A decimal volume the seller stated (e.g. "1.8L") that either never made
 * it into any capacity-shaped structured attribute, or DID make it in but
 * still carries a fractional value — two distinct upstream-of-preflight
 * gaps that both leave a decimal capacity in front of Jumia unblocked.
 *
 * Confirmed live, 2026-09-21 ("Electric Kettle - 1.8L Capacity", category
 * 1022979, staging canary round 1): the category's own schema declares SIX
 * capacity-shaped fields (capacity, capacity_liter, capacity_litres,
 * capacity_kg, capacity_kva, capacity_slices) and none of them were
 * populated — auto-analyze wrote "1.8L" into the title and description as
 * prose only, so the built payload carried no capacity attribute at all
 * for preflightAttributes to see, let alone block.
 *
 * Round 2 of the same canary then showed the narrower half of this gap:
 * checkNumericConstraint (lib/jumia/preflight.ts) only runs when the
 * cached schema field has type === "number" — capacity_litres for this
 * category is cached as type "string", so a decimal value that DOES land
 * in it sails through preflightAttributes untouched, producing no
 * decimal_mismatch_blocked note for the check above to catch. This
 * function is deliberately schema-free (it checks the built attribute
 * list's actual values, not the category's declared field types) so it
 * catches that case too, without needing to know which specific field
 * name Jumia happens to have mistyped.
 */
function statedDecimalCapacityReason(
  freeText:   string,
  attributes: { name: string; value: unknown }[],
): string | null {
  const match = freeText.match(/\b\d+\.\d+\s*-?\s*(?:ml|millilitres?|milliliters?|l|litres?|liters?)\b/i);
  if (!match) return null;
  const stated = match[0].trim();

  // Only attributes with a real positive numeric value count as "captured".
  // Empty strings, N/A, and zero placeholders (e.g. capacity_slices: 0 on a
  // kettle schema) used to satisfy Number.isInteger and silently Ready a
  // listing whose seller-stated 1.8L never landed in a capacity field —
  // confirmed live 2026-09-22 staging canary (title carried 1.8L, UI capacity
  // blank, WhatsApp still ✅ Ready).
  const capacityAttrs = attributes.filter((a) => /capacity/i.test(a.name));
  const numericCapacity = capacityAttrs
    .map((a) => Number(a.value))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (numericCapacity.length === 0) {
    return `capacity: you mentioned ${stated} but I couldn't fit it into a category field for this product — open Edit to set the capacity yourself`;
  }

  const carriesWholeNumber = numericCapacity.some((n) => Number.isInteger(n));
  if (!carriesWholeNumber) {
    return `capacity: you mentioned ${stated} but this category needs a whole number and it didn't get rounded — open Edit to set the capacity yourself`;
  }

  return null;
}

/**
 * Distinct size-shaped words mentioned in free text ("Sizes Medium Large
 * Xtra Large" → ["medium", "large", "xtra large"]). Deliberately restricted
 * to full words/abbreviations that are never ordinary prose on their own
 * (no bare "s"/"m"/"l") — a product description mentioning "a large
 * capacity kettle" once must not read as a size claim; TWO OR MORE
 * distinct matches is the bar for "the seller is listing size options",
 * not just describing the product.
 */
function sizeWordsIn(freeText: string): Set<string> {
  const matches = freeText.match(
    /\b(?:xx?s|xx?l|xxxl|(?:extra|xtra)[- ]?small|(?:extra|xtra)[- ]?large|small|medium|large)\b/gi,
  ) ?? [];
  return new Set(matches.map((m) => m.toLowerCase()));
}

/**
 * A multi-size claim in the seller's own words ("Sizes Medium Large Xtra
 * Large") whose category-required Size axis never got a value at all —
 * distinct from staleDuplicateVariantAttribute above (which catches a
 * value that IS present but frozen wrong): this catches the field being
 * genuinely blank in every product, so there is nothing for that check to
 * find as "duplicated".
 *
 * Confirmed live, 2026-09-22 (staging canary round 3, same tee as round
 * 2's canary): 3 variant rows (M/L/XL) existed and each carried the
 * correct per-variant `variation`, but this time the listing-level "size"
 * dynamic attribute was never set at all (round 2's canary had it frozen
 * at "M" — a different failure shape of the same underlying gap: the
 * category's true is_variant field isn't literally named "variation", so
 * nothing in the pipeline is responsible for filling it per-variant).
 * missingRequiredFor (lib/jumia/api.ts) only flags this when the schema
 * marks the field required; a seller who explicitly listed several sizes
 * deserves a Hold whether or not Jumia's own schema happens to make that
 * field mandatory, because a blank Size on a listing the seller just said
 * has "Medium Large Xtra Large" would confuse every buyer who opens it,
 * required or not.
 *
 * Deliberately name-agnostic like staleDuplicateVariantAttribute, but
 * anchored on /size/i rather than by matching listing's variation values —
 * there's nothing to match against here, since the field is empty.
 */
function blankSizeClaimReason(
  freeText: string,
  products: { attributes?: { name: string; value: unknown }[] }[],
): string | null {
  // Two guards against reading ordinary prose as a size claim:
  //   - the word "size"/"sizes" has to actually appear ("fits medium to
  //     large hands" mentions two size words but never calls them sizes)
  //   - there has to be more than one product, i.e. real variants — a
  //     single-SKU listing has no "per variant" Size to leave blank
  if (!/\bsizes?\b/i.test(freeText)) return null;
  if (products.length < 2) return null;

  const sizeWords = sizeWordsIn(freeText);
  if (sizeWords.size < 2) return null;

  const hasSizeValue = products.some((p) =>
    (p.attributes ?? []).some(
      (a) => /size/i.test(a.name) && String(a.value ?? "").trim() !== "",
    ),
  );
  if (hasSizeValue) return null;

  const claimed = Array.from(sizeWords).join(", ");
  return `size: you mentioned ${claimed} but this category's Size field was never filled — open Edit to set it per variant`;
}

/**
 * Seller listed multiple sizes in caption/notes ("Sizes Medium Large Xtra
 * Large") but the drafted variation labels are abbreviations (M/L/XL) that
 * do not exact-match those tokens. blankSizeClaimReason misses this when
 * Size IS filled (staging canary 2026-09-22 02:45: size:M on every
 * variant → blank-Size Hold returned null → WhatsApp ✅ Ready). Soft-snaps
 * must Hold with one ask — never silent Ready.
 */
function softSnapSizeClaimReason(
  freeText: string,
  products: { variation?: string; attributes?: { name: string; value: unknown }[] }[],
): string | null {
  if (!/\bsizes?\b/i.test(freeText)) return null;

  const sizeWords = sizeWordsIn(freeText);
  if (sizeWords.size < 2) return null;

  // Collect variation labels from top-level variation AND attributes named
  // variation — a single-product preview (or one variant focused in UI)
  // must still Hold when the caption listed several non-exact size words
  // (02:45/03:08 canaries scored Ready while unit tests with 3 products Held).
  const labels = new Set<string>();
  for (const p of products) {
    const top = String(p.variation ?? "").trim();
    if (top) labels.add(top);
    for (const a of p.attributes ?? []) {
      if (/^variation$/i.test(a.name)) {
        const v = String(a.value ?? "").trim();
        if (v) labels.add(v);
      }
    }
  }
  if (labels.size === 0) {
    // Multi-variant blank size is blankSizeClaimReason's job; a single
    // empty product with a chatty caption is not enough to soft-snap Hold.
    if (products.length < 2) return null;
    return (
      `size: you mentioned ${Array.from(sizeWords).join(", ")} but no size options were drafted — ` +
      `open Edit to set the sizes you actually stock`
    );
  }

  // One-SKU placeholders ("Default") are not soft-snapped size labels —
  // "Sizes Medium Large … one size only" on a beanie must stay Ready.
  const NON_SIZE_LABELS = new Set(["default", "one size", "onesize", "os", "standard", "unique"]);
  if (labels.size === 1) {
    const only = Array.from(labels)[0].toLowerCase();
    if (NON_SIZE_LABELS.has(only)) return null;
  }

  const byLower = new Map(Array.from(labels).map((l) => [l.toLowerCase(), l]));
  // Exact match only — "medium" ≠ "m", "xtra large" ≠ "xl"
  const unmatched = Array.from(sizeWords).filter((w) => !byLower.has(w));
  if (unmatched.length === 0) return null;

  return (
    `size: you wrote sizes ${Array.from(sizeWords).join(", ")} but I drafted ` +
    `${Array.from(labels).join(", ")} — open Edit to confirm the sizes you actually stock`
  );
}

/**
 * A non-"variation" attribute frozen at the SAME value across every
 * variant product, even though the listing's variants genuinely differ —
 * the true is_variant schema field for a category (e.g. "size") isn't
 * always literally named "variation" (lib/jumia/api.ts's
 * PER_VARIANT_ATTRIBUTE_NAMES only ever treats that one literal name as
 * per-variant), so any OTHER is_variant field goes out as a single static
 * top-level attribute that gets spread unchanged into every variant
 * product — agreeing with whichever variant the static guess happened to
 * match, silently wrong for every other one.
 *
 * Confirmed live, 2026-09-21 ("... Tee", category 1012714, staging canary
 * round 2, read directly off POST /api/jumia/preview): 3 variants
 * (M/L/XL) each carried the correct per-variant top-level `variation`, but
 * every one of the three ALSO carried a static "size" attribute stuck at
 * "M" — correct for the M variant, silently wrong for L and XL. Jumia
 * raised no invalid_enum note because "M" is itself one of the category's
 * valid stocked sizes; nothing about the value itself was wrong, only
 * which variant it was attached to.
 *
 * Deliberately name-agnostic (does not hardcode "size") — it looks for
 * any attribute whose value equals one of the listing's own variation
 * labels, then checks whether that same attribute disagrees with its own
 * product's variation on at least one OTHER product.
 */
function staleDuplicateVariantAttribute(
  products: { variation?: string; attributes?: { name: string; value: unknown }[] }[],
): string | null {
  if (products.length < 2) return null;

  const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();
  const variationValues = new Set(products.map((p) => norm(p.variation)).filter(Boolean));
  if (variationValues.size < 2) return null;

  const candidateNames = new Set<string>();
  for (const p of products) {
    for (const a of p.attributes ?? []) {
      if (a.name.toLowerCase() === "variation") continue;
      if (variationValues.has(norm(a.value))) candidateNames.add(a.name);
    }
  }

  for (const name of Array.from(candidateNames)) {
    const disagrees = products.some((p) => {
      const attr = (p.attributes ?? []).find((a) => a.name === name);
      return attr !== undefined && norm(attr.value) !== norm(p.variation);
    });
    if (disagrees) return name;
  }
  return null;
}

export async function assessListingPushReadiness(
  userId:    string,
  listingId: string,
): Promise<ListingReadinessResult> {
  const db = createServerClient();
  const { data } = await db
    .from("listings")
    .select("title, description, selling_price, category_code, category_path, brand, images, user_prompt, highlights, dynamic_attributes")
    .eq("id", listingId)
    .maybeSingle();

  if (!data) return { ready: false, reasons: ["listing not found"] };
  const row = data as ListingRow;

  // Cheap, no-network check first — same short labels the summary already
  // showed pre-#122/#123, so a returning seller recognises the wording.
  // Also the right place to stop: a listing missing its basics is
  // unambiguously Held regardless of what a dry-run would say, so there's
  // no reason to spend a Jumia call (brand lookup, schema fetch) checking
  // a product that was never going anyway — the batched case can have a
  // dozen of these mid-draft, and every skipped call is one fewer thing
  // competing for Jumia's per-second rate limit.
  const missing = missingFieldLabels(row);
  if (missing.length > 0) {
    return { ready: false, reasons: missing.map((m) => `needs ${m}`) };
  }

  const preview = await previewListingPayload(userId, listingId);

  if (!preview.ok) {
    if (preview.code === "not_found") return { ready: false, reasons: ["listing not found"] };
    if (preview.code === "not_connected") {
      return { ready: false, reasons: ["Jumia needs to be (re)connected before this can be checked"] };
    }
    // build_failed — buildJumiaPayload's own error is already written for
    // a seller (JUMIA_NO_SCHEMA, a variant value outside the category's
    // stocked options, the restricted-content last-mile gate, ...).
    // Degrading to Held here rather than guessing Ready is the "couldn't
    // verify yet" behaviour a schema/credentials hiccup mid-summary needs
    // — never let an assessment failure read as a pass.
    return { ready: false, reasons: [preview.message.replace(/^JUMIA_NO_SCHEMA:\s*/, "")] };
  }

  const reasons: string[] = [];

  if (preview.missingRequired.length > 0) {
    reasons.push(`this category also needs ${preview.missingRequired.join(", ")}`);
  }

  for (const note of preview.preflightNotes) {
    if (HOLD_WORTHY_PREFLIGHT_REASONS.has(note.reason)) {
      reasons.push(`${note.label}: ${note.detail}`);
    }
  }

  const products = preview.products as { variation?: string; attributes?: { name: string; value: unknown }[]; brand?: { name?: string } }[];

  // Every free-text source the seller actually wrote — title and
  // description are AI-written and may paraphrase or drop what the
  // seller said, but user_prompt is their verbatim WhatsApp caption/notes
  // (see lib/whatsapp/intake.ts's applyNotes) and is the most reliable
  // signal of what they actually claimed. Confirmed live, 2026-09-22
  // (staging canary round 3): a kettle's caption ("Capacity 1.8L") is
  // exactly the text a title/description-only scan can miss if the AI
  // phrases the title differently than the seller did.
  const highlights = Array.isArray((row as ListingRow & { highlights?: unknown }).highlights)
    ? ((row as ListingRow & { highlights?: string[] }).highlights ?? []).join(" ")
    : String((row as ListingRow & { highlights?: unknown }).highlights ?? "");
  const dynText = JSON.stringify((row as ListingRow & { dynamic_attributes?: unknown }).dynamic_attributes ?? {});
  // user_prompt is the WhatsApp caption; highlights/dyn often echo capacity/size
  // claims the AI parked outside title/description.
  const freeText = `${row.title ?? ""} ${row.description ?? ""} ${row.user_prompt ?? ""} ${highlights} ${dynText}`;

  const productAttrs = products.flatMap((p) => p.attributes ?? []);
  const capacityReason = statedDecimalCapacityReason(freeText, productAttrs);
  if (capacityReason) reasons.push(capacityReason);

  const staleAttr = staleDuplicateVariantAttribute(products);
  if (staleAttr) {
    reasons.push(`${staleAttr}: stuck at the same value across every variant, but your variants differ — open Edit to set it per variant`);
  }

  const blankSizeReason = blankSizeClaimReason(freeText, products);
  if (blankSizeReason) reasons.push(blankSizeReason);

  const softSnapReason = softSnapSizeClaimReason(freeText, products);
  if (softSnapReason) reasons.push(softSnapReason);

  // Fashion category still carrying the plain (non-fashion) Generic brand
  // — a real, confirmed Jumia rejection class ("Product category doesn't
  // allow Generic brand"). resolveBrand already prefers the Fashion
  // placeholder for a category it recognises as fashion; landing on plain
  // Generic here means either that recognition missed this category, or
  // the listing's own brand text happened to resolve to the wrong Generic
  // via the brand cache — either way, Ready would be wrong.
  const builtBrandName = products[0]?.brand?.name;
  if (
    builtBrandName?.toLowerCase() === GENERIC_BRAND_NAME &&
    isFashionCategory(row.category_path)
  ) {
    reasons.push(`brand: this looks like a fashion item with no real brand set — open Edit to set one, or confirm "Fashion" as a placeholder`);
  }

  return { ready: reasons.length === 0, reasons };
}
