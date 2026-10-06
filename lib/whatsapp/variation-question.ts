/**
 * Asking a seller for a product's variation in chat, when the variation is
 * what stops it reaching Jumia (owner's request, 2026-10-03).
 *
 * A category whose variation is a closed list (sizes, capacities, pack
 * counts) refuses anything else, and the bot used to answer with "This
 * category needs a variation picked from its own stocked options (…) —
 * mention it in your listing notes, or pick one in the editor", at draft
 * time, at submit and again after Fix & resubmit. The seller knows the
 * answer, so it's asked for like the price: "What variation(s) do you
 * have?", and the reply becomes the product's variants.
 *
 * The question is a missing-value question with the field VARIATION_FIELD
 * (askForNextMissingValue / answerMissingValue in lib/whatsapp/intake.ts).
 */

import { createServerClient } from "@/lib/supabase/server";
import { getCategoryAttributes } from "@/lib/jumia/categories";
import { snapToAllowedWithSynonyms } from "@/lib/jumia/preflight";

/** awaitingValueFor.field for this question; no category field has this name alone. */
export const VARIATION_FIELD = "__variation";

/** A reason a product can't go to Jumia (readiness, or a refused push) that's about its variation. */
export function isVariationBlock(reason: string): boolean {
  return /stocked options|no Variation label|share the same Variation label/i.test(reason);
}

/** The category's own variation options, in its order, once each; "..." (no pick) left out. */
export async function variationOptions(categoryCode: number): Promise<string[]> {
  if (!Number.isFinite(categoryCode) || categoryCode <= 0) return [];
  const attrs = await getCategoryAttributes(categoryCode);
  const all = attrs.filter((a) => a.is_variant).flatMap((a) => a.allowed_values ?? []);
  return Array.from(new Set(all)).filter((v) => v.trim() && v !== "...");
}

/**
 * A quick look, without reaching Jumia, at whether the variation could be
 * what holds a product: no variant rows where the category offers no "...",
 * or a row whose label is blank, repeated or not one of the options. Only
 * a yes is worth the full readiness check.
 */
export async function variationMayBlock(listingId: string, categoryCode: number): Promise<boolean> {
  if (!Number.isFinite(categoryCode) || categoryCode <= 0) return false;
  const attrs = await getCategoryAttributes(categoryCode);
  const allowed = attrs.filter((a) => a.is_variant).flatMap((a) => a.allowed_values ?? []);
  const db = createServerClient();
  const { data } = await db.from("variants").select("variation").eq("listing_id", listingId);
  const labels = ((data ?? []) as { variation: string | null }[]).map((r) => (r.variation ?? "").trim());
  if (labels.length === 0) return allowed.length > 0 && !allowed.includes("...");
  const lower = labels.map((l) => l.toLowerCase());
  return labels.some((l) => !l)
    || new Set(lower).size !== lower.length
    || (allowed.length > 0 && lower.some((l) => !allowed.some((a) => a.toLowerCase() === l)));
}

/** The question, in the owner's words: the product, then what to reply. */
export function variationQuestion(who: string, options: string[]): string {
  const shown = options.length > 6 ? `${options.slice(0, 5).join(", ")} and ${options.length - 5} more` : options.join(", ");
  return options.length > 0
    ? `*${who}*\n*What variation(s) do you have?* Reply with one or more of the stocked options (${shown}), or pick in the editor.`
    : `*${who}*\n*What variation(s) do you have?* Reply with them, e.g. *Small, Medium*, or set them in the editor.`;
}

const squash = (s: string) => s.toLowerCase().replace(/[\s\-_.]/g, "");

/**
 * Clothing sizes, each the ways a seller writes it: "Large" for a category
 * whose options are "L", or "XL" where they're "Extra Large". The owner's
 * example for the assistant (2026-10-06): "change the variation to Large
 * for the drafted T-shirt".
 */
const SIZE_NAMES: string[][] = [
  ["xs", "extrasmall", "xsmall"],
  ["s", "small"],
  ["m", "medium", "med"],
  ["l", "large"],
  ["xl", "extralarge", "xlarge"],
  ["xxl", "2xl", "xxlarge", "doubleextralarge", "extraextralarge", "doublexl"],
  ["xxxl", "3xl", "xxxlarge", "tripleextralarge", "triplexl"],
  ["xxxxl", "4xl"],
  ["xxxxxl", "5xl"],
];

/** The option that is the same clothing size as `part`, when exactly one is. */
function sameSize(options: string[], part: string): string | null {
  const names = SIZE_NAMES.find((n) => n.includes(squash(part)));
  if (!names) return null;
  const hits = options.filter((o) => names.includes(squash(o)));
  return hits.length === 1 ? hits[0] : null;
}

/** One option a reply part names: exact, the same but for spaces and case ("100 ML"), a known spelling or size name, or the only one it starts or is part of. */
function matchOption(options: string[], part: string): string | null {
  const t = part.trim();
  if (!t) return null;
  const exact = options.find((o) => o.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  const squashed = options.find((o) => squash(o) === squash(t));
  if (squashed) return squashed;
  const snapped = snapToAllowedWithSynonyms(t, options);
  if (snapped && options.includes(snapped)) return snapped;
  const size = sameSize(options, t);
  if (size) return size;
  const starts = options.filter((o) => o.toLowerCase().startsWith(t.toLowerCase()));
  if (starts.length === 1) return starts[0];
  const within = options.filter((o) => o.toLowerCase().includes(t.toLowerCase()));
  return within.length === 1 ? within[0] : null;
}

/**
 * A reply as the variations it names, each one of the category's options
 * (any text, when the category has none). Several are separated by commas,
 * "and", "&" or new lines.
 */
export function parseVariations(
  options: string[],
  text: string,
): { ok: true; values: string[] } | { ok: false; unknown: string[] } {
  const parts = text.split(/\s*(?:,|;|\n|&|\+|\band\b)\s*/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return { ok: false, unknown: [text.trim()] };
  if (options.length === 0) return { ok: true, values: Array.from(new Set(parts.map((p) => p.slice(0, 60)))) };

  const values: string[] = [];
  const unknown: string[] = [];
  for (const part of parts) {
    const match = matchOption(options, part);
    if (match) {
      if (!values.includes(match)) values.push(match);
    } else {
      unknown.push(part);
    }
  }
  return unknown.length > 0 ? { ok: false, unknown } : { ok: true, values };
}

/** A SKU suffix for a variation: its letters and digits, made unique. */
function skuSuffix(value: string, taken: Set<string>): string {
  const base = value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10) || "V";
  let suffix = base;
  for (let n = 2; taken.has(suffix); n++) suffix = `${base}${n}`;
  taken.add(suffix);
  return suffix;
}

/**
 * Make these the product's variants: one row each, as drafting writes them
 * (lib/actions/auto-analyze.ts), with the price, stock and sale of the
 * product's first existing variant, else the listing's own price and stock.
 */
export async function saveVariations(listingId: string, values: string[]): Promise<boolean> {
  const db = createServerClient();
  const [{ data: listing }, { data: existing }] = await Promise.all([
    db.from("listings").select("sku, selling_price, quantity").eq("id", listingId).maybeSingle(),
    db.from("variants").select("*").eq("listing_id", listingId),
  ]);
  if (!listing) return false;

  const template = ((existing ?? []) as Record<string, unknown>[])[0];
  const baseSku = typeof template?.seller_sku === "string" && template.seller_sku.includes("-")
    ? template.seller_sku.replace(/-[^-]*$/, "")
    : ((listing.sku as string | null) ?? listingId.slice(0, 8).toUpperCase());
  const taken = new Set<string>();
  const rows = values.map((variation) => ({
    listing_id:      listingId,
    variation,
    seller_sku:      `${baseSku}-${skuSuffix(variation, taken)}`,
    gtin:            values.length === 1 ? (template?.gtin ?? null) : null,
    quantity:        (template?.quantity as number | null | undefined) ?? (listing.quantity as number | null) ?? 1,
    global_price:    (template?.global_price as number | null | undefined) ?? (listing.selling_price as number | null) ?? null,
    sale_price:      template?.sale_price ?? null,
    sale_start_date: template?.sale_start_date ?? null,
    sale_end_date:   template?.sale_end_date ?? null,
  }));

  const { error: delError } = await db.from("variants").delete().eq("listing_id", listingId);
  if (delError) {
    console.warn(`[variation-question] clearing variants of ${listingId} failed: ${delError.message}`);
    return false;
  }
  const { error } = await db.from("variants").insert(rows);
  if (error) console.warn(`[variation-question] saving variants of ${listingId} failed: ${error.message}`);
  return !error;
}
