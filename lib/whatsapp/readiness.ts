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
 * A decimal volume the seller stated (e.g. "1.8L") that never made it
 * into ANY capacity-shaped structured attribute — a gap upstream of
 * preflight entirely, since a value that was never captured has nothing
 * for decimal_mismatch_blocked to catch.
 *
 * Confirmed live, 2026-09-21 ("Electric Kettle - 1.8L Capacity",
 * category 1022979, staging canary): the category's own schema declares
 * SIX capacity-shaped fields (capacity, capacity_liter, capacity_litres,
 * capacity_kg, capacity_kva, capacity_slices) and none of them were
 * populated — auto-analyze wrote "1.8L" into the title and description
 * as prose only, so the built payload carried no capacity attribute at
 * all for preflightAttributes to see, let alone block. The earlier
 * decimal_mismatch_blocked check above only catches a value that DID
 * make it into a whole-number-only attribute and then got dropped — this
 * catches the case one step upstream, where it never arrived at all.
 *
 * Deliberately schema-free (checks the built attribute list, not the
 * category's own declared fields) — the assessor doesn't have the
 * resolved schema handy, and a decimal-with-volume-unit stated by the
 * seller with no matching structured attribute anywhere in the payload is
 * a strong enough signal on its own.
 */
function statedDecimalVolumeMissingFromPayload(
  freeText:   string,
  attributes: { name: string; value: unknown }[],
): string | null {
  const match = freeText.match(/\b\d+\.\d+\s*-?\s*(?:ml|millilitres?|milliliters?|l|litres?|liters?)\b/i);
  if (!match) return null;
  if (attributes.some((a) => /capacity/i.test(a.name))) return null;
  return match[0].trim();
}

export async function assessListingPushReadiness(
  userId:    string,
  listingId: string,
): Promise<ListingReadinessResult> {
  const db = createServerClient();
  const { data } = await db
    .from("listings")
    .select("title, description, selling_price, category_code, category_path, brand, images")
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

  const productAttrs = (preview.products[0] as { attributes?: { name: string; value: unknown }[] } | undefined)?.attributes ?? [];
  const missedCapacity = statedDecimalVolumeMissingFromPayload(`${row.title ?? ""} ${row.description ?? ""}`, productAttrs);
  if (missedCapacity) {
    reasons.push(`capacity: you mentioned ${missedCapacity} but I couldn't fit it into a category field for this product — open Edit to set the capacity yourself`);
  }

  // Fashion category still carrying the plain (non-fashion) Generic brand
  // — a real, confirmed Jumia rejection class ("Product category doesn't
  // allow Generic brand"). resolveBrand already prefers the Fashion
  // placeholder for a category it recognises as fashion; landing on plain
  // Generic here means either that recognition missed this category, or
  // the listing's own brand text happened to resolve to the wrong Generic
  // via the brand cache — either way, Ready would be wrong.
  const builtBrandName = (preview.products[0] as { brand?: { name?: string } } | undefined)?.brand?.name;
  if (
    builtBrandName?.toLowerCase() === GENERIC_BRAND_NAME &&
    isFashionCategory(row.category_path)
  ) {
    reasons.push(`brand: this looks like a fashion item with no real brand set — open Edit to set one, or confirm "Fashion" as a placeholder`);
  }

  return { ready: reasons.length === 0, reasons };
}
