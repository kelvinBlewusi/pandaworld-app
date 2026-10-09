/**
 * A live product's other details from the chat (owner, 2026-10-09: "Live
 * product: other details - let's have this too"): its colour, material,
 * weight, model and the rest of its category's details, a variation's
 * barcode, or a size's name. Sent with the whole product as an update feed
 * (POST /feeds/products/update; lib/jumia/shop.ts contentItems), after one
 * confirm tap like every live change.
 *
 * Jumia takes a detail only if the product's category has it, and a choice
 * only from the category's own options, so both are checked here first,
 * with the same rules a new listing's push uses (lib/jumia/preflight.ts).
 * Whatever doesn't pass is said, with what the category does take.
 */

import { getCategoryAttributes, getCategoryByCode, fetchAttributesFromJumia, upsertAttributes, type JumiaCategoryAttribute } from "@/lib/jumia/categories";
import { allowedValueFor, checkNumericConstraint } from "@/lib/jumia/preflight";
import type { ContentFields, ProductSet } from "@/lib/jumia/shop";

/** What the chat changes elsewhere, or Jumia doesn't take here: never a "detail". */
const NOT_DETAILS = new Set([
  "name", "description", "short_description", "brand", "price", "sale_price", "special_price", "stock", "quantity",
  "seller_sku", "sellersku", "parent_sku", "parentsku", "gtin_barcode", "barcode", "variation", "main_image", "image", "images", "category",
]);

const norm = (s: string) => s.toLowerCase().replace(/colour/g, "color").replace(/\(.*?\)/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
const tokens = (s: string) => norm(s).split(" ").filter(Boolean);

/**
 * The category's detail the seller's word means ("colour" → color_family,
 * "material" → main_material), or null. Exact name or label first, then the
 * one whose name holds all their words (the shorter, and not a variation's,
 * when several do). Pure.
 */
export function matchAttribute(word: string, attrs: JumiaCategoryAttribute[]): JumiaCategoryAttribute | null {
  const want = tokens(word);
  if (want.length === 0) return null;
  const said = want.join(" ");
  let best: { attr: JumiaCategoryAttribute; score: number; len: number } | null = null;
  for (const a of attrs) {
    if (NOT_DETAILS.has(a.name.toLowerCase())) continue;
    const forms = [a.name.replace(/_/g, " "), a.label].map(norm).filter(Boolean);
    let score = 0;
    for (const f of forms) {
      const have = f.split(" ");
      if (f === said) score = Math.max(score, 3);
      else if (want.every((w) => have.includes(w))) score = Math.max(score, 2);
      else if (want.length > 1 && have.every((w) => want.includes(w))) score = Math.max(score, 1);
    }
    if (score === 0) continue;
    const len = Math.min(...forms.map((f) => f.length)) + (a.is_variant ? 100 : 0);
    if (!best || score > best.score || (score === best.score && len < best.len)) best = { attr: a, score, len };
  }
  return best?.attr ?? null;
}

/** Their value as the detail takes it (an allowed option's spelling, a number in bounds), or why not. Pure. */
export function checkDetailValue(attr: JumiaCategoryAttribute, value: string): { ok: true; value: string } | { ok: false; why: string } {
  const label = attr.label || attr.name.replace(/_/g, " ");
  const raw = value.trim();
  if (!raw) return { ok: false, why: `What should its ${label.toLowerCase()} be?` };
  if (attr.allowed_values.length > 0) {
    const v = allowedValueFor(raw, attr);
    if (v) return { ok: true, value: v };
    const shown = attr.allowed_values.slice(0, 15).join(", ");
    return { ok: false, why: `Jumia doesn't take "${raw}" for ${label}. It takes: ${shown}${attr.allowed_values.length > 15 ? ", …" : ""}.` };
  }
  if (attr.type === "number") {
    const cleaned = raw.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/)?.[0];
    if (!cleaned) return { ok: false, why: `${label} is a number on Jumia, e.g. "${label.toLowerCase()} 2".` };
    const checked = checkNumericConstraint(cleaned, attr);
    return checked.value != null ? { ok: true, value: checked.value } : { ok: false, why: `Jumia doesn't take ${cleaned} for ${label}: ${checked.note?.detail ?? "it isn't a valid number for it"}.` };
  }
  if (attr.max_length != null && raw.length > attr.max_length) {
    return { ok: false, why: `${label} can be at most ${attr.max_length} characters on Jumia.` };
  }
  return { ok: true, value: raw };
}

/** A product's category details: the local copy, else read from Jumia (and kept). */
export async function categoryDetails(accessToken: string, categoryCode: number): Promise<JumiaCategoryAttribute[]> {
  const cached = await getCategoryAttributes(categoryCode).catch(() => []);
  if (cached.length > 0) return cached;
  const cat = await getCategoryByCode(categoryCode).catch(() => null);
  if (!cat?.attribute_set_sid) return [];
  const fresh = await fetchAttributesFromJumia(accessToken, cat.attribute_set_sid).catch(() => []);
  if (fresh.length > 0) await upsertAttributes(categoryCode, fresh).catch(() => undefined);
  return fresh;
}

/** What the seller asked for: details by their words, a barcode, a size's new name. */
export interface DetailsRequest {
  details?: Record<string, string>;
  barcode?: string;
  size?:    { from: string | null; to: string };
}

/**
 * The asked-for details as the update takes them, checked against the
 * product's category and its variations, or what to tell the seller
 * instead. `sku` is the variation the seller means when the product has
 * several and it matters (a barcode, a size's name).
 */
export function resolveDetails(
  req: DetailsRequest, set: ProductSet, attrs: JumiaCategoryAttribute[], sku: string | null,
): { ok: true; fields: Pick<ContentFields, "attributes" | "variations"> } | { ok: false; why: string } {
  const fields: Pick<ContentFields, "attributes" | "variations"> = {};
  const entries = Object.entries(req.details ?? {});
  if (entries.length > 0) {
    if (attrs.length === 0) return { ok: false, why: "I couldn't read which details this product's category takes from Jumia just now. Try again in a minute." };
    const out: NonNullable<ContentFields["attributes"]> = [];
    for (const [word, value] of entries) {
      const attr = matchAttribute(word, attrs);
      if (!attr) {
        const names = attrs.filter((a) => !NOT_DETAILS.has(a.name.toLowerCase())).map((a) => a.label || a.name).slice(0, 20);
        return { ok: false, why: `This product's category on Jumia has no detail called "${word}". The details it takes: ${names.join(", ")}.` };
      }
      const checked = checkDetailValue(attr, value);
      if (!checked.ok) return checked;
      out.push({ name: attr.name, label: attr.label || attr.name, value: checked.value });
    }
    fields.attributes = out;
  }

  // The variation it's about: the one they named, or the only one.
  const pick = () => (sku ? set.variations.find((v) => v.sellerSku === sku) : null) ?? (set.variations.length === 1 ? set.variations[0] : null);
  if (req.barcode) {
    const digits = req.barcode.replace(/[\s-]/g, "");
    if (!/^\d{8,14}$/.test(digits)) return { ok: false, why: "A barcode (GTIN/EAN) is 8 to 14 digits, e.g. \"its barcode is 6001234567890\"." };
    const v = pick();
    if (!v) return { ok: false, why: `It comes in ${set.variations.length} variations (${set.variations.map((x) => x.variation ?? x.sellerSku).join(", ")}): which one's barcode is it?` };
    fields.variations = [{ sellerSku: v.sellerSku, barcode: digits }];
  }
  if (req.size) {
    const to = req.size.to.trim();
    const from = req.size.from?.trim().toLowerCase() ?? null;
    const v = (from ? set.variations.find((x) => (x.variation ?? "").toLowerCase() === from) : null) ?? pick();
    if (!v) return { ok: false, why: `Which of its variations (${set.variations.map((x) => x.variation ?? x.sellerSku).join(", ")}) should be called "${to}"?` };
    const axis = attrs.find((a) => a.is_variant && a.allowed_values.length > 0 && allowedValueFor(v.variation ?? "", a) != null)
      ?? attrs.find((a) => a.is_variant && a.allowed_values.length > 0);
    const value = axis ? allowedValueFor(to, axis) : to;
    if (!value) return { ok: false, why: `Jumia doesn't take "${to}" as a ${axis!.label.toLowerCase()} here. It takes: ${axis!.allowed_values.slice(0, 15).join(", ")}.` };
    if (set.variations.some((x) => x !== v && (x.variation ?? "").toLowerCase() === value.toLowerCase())) {
      return { ok: false, why: `It already has a variation called ${value}.` };
    }
    fields.variations = [...(fields.variations ?? []).filter((x) => x.sellerSku !== v.sellerSku), { ...(fields.variations ?? []).find((x) => x.sellerSku === v.sellerSku), sellerSku: v.sellerSku, variation: value }];
  }
  return { ok: true, fields };
}
