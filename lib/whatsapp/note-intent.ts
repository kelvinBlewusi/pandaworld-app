/**
 * Understand what the seller ASKED FOR, however they phrased it.
 *
 * WHY THIS EXISTS. Everything a seller states in their note was read by
 * regex: extractPrice, extractSalePrice, extractVariantClaim,
 * extractNoteAssertions. Each pattern covers the phrasings someone
 * thought of. Two live notes, sent minutes apart, between them expressed
 * nine intentions and the patterns caught two:
 *
 *   "It costs 300Ghs"                 → no price. extractPrice knows
 *                                       "price is", not "costs", and its
 *                                       currency form wants GHS before
 *                                       the number, not after.
 *   "Comes in 3 colors black, red
 *    and blue"                        → no variants, and a COLOUR
 *                                       extracted as "Blue It Has A Sales
 *                                       Price Of 250 Starts" — the note
 *                                       had no full stops, so the pattern
 *                                       ran to the end of the message.
 *   'WHAT IS IN THE BOX IS "1x Gas
 *    Stove"'                          → nothing. No such field existed.
 *
 * Adding a pattern per phrasing does not converge. Sellers write however
 * they write, and there is no finite list.
 *
 * WHY A MODEL IS SAFE HERE, WHEN IT ISN'T FOR PRICE FROM A PHOTO. The
 * rule this codebase follows — never let the AI guess a price — is really
 * "never let the AI INVENT a price". Reading a number the seller
 * literally typed is a different act from inferring one from a picture.
 *
 * So the model extracts, and this module makes inventing impossible:
 * every value must carry the verbatim span of the note it came from, and
 * that span must actually appear in the note. A hallucinated price has no
 * quote to point at and is dropped before it reaches the listing. The
 * model gets latitude over PHRASING and none at all over FACTS.
 *
 * The verification below is pure and synchronous, and it is the part that
 * matters. It is written to be readable on its own, because it is the
 * only thing standing between a model's guess and a seller's live
 * listing.
 */

/** Everything the note pass may report. Each carries the seller's own
 *  words, which is what makes it checkable. */
export interface IntentField<T> {
  value: T;
  /** Verbatim from the note. Verified to actually appear there. */
  quote: string;
}

export interface NoteIntent {
  selling_price?:    IntentField<number>;
  sale_price?:       IntentField<number>;
  sale_start_date?:  IntentField<string>;   // ISO YYYY-MM-DD
  sale_end_date?:    IntentField<string>;
  quantity?:         IntentField<number>;
  /** Option labels the seller said they stock. Empty array = they said
   *  explicitly that there is only one variant. */
  variants?:         IntentField<string[]>;
  whats_in_the_box?: IntentField<string>;
  warranty?:         IntentField<string>;
  brand?:            IntentField<string>;
  color?:            IntentField<string>;
  main_material?:    IntentField<string>;
  model?:            IntentField<string>;
  /** They asked for their photos to be polished or made professional (lib/whatsapp/chat-polish.ts). */
  polish_images?:    IntentField<boolean>;
}

/** Why a field the model reported was thrown away. Logged, never silent —
 *  a verifier that rejects quietly is indistinguishable from one that
 *  isn't running. */
export interface RejectedIntent {
  field:  string;
  reason: string;
}

export interface VerifiedNoteIntent {
  intent:   NoteIntent;
  rejected: RejectedIntent[];
}

// ─── Verification ────────────────────────────────────────────────────────────

/** Collapse whitespace and case so a quote survives the model
 *  reformatting line breaks, which it does constantly and harmlessly. */
function canon(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’“”]/g, '"')   // smart quotes → plain
    .replace(/\s+/g, " ")
    .trim();
}

/** The single rule that makes the whole approach safe: the seller must
 *  actually have written this. */
function quoteIsInNote(quote: string, note: string): boolean {
  const q = canon(quote);
  if (q.length < 2) return false;
  return canon(note).includes(q);
}

/** Digits of the value must appear in the span it supposedly came from.
 *  Stops a model that quotes "it costs 300Ghs" and reports 3000. */
function numberIsInQuote(value: number, quote: string): boolean {
  const digits = String(value).replace(/\.0+$/, "");
  const inQuote = quote.replace(/[,\s]/g, "");
  return inQuote.includes(digits) || inQuote.includes(String(value));
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(iso: string): boolean {
  if (!ISO_DATE.test(iso)) return false;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Keep only what the seller demonstrably wrote.
 *
 * Every branch below fails CLOSED: anything that can't be verified is
 * dropped with a reason, never passed through on the assumption that the
 * model probably meant well. That direction is the whole point — a
 * dropped field is a seller filling one box in the editor, an invented
 * one is a wrong price on a live marketplace.
 */
/** Words that make a number a sale price, as extractSalePrice (lib/whatsapp/batch.ts) reads them, and a few more. */
const SALE_WORDS = /\b(sales?|promo\w*|discount\w*|offer|deal|reduced|slashed|now|was|off)\b/i;

export function verifyNoteIntent(raw: unknown, note: string): VerifiedNoteIntent {
  const intent: NoteIntent = {};
  const rejected: RejectedIntent[] = [];
  const obj = asRecord(raw);
  if (!obj || !note.trim()) return { intent, rejected };

  const reject = (field: string, reason: string) => rejected.push({ field, reason });

  /** Shared gate: the field exists, has a quote, and the quote is real. */
  const gate = (field: string): { value: unknown; quote: string } | null => {
    const entry = asRecord(obj[field]);
    if (!entry) return null;
    if (entry.value == null || entry.value === "") return null;
    const quote = typeof entry.quote === "string" ? entry.quote : "";
    if (!quote) {
      reject(field, "no quote given");
      return null;
    }
    if (!quoteIsInNote(quote, note)) {
      // The model wrote words the seller never did. This is the
      // hallucination case, and it is the reason this module exists.
      reject(field, `quote "${quote}" is not in the note`);
      return null;
    }
    return { value: entry.value, quote };
  };

  // ── Numbers ────────────────────────────────────────────────────────────
  for (const field of ["selling_price", "sale_price", "quantity"] as const) {
    const g = gate(field);
    if (!g) continue;
    const num = typeof g.value === "number" ? g.value : parseFloat(String(g.value));
    if (!Number.isFinite(num) || num <= 0) {
      reject(field, `"${g.value}" is not a usable number`);
      continue;
    }
    if (!numberIsInQuote(num, g.quote)) {
      reject(field, `${num} does not appear in "${g.quote}"`);
      continue;
    }
    intent[field] = { value: field === "quantity" ? Math.round(num) : num, quote: g.quote };
  }

  // A sale price is only one the seller called one: "Ghc 160" alone was
  // taken as both the price and the sale price (owner's test, 2026-10-07),
  // which Jumia then refused for want of dates. Its quote must say sale
  // (or promo, discount, "was ... now ..."), and it can't be the price itself.
  if (intent.sale_price) {
    const { value, quote } = intent.sale_price;
    if (!SALE_WORDS.test(quote)) {
      reject("sale_price", `"${quote}" doesn't say it's a sale price`);
      delete intent.sale_price;
    } else if (intent.selling_price && intent.selling_price.value === value) {
      reject("sale_price", `${value} is the price itself`);
      delete intent.sale_price;
    }
  }

  // ── Dates ──────────────────────────────────────────────────────────────
  for (const field of ["sale_start_date", "sale_end_date"] as const) {
    const g = gate(field);
    if (!g) continue;
    const iso = String(g.value).trim();
    if (!isRealDate(iso)) {
      reject(field, `"${iso}" is not a real YYYY-MM-DD date`);
      continue;
    }
    intent[field] = { value: iso, quote: g.quote };
  }

  // An inverted window is dropped whole, same rule extractSalePrice
  // already follows: there is no safe way to guess which side is the typo.
  if (
    intent.sale_start_date && intent.sale_end_date &&
    intent.sale_start_date.value > intent.sale_end_date.value
  ) {
    reject("sale_start_date", "the window ends before it starts");
    reject("sale_end_date", "the window ends before it starts");
    delete intent.sale_start_date;
    delete intent.sale_end_date;
  }

  // ── Variants ───────────────────────────────────────────────────────────
  const vEntry = asRecord(obj.variants);
  if (vEntry && Array.isArray(vEntry.value)) {
    const quote = typeof vEntry.quote === "string" ? vEntry.quote : "";
    if (!quote) {
      reject("variants", "no quote given");
    } else if (!quoteIsInNote(quote, note)) {
      reject("variants", `quote "${quote}" is not in the note`);
    } else {
      const labels = (vEntry.value as unknown[])
        .map((v) => String(v).trim())
        .filter((v) => v.length > 0 && v.length <= 60);
      // Each label has to be traceable to the span. A model that quotes
      // "comes in black, red and blue" and returns ["Black","Red","Blue",
      // "Green"] loses only the green.
      const canonQuote = canon(quote);
      const kept = labels.filter((l) => canonQuote.includes(canon(l)));
      const lost = labels.filter((l) => !canonQuote.includes(canon(l)));
      if (lost.length > 0) reject("variants", `${lost.join(", ")} not in "${quote}"`);
      // An empty array is meaningful — the seller said "single variant" —
      // so it is kept, but only when nothing was silently lost getting
      // there.
      if (kept.length > 0 || (labels.length === 0 && lost.length === 0)) {
        intent.variants = { value: kept, quote };
      }
    }
  }

  // ── Free text ──────────────────────────────────────────────────────────
  for (const field of ["whats_in_the_box", "warranty", "brand", "color", "main_material", "model"] as const) {
    const g = gate(field);
    if (!g) continue;
    const text = String(g.value).trim();
    if (!text) continue;
    // A value far longer than the words it came from means the model
    // wrote prose rather than lifting what the seller said.
    if (canon(text).length > canon(g.quote).length + 20) {
      reject(field, `"${text}" is longer than the note said`);
      continue;
    }
    intent[field] = { value: text, quote: g.quote };
  }

  // ── Polish the photos ─────────────────────────────────────────────────
  // Charged when it runs (owner, 2026-10-07), so it takes the seller's own
  // words about their photos, checked like the rest, and a quote that
  // names the photos (POLISH_ASK).
  {
    const g = gate("polish_images");
    if (g) {
      if (g.value !== true && g.value !== "true") reject("polish_images", `"${g.value}" isn't true`);
      else if (!notesAskForPolish(g.quote)) reject("polish_images", `"${g.quote}" doesn't ask for the photos to be polished`);
      else intent.polish_images = { value: true, quote: g.quote };
    }
  }

  return { intent, rejected };
}

/**
 * A request to polish or improve the photos, in the seller's words: a
 * photo word with a polish word near it ("polish the pictures", "make the
 * photos professional", "white background", "remove the background",
 * "studio photos"). "Polished steel" says nothing about photos.
 */
const PHOTO = String.raw`(?:photos?|pictures?|pics?|images?|imgs?|shots?)`;
const POLISH = String.raw`(?:polish\w*|enhanc\w*|edit\w*|retouch\w*|clean(?:\s|-)?up|beautif\w*|improve\w*|professional\w*|studio|nicer|better|fine-?tune\w*)`;
const POLISH_ASK = new RegExp(
  String.raw`\b${POLISH}\b[^.!?\n]{0,40}\b${PHOTO}\b|\b${PHOTO}\b[^.!?\n]{0,40}\b${POLISH}|\bwhite\s+background\b|\bremove\s+(?:the\s+)?background\b|\bstudio\s+${PHOTO}\b`,
  "i",
);
export function notesAskForPolish(note: string | null | undefined): boolean {
  return Boolean(note && POLISH_ASK.test(note));
}

// ─── Prompt ──────────────────────────────────────────────────────────────────

/**
 * Text-only on purpose. The note pass never sees the images, so it cannot
 * blend what the photo SHOWS with what the seller SAID — which is exactly
 * the failure that put five photographed colours onto a listing whose
 * note restricted it.
 */
export function buildNoteIntentPrompt(note: string, today: string): string {
  return `A seller sent this note about ONE product they are listing. Extract only what they actually stated.

SELLER'S NOTE:
"""
${note}
"""

Today is ${today}.

Return JSON. Include a key ONLY if the seller genuinely stated it. Every key's "quote" MUST be copied VERBATIM from the note above — the exact characters, not a paraphrase. A value you cannot quote must be omitted entirely.

{
  "selling_price":    { "value": <number>, "quote": "..." },   // the normal price. "it costs 300Ghs", "price is 200", "3500 cedis" all count.
  "sale_price":       { "value": <number>, "quote": "..." },   // promo/discounted price ONLY. Never the normal price.
  "quantity":         { "value": <integer>, "quote": "..." },  // stock on hand, if stated.
  "sale_start_date":  { "value": "YYYY-MM-DD", "quote": "..." },
  "sale_end_date":    { "value": "YYYY-MM-DD", "quote": "..." },
  "variants":         { "value": ["Black","Red"], "quote": "..." },  // the options they said they STOCK. Use [] if they said there is only one variant.
  "whats_in_the_box": { "value": "...", "quote": "..." },
  "warranty":         { "value": "...", "quote": "..." },
  "brand":            { "value": "...", "quote": "..." },
  "color":            { "value": "...", "quote": "..." },
  "main_material":    { "value": "...", "quote": "..." },
  "model":            { "value": "...", "quote": "..." },
  "polish_images":    { "value": true, "quote": "..." }   // ONLY if they ask for their photos to be polished, edited, made professional, put on a white background.
}

RULES:
- Omit any key the seller did not state. An absent key is always better than a guessed one.
- NEVER infer from a product photo, your own knowledge, or what is typical. You are reading text, not describing a product. You cannot see the product.
- A year the seller did not give: choose the next occurrence of that date from today. If they gave a year, use theirs even if it looks wrong.
- Sellers make typos and write without punctuation. Read through that, but never invent a value to repair one — if a phrase is too garbled to be sure, omit the key.
- If they restrict which options are available ("only red and blue", "black is out of stock"), "variants" is what REMAINS available.
- Return ONLY the JSON object. No markdown fences, no commentary.`;
}
