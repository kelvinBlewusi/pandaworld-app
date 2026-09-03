/**
 * Extension autofill — pure mapping core (server-side, no I/O)
 *
 * This is the brains of `app/api/extension/fill/route.ts`, kept as pure
 * functions so it can be unit-tested without HTTP, Clerk, or Gemini.
 *
 * Phase 0 (POC) goal: prove the extension can harvest Jumia's rendered
 * form and write AI values back into it. So this module ships a
 * deterministic *mock* product generator plus the label→value mapper that
 * the real pipeline will also use. In Phase 1 the mock is replaced by
 * `aiPassA_describeProduct()` output — the mapper below is unchanged.
 */

// ─── Wire types (shared shape with the extension) ────────────────────────────

export type FieldType = "text" | "textarea" | "select" | "combobox" | "richtext";

/** One form field the content script harvested from the Jumia page. */
export interface HarvestedField {
  label:     string;          // on-screen label, e.g. "Product description"
  type:      FieldType;
  required?: boolean;
  options?:  string[];        // for select / combobox
  // True when the widget's option rows are checkboxes rather than radios —
  // i.e. it accepts MORE than one choice (Color family, Material family,
  // Certifications). Detected in content.js's enrichComboboxOptions.
  multi?:    boolean;
  // 1-based variant number when this field lives inside one of a
  // multi-variant listing's repeated variant blocks (see findVariantBlocks
  // in content.js). Undefined on a single-variant listing and on every
  // shared, product-level field. When set, `label` already carries the
  // matching " (Variant N)" suffix.
  variantIndex?: number;
  // Existing on-page content for a narrative field (Name/Description/
  // Highlights — see isNarrativeLabel in content.js) on an Edit-Product
  // page. Only ever set for those fields; other fields keep the plain
  // "already has a value, leave it" client-side gate instead. Sent so the
  // AI can decide to keep, enhance, or replace it — see buildFieldLine in
  // lib/ai/extension-fill.ts.
  currentValue?: string;
}

/** One harvested product photo — exactly one of the two is normally set. */
export interface HarvestedImage {
  dataUrl?: string;  // data: URL (base64) — a freshly-uploaded file the extension read locally
  httpUrl?: string;  // http(s) URL — an already-hosted photo (e.g. Jumia's own CDN)
}

export interface FillRequest {
  market?: string;            // e.g. "GH"
  notes?:  string;            // optional seller free-text (price, extra features)
  images?: HarvestedImage[];  // up to a few angles of the same product — see lib/ai/extension-fill.ts
  // Legacy single-image shape — kept so an extension build that hasn't
  // picked up the multi-image update yet (Chrome Web Store auto-update can
  // lag hours to days behind a backend deploy) still works. New callers
  // should send `images` instead; resolveImages() in the fill route prefers
  // it and only falls back to these when `images` is absent.
  imageUrl?: string;
  image?:  string;
  fields:  HarvestedField[];
}

export interface FillResponse {
  values:           Record<string, string>;  // keyed by field label
  warnings:         string[];
  creditsRemaining: number | null;           // null when unlimitedCredits, or unknown
  unlimitedCredits?: boolean;                 // true for admin accounts — see lib/billing/extension-credits.ts
  mock:             boolean;                  // true when values came from the mock generator
}

/**
 * True for a product Name/title that's too degenerate to ever write into a
 * real listing — the word "Generic" (the Brand field's own fallback word)
 * appearing anywhere in it, or anything under 15 non-space characters.
 * Shared so lib/ai/extension-fill.ts can also filter this OUT of what gets
 * shown to the AI as "current content" on an Edit page — confirmed live:
 * showing the AI its own past "Generic" back as existing content to weigh
 * made it echo the same value again instead of writing something real,
 * defeating the guard below.
 *
 * Confirmed live: a plain equality check on "generic" let a padded title
 * like "Generic Product For This Item" straight through — well over 15
 * characters, so the length check didn't catch it either, but just as
 * useless a title as the bare word. Match "generic" as a whole word
 * anywhere in the value, not just the entire string.
 */
export function isDegenerateName(value: string): boolean {
  return /\bgeneric\b/i.test(value) || value.replace(/\s+/g, "").length < 15;
}

/**
 * The subset of the real `ProductDescription` (lib/actions/ai.ts) that the
 * mapper consumes. Keeping it structural means the Phase-1 swap to the real
 * type is a drop-in.
 */
export interface ProductLike {
  title:            string;
  brand:            string | null;
  description:      string;
  highlights:       string;
  color:            string | null;
  color_family:     string | null;
  weight_kg:        number | null;
  warranty_text:    string | null;
  warranty_address: string | null;
  summary:          string;
  whats_in_box?:    string[];   // ["1x Watch", "1x Box", ...]
}

// ─── Seller-notes parsing ────────────────────────────────────────────────────

export interface ParsedNotes {
  price:         number | null;
  extraFeatures: string[];
  raw:           string;
}

/**
 * Pull a price and a list of extra features out of the seller's free-text.
 * Price lives in Jumia's *Variants* step, not Product Information, so we
 * never write it into the form here — we just surface it as a warning so the
 * seller sets it in the right place. Features feed the copy.
 */
export function parseNotes(notes: string | undefined | null): ParsedNotes {
  const raw = (notes ?? "").trim();
  if (!raw) return { price: null, extraFeatures: [], raw: "" };

  // Price: "price 250", "price is 250", "GHS 250", "250 cedis", or a bare
  // number token. Price is never written into any field — it lives on
  // Jumia's Variants step — this is only so the "set it on Variants" warning
  // below reliably fires instead of silently saying nothing.
  let price: number | null = null;
  const priceMatch =
    raw.match(/(?:price|ghs|gh₵|₵|cedis?)\s*(?:is\s+)?[:=]?\s*(\d[\d,]*(?:\.\d+)?)/i) ||
    raw.match(/(\d[\d,]*(?:\.\d+)?)\s*(?:ghs|cedis?|₵)/i);
  if (priceMatch) {
    const n = parseFloat(priceMatch[1].replace(/,/g, ""));
    if (!Number.isNaN(n)) price = n;
  }

  // Features: split the remainder on commas / semicolons / newlines, drop the
  // price fragment, keep short descriptive phrases.
  const extraFeatures = raw
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s) => !/^(?:price|ghs|cedis?)\b/i.test(s))
    .filter((s) => !/^\d[\d,.]*$/.test(s));

  return { price, extraFeatures, raw };
}

// ─── Deterministic mock product (POC only) ───────────────────────────────────

/**
 * Build a realistic Watches product from the seller's notes, with no AI call.
 * Deterministic so the POC is testable and works offline. Replaced by
 * `aiPassA_describeProduct()` in Phase 1.
 */
export function buildMockProduct(notes: string | undefined, category = "Watches"): ProductLike {
  const { extraFeatures } = parseNotes(notes);
  const feat = extraFeatures.length
    ? extraFeatures
    : ["Water resistant", "Adjustable strap", "Everyday wear"];

  const isWatch = /watch/i.test(category);
  const noun = isWatch ? "Analog Wristwatch" : category.replace(/s$/, "") || "Product";

  const title = `Classic ${noun} — ${feat.slice(0, 2).join(", ")}`;

  const description =
    `<p>A dependable ${noun.toLowerCase()} built for daily wear. ` +
    `${feat.map((f) => f.charAt(0).toUpperCase() + f.slice(1)).join(". ")}. ` +
    `Finished to a clean, modern standard and ready to wear straight out of the box.</p>` +
    `<p>Backed by a straightforward design that pairs with both casual and formal outfits, ` +
    `this ${noun.toLowerCase()} is a practical everyday choice.</p>`;

  const highlights = feat; // rendered to <ul> by mapper

  const whats_in_box = isWatch
    ? ["1x Wristwatch", "1x Gift Box", "1x User Manual"]
    : [`1x ${noun}`, "1x User Manual"];

  return {
    title,
    brand: null, // no logo assumed → mapper falls back to "Generic"
    description,
    highlights: highlights.map((h) => `• ${h}`).join("\n"),
    color: null,
    color_family: null,
    weight_kg: isWatch ? 0.2 : null,
    warranty_text: "N/A",
    warranty_address: "N/A",
    summary: `A ${noun.toLowerCase()} for everyday use.`,
    whats_in_box,
  };
}

// ─── Label → value mapping ───────────────────────────────────────────────────

const norm = (s: string) => s.toLowerCase().replace(/\*/g, "").replace(/\s+/g, " ").trim();

/**
 * Fields the seller owns — never AI-filled, never warned about. Quantity and
 * SKU used to be here too; they're now AI-fillable (quantity falls back to a
 * random value in the route when neither the AI nor the seller's notes give
 * one — see app/api/extension/fill/route.ts's applyQuantityDefault).
 *
 * "Country" and "Currency" (Variants section, next to Price) are the
 * seller's fixed account/market settings, not product content — writing an
 * AI guess into them threw a real DOMException in production
 * ("The specified value 'Ghana' cannot be parsed, or is out of range."),
 * since they're constrained native inputs, not free text.
 *
 * Base "Price" is NOT in this list any more — it's now notes-only
 * AI-fillable (see isNotesOnlyField in lib/ai/extension-fill.ts): written as
 * digits only when the seller's notes state one explicitly, left blank
 * otherwise, never guessed from the photo. "Sale Price" stays fully
 * seller-owned (a promotional discount the seller sets deliberately) — see
 * isSellerOwned() below, which excludes it by name rather than by the bare
 * "price" substring.
 */
const SELLER_OWNED = ["category", "stock", "currency"];

/** Wrap plain text as a <p> if it carries no HTML tags. */
function asHtml(text: string): string {
  if (/<[a-z][\s\S]*>/i.test(text)) return text;
  return `<p>${text.replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>")}</p>`;
}

/**
 * Hard character cap for a richtext field's FINAL wrapped output — confirmed
 * live: Jumia rejects submission with "Attribute [manufacturer_txt] should
 * have between [0] to [255] characters" when From the Manufacturer runs
 * over. The prompt's "1-2 short sentences" hint doesn't reliably keep the
 * AI under that once wrapped in <p></p>, same class of problem Price and
 * Name needed a hard code-side limit for, not just a prompt line.
 *
 * Strips all HTML before measuring/cutting (rather than trying to truncate
 * mid-markup and hope the result is still valid) and re-wraps in a plain
 * <p> — an acceptable trade for a field that's only ever 1-2 sentences, in
 * exchange for guaranteeing valid HTML and a hard length ceiling. Cuts at
 * the last word boundary so it doesn't end mid-word.
 */
function capRichTextLength(html: string, max: number): string {
  const stripped = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const overhead = "<p></p>".length;
  if (stripped.length + overhead <= max) return `<p>${stripped}</p>`;
  const budget = max - overhead;
  let cut = stripped.slice(0, budget);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > budget * 0.5) cut = cut.slice(0, lastSpace);
  return `<p>${cut.trim()}</p>`;
}

/** Turn "• a\n• b" or "a\nb" into <ul><li>a</li><li>b</li></ul>. */
function bulletsToHtml(text: string): string {
  if (/<ul[\s>]/i.test(text)) return text;
  const items = text
    .split(/\n+/)
    .map((l) => l.replace(/^[•\-\*]\s*/, "").trim())
    .filter(Boolean);
  if (!items.length) return asHtml(text);
  return `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;
}

/**
 * "What's in the box" — Jumia's own convention is one item per line inside
 * a single paragraph (`<p>1x Item<br>1x Item</p>`), not a bulleted list. The
 * AI sometimes returns this as one space-separated line with no newlines at
 * all ("1x Watch 1x Manual 1x Box"), which would otherwise render as one
 * unbroken line — so if there's nothing to split on newlines, fall back to
 * splitting right before each "Nx " occurrence (the box-contents format
 * itself), which reliably recovers the item boundaries either way.
 */
function boxItemsToHtml(text: string): string {
  if (/<br\s*\/?>/i.test(text) || /<ul[\s>]/i.test(text) || /<li[\s>]/i.test(text)) return text;
  let items = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (items.length <= 1) {
    // (?<!\d) is load-bearing: without it, "30x Gold Award Medals" split at
    // BOTH index 0 ("30x …" matches) and index 1 ("0x …" also matches),
    // producing the literal "3" / "0x Gold Award Medals" two-liner confirmed
    // live in a seller's What's-in-the-box field. Only break where the count
    // actually starts — i.e. not mid-number.
    items = text.split(/(?<!\d)(?=\d+\s*x\s+)/i).map((s) => s.trim()).filter(Boolean);
  }
  if (items.length <= 1) return asHtml(text);
  return `<p>${items.join("<br>")}</p>`;
}

/** Snap a value to the closest allowed option (case-insensitive), or null. */
function snapToOption(value: string, options: string[] | undefined): string | null {
  if (!options?.length) return value;
  const v = value.toLowerCase();
  const exact = options.find((o) => o.toLowerCase() === v);
  if (exact) return exact;
  const partial = options.find((o) => o.toLowerCase().includes(v) || v.includes(o.toLowerCase()));
  return partial ?? null;
}

/**
 * Map a product onto the exact fields the page rendered, keyed by label.
 * Rich-text fields come back as HTML; selects/comboboxes are snapped to an
 * allowed option. Anything we can't fill confidently is reported in warnings
 * (only for required fields, to keep the review honest without noise).
 */
export function mapProductToFields(
  product: ProductLike,
  fields: HarvestedField[],
  notes?: string,
): { values: Record<string, string>; warnings: string[] } {
  const values: Record<string, string> = {};
  const warnings: string[] = [];
  const { price } = parseNotes(notes);

  for (const field of fields) {
    const label = norm(field.label);
    let value: string | null = null;

    if (label.includes("name") && !label.includes("brand") && !label.includes("store")) {
      value = product.title;
    } else if (label.includes("brand")) {
      value = product.brand ?? "Generic";
      if (!product.brand) {
        warnings.push(`Brand not detected — filled "Generic". Change it if you know the brand.`);
      }
    } else if (label.includes("color") && label.includes("family")) {
      value = product.color_family ?? "Black";
    } else if (label.includes("colour") || label.includes("color")) {
      value = product.color ?? "Black";
    } else if (label.includes("weight")) {
      value = product.weight_kg != null ? String(product.weight_kg) : "";
    } else if (label.includes("description")) {
      value = asHtml(product.description);
    } else if (label.includes("highlight")) {
      value = bulletsToHtml(product.highlights);
    } else if (label.includes("box")) {
      const items = product.whats_in_box ?? [];
      value = items.length ? `<p>${items.join("<br>")}</p>` : "";
    } else if (label.includes("manufacturer")) {
      value = asHtml(product.summary);
    } else if (label.includes("warranty") && label.includes("address")) {
      value = product.warranty_address ?? "N/A";
    } else if (label.includes("warranty")) {
      value = product.warranty_text ?? "N/A";
    } else if (label.includes("price") && !label.includes("sale")) {
      // Set deterministically from the seller's notes (parsed above) —
      // never guessed, and guaranteed figures-only since it's just the
      // parsed number restringified. Blank/untouched when no price was
      // stated in notes.
      if (price == null) continue;
      value = String(price);
    } else if (isSellerOwned(field.label)) {
      // Sale price, category, stock, currency, country — fixed by the
      // seller's account/market, never AI-filled. Skip silently; don't nag
      // even though some are required.
      continue;
    } else {
      // Unknown field — leave for the seller. Only nag if it's required.
      if (field.required) {
        warnings.push(`Could not confidently fill required field "${field.label}" — please review.`);
      }
      continue;
    }

    if (value == null || value === "") continue;

    // For constrained pickers, snap to an allowed option.
    if ((field.type === "select" || field.type === "combobox") && field.options?.length) {
      const snapped = snapToOption(value, field.options);
      if (snapped) {
        value = snapped;
      } else {
        warnings.push(`"${value}" isn't an option for "${field.label}" — left blank, please pick one.`);
        continue;
      }
    }

    values[field.label] = value;
  }

  if (price != null) {
    const priceField = fields.find((f) => { const l = norm(f.label); return l.includes("price") && !l.includes("sale"); });
    warnings.push(
      priceField && values[priceField.label]
        ? `Filled Price (${price}) from your notes — double-check it's correct before submitting.`
        : `Detected price ${price} in your notes — no Price field was found on this page to fill it automatically.`,
    );
  }

  return { values, warnings };
}

/** True for fields the seller owns — never AI-filled (sale price, stock, category, currency, country). */
export function isSellerOwned(label: string): boolean {
  const l = norm(label);
  // Exact match only — a substring match on "country" would also catch a
  // legitimate "Country of origin" product attribute some categories ask
  // for, which SHOULD stay AI/notes-fillable like Brand.
  if (l === "country") return true;
  // Sale Price is a promotional discount the seller sets deliberately —
  // always seller-owned. Checked here (not via the bare "price" substring in
  // SELLER_OWNED) so the base "Price" field is free to be notes-only
  // AI-fillable instead.
  if (l.includes("sale") && l.includes("price")) return true;
  return SELLER_OWNED.some((k) => l.includes(k));
}

/**
 * Structural finalizer for a raw label→value map produced by the real AI pass.
 * Skips seller-owned fields, ensures rich-text is HTML, snaps select/combobox
 * values to an allowed option, and drops empties. Content-policy cleanup
 * (restricted words, brand-in-title) already happened in the AI pass.
 */
export function finalizeAiValues(
  raw: Record<string, string>,
  fields: HarvestedField[],
  notes?: string,
): { values: Record<string, string>; warnings: string[] } {
  const values: Record<string, string> = {};
  const warnings: string[] = [];
  const { price } = parseNotes(notes);

  for (const field of fields) {
    if (isSellerOwned(field.label)) continue;

    const fieldLabel = norm(field.label);
    // Price is set deterministically from the seller's notes (parsed
    // above), not from the AI's own JSON transcription — guarantees a
    // clean figures-only value with no risk of the AI adding a currency
    // symbol or reformatting it. Blank/untouched when no price was stated.
    if (fieldLabel.includes("price") && !fieldLabel.includes("sale")) {
      if (price != null) values[field.label] = String(price);
      continue;
    }

    let value = (raw[field.label] ?? "").trim();
    if (!value) continue;

    // Guard against a degenerate product title — confirmed happening live:
    // the AI once returned literally "Generic" (the Brand field's own
    // fallback word, applied entirely separately by applyBrandDefault) as
    // the product NAME. A real SEO title is always much longer than this;
    // better to leave it for the seller to write than push something this
    // bad into an actual listing. Also see isDegenerateName below, applied
    // BEFORE the AI ever sees existing content, to stop this same value
    // being shown back to it as "current content" worth keeping.
    if (fieldLabel.includes("name") && !fieldLabel.includes("brand") && !fieldLabel.includes("store")) {
      if (isDegenerateName(value)) {
        warnings.push(`AI's product name looked too generic ("${value}") — left blank, please write one.`);
        continue;
      }
      // Confirmed happening live on a fresh listing (no existing-content
      // path involved at all): Name came back "Repair by Vendor" — a real,
      // specific-looking string, but it's actually one of Warranty Type's
      // own dropdown options, not a title. isDegenerateName can't catch
      // this (16 real characters, not "Generic"). Whatever the exact cause
      // — the AI shuffling its own JSON keys, or a value landing under the
      // wrong label — the symptom is the same either way: Name exactly
      // matches another field's value, which no real SEO title would.
      // Reject it rather than write a wrong-but-plausible-looking title
      // into the listing.
      //
      // Checks two sources deliberately, not just one: a constrained
      // field's OPTION LIST (the original "Repair by Vendor" case — Name
      // stolen from a dropdown, whether or not the AI actually picked that
      // option for its real field) AND every other field's actual RAW
      // value (catches theft from a free-text field like Highlights,
      // Description, or Warranty Address, which has no option list to
      // check against at all). Both are checked so this doesn't need a new
      // one-off fix the next time the stolen value happens to come from a
      // different kind of field — this is the general form of that bug,
      // not one more specific banned string.
      const stolenFrom = fields.find((f) => {
        if (f === field) return false;
        if (f.options?.some((o) => o.trim().toLowerCase() === value.toLowerCase())) return true;
        const otherValue = (raw[f.label] ?? "").trim();
        return otherValue.length > 0 && otherValue.toLowerCase() === value.toLowerCase();
      });
      if (stolenFrom) {
        warnings.push(
          `AI's product name ("${value}") looks like it was meant for "${stolenFrom.label}" instead — left blank, please write one.`,
        );
        continue;
      }
    }

    if (field.type === "richtext") {
      const l = norm(field.label);
      value = l.includes("highlight") ? bulletsToHtml(value)
        : l.includes("box") ? boxItemsToHtml(value)
        : asHtml(value);
      // manufacturer_txt specifically — see capRichTextLength's doc comment.
      if (l.includes("manufacturer")) value = capRichTextLength(value, 255);
    }

    if ((field.type === "select" || field.type === "combobox") && field.options?.length) {
      // A multi-select field (checkbox rows) may legitimately come back as
      // "Black, Brown". Order matters: snapToOption falls back to a SUBSTRING
      // match, so snapping the whole string first would quietly resolve
      // "Black, Brown" to just "Black" and throw the rest away. So for a
      // multi field carrying a separator: try an EXACT whole-string match
      // first (an option can itself contain a comma, e.g. "Accra, Ghana"),
      // then per-part, and only then the fuzzy whole-string fallback.
      // content.js's splitComboValues mirrors this when clicking the rows.
      let snapped: string | null = null;
      if (field.multi && /[,|]/.test(value)) {
        const exact = field.options.find((o) => o.toLowerCase() === value.trim().toLowerCase());
        if (exact) {
          snapped = exact;
        } else {
          const parts = value.split(/\s*[,|]\s*/).map((p) => p.trim()).filter(Boolean);
          const hits = parts.map((p) => snapToOption(p, field.options!)).filter(Boolean) as string[];
          if (hits.length) snapped = hits.filter((h, i) => hits.indexOf(h) === i).join(", ");
        }
      }
      if (!snapped) snapped = snapToOption(value, field.options);
      if (!snapped) {
        warnings.push(`"${value}" isn't an option for "${field.label}" — left blank, please pick one.`);
        continue;
      }
      value = snapped;
    }

    values[field.label] = value;
  }

  // If Warranty Type came out N/A (or wasn't filled at all), a duration
  // doesn't mean anything — drop it even if the AI filled one in, rather
  // than leaving a duration on a listing that says it has no warranty.
  const warrantyTypeField = fields.find((f) => { const l = norm(f.label); return l.includes("warranty") && l.includes("type"); });
  const warrantyDurationField = fields.find((f) => { const l = norm(f.label); return l.includes("warranty") && l.includes("duration"); });
  if (warrantyDurationField && values[warrantyDurationField.label]) {
    const typeVal = warrantyTypeField ? (values[warrantyTypeField.label] ?? "").trim().toLowerCase() : "";
    if (!warrantyTypeField || !typeVal || typeVal === "n/a" || typeVal === "none") {
      delete values[warrantyDurationField.label];
    }
  }

  if (price != null) {
    const priceField = fields.find((f) => { const l = norm(f.label); return l.includes("price") && !l.includes("sale"); });
    warnings.push(
      priceField && values[priceField.label]
        ? `Filled Price (${price}) from your notes — double-check it's correct before submitting.`
        : `Detected price ${price} in your notes — no Price field was found on this page to fill it automatically.`,
    );
  }

  return { values, warnings };
}
