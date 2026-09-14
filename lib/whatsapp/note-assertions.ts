/**
 * Facts the seller stated outright in their notes, and whether the draft
 * honoured them.
 *
 * THE GAP THIS CLOSES. Price, stock and sale price are read from notes by
 * regex and applied directly — seller-owned fields this codebase refuses
 * to let an AI guess. Everything else the seller says ("comes in red,
 * blue and green", "brand: Kaisheng", "material: steel") is concatenated
 * into user_prompt, handed to the model as free-text context, and then
 * never checked. If the seller wrote pink and the draft says red, nothing
 * notices — not at draft time, not at push time, not ever.
 *
 * Prompting is a request. This is the verification.
 *
 * DELIBERATELY HIGH PRECISION, LOW RECALL. Only explicit, marked
 * statements are extracted: "comes in X", "brand: Y", "material is Z".
 * A bare adjective in prose ("this red lock") is NOT treated as a colour
 * assertion, because overriding the model on a guess is worse than
 * letting it stand — the same "null beats wrong" rule the rest of this
 * pipeline follows. Recall can grow later from real misses; a false
 * assertion silently rewrites a seller's listing.
 *
 * Pure and synchronous: no AI call, no network. An extra Gemini pass to
 * parse notes would cost a credit per draft to do a job a regex does
 * exactly, which is the same argument that keeps price parsing
 * deterministic.
 */

/** Listing columns an assertion can target. All are seller-owned in the
 *  sense that an explicit statement beats anything inferred from a photo. */
export type AssertionField = "brand" | "color" | "main_material" | "model";

export interface NoteAssertion {
  field: AssertionField;
  /** The value as the seller wrote it, trimmed and normalised for case. */
  value: string;
  /** Every value when the seller listed several (colours, usually). The
   *  first is `value`; the rest matter for variants. */
  values: string[];
  /** The exact text this came from, so a log or a message can quote the
   *  seller back to themselves rather than asserting something they'd
   *  have to go hunting for. */
  source: string;
}

/** Split "red, blue and green" / "red / blue" into parts. */
function splitList(raw: string): string[] {
  return raw
    .split(/,|\band\b|\/|\+/i)
    .map((p) => p.trim().replace(/[.;:]+$/, ""))
    .filter((p) => p.length > 0 && p.length <= 40);
}

/** Descriptive words read better title-cased ("red" → "Red"). Brand and
 *  model are left exactly as written: a model code like "KS-400" and a
 *  brand like "KAISHENG" carry their capitalisation, and normalising it
 *  would be the system overruling the seller on the one thing it is
 *  supposed to be preserving. */
function normaliseValue(field: AssertionField, v: string): string {
  if (field === "brand" || field === "model") return v.trim();
  return v.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/**
 * Patterns that mark an explicit statement. Each captures the value.
 *
 * Anchored on a marker word — "comes in", "brand:", "material is" —
 * rather than trying to spot bare values, which is what keeps this from
 * mistaking descriptive prose for an instruction.
 */
const PATTERNS: { field: AssertionField; re: RegExp; list?: boolean }[] = [
  // Colours, usually a list: "comes in red, blue and green"
  { field: "color", list: true, re: /\b(?:comes?|available|comes in|available in)\s+in\s+([^.!?\n]+)/i },
  { field: "color", list: true, re: /\bcolou?rs?\s*[:\-]\s*([^.!?\n]+)/i },
  { field: "color", list: true, re: /\bin\s+(?:the\s+)?colou?rs?\s+([^.!?\n]+)/i },

  { field: "brand",         re: /\bbrand\s*(?:[:\-]|\bis\b)\s*([^.,!?\n]+)/i },
  { field: "main_material", re: /\b(?:material|made\s+(?:of|from))\s*(?:[:\-]|\bis\b)?\s*([^.,!?\n]+)/i },
  { field: "model",         re: /\bmodel\s*(?:[:\-]|\bis\b)\s*([^.,!?\n]+)/i },
];

/** Words that follow a marker but carry no value. Checked per TOKEN, not
 *  against the whole phrase: "available in stock now" captures "stock
 *  now", which a whole-phrase check against "stock" sails straight past
 *  and turns into a colour called "Stock Now". */
const NON_VALUES = new Set([
  "stock", "store", "stores", "shop", "bulk", "boxes", "box", "packs", "pack",
  "sizes", "size", "different", "various", "many", "all", "any", "assorted",
  "colours", "colors", "colour", "color", "now", "today", "soon", "quantity",
]);

/** True when a captured phrase is filler rather than a value. Rejects on
 *  the FIRST token so "stock now" goes, while "red now" — which nobody
 *  writes — would survive on the token that carries meaning. */
function isNonValue(part: string): boolean {
  const tokens = part.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  if (NON_VALUES.has(tokens[0])) return true;
  return tokens.every((t) => NON_VALUES.has(t));
}

export function extractNoteAssertions(notes: string | null | undefined): NoteAssertion[] {
  const text = (notes ?? "").trim();
  if (!text) return [];

  const found = new Map<AssertionField, NoteAssertion>();

  for (const { field, re, list } of PATTERNS) {
    if (found.has(field)) continue;          // first explicit statement wins
    const match = re.exec(text);
    if (!match) continue;

    const captured = match[1].trim();
    const parts = (list ? splitList(captured) : [captured.trim()])
      .map((p) => p.replace(/[.;:,]+$/, "").trim())
      .filter((p) => p.length > 0 && !isNonValue(p));

    if (parts.length === 0) continue;

    const values = parts.map((p) => normaliseValue(field, p));
    found.set(field, { field, value: values[0], values, source: match[0].trim() });
  }

  return Array.from(found.values());
}

export interface AssertionCheck {
  assertion: NoteAssertion;
  /** What the draft actually has. */
  actual: string | null;
  /** True when the draft already agrees with the seller. */
  honoured: boolean;
}

/**
 * Compare what the seller stated against what the draft produced.
 *
 * A field counts as honoured when the stated value appears in it — not
 * only when it matches exactly. A seller who says "material: steel" is
 * satisfied by "Stainless Steel"; demanding equality would rewrite a
 * better value with a worse one.
 */
export function checkAssertions(
  assertions: NoteAssertion[],
  draft: Partial<Record<AssertionField, string | null>>,
): AssertionCheck[] {
  return assertions.map((assertion) => {
    const actual = (draft[assertion.field] ?? null) as string | null;
    const have = (actual ?? "").toLowerCase();
    const honoured = have.length > 0 && assertion.values.some((v) => have.includes(v.toLowerCase()));
    return { assertion, actual, honoured };
  });
}

/** The corrections to apply: the seller's own words win. Empty when the
 *  draft already agrees. */
export function correctionsFrom(checks: AssertionCheck[]): Partial<Record<AssertionField, string>> {
  const out: Partial<Record<AssertionField, string>> = {};
  for (const check of checks) {
    if (check.honoured) continue;
    // Colours can be a list; a single column holds the first, and the
    // rest reach the listing through variants, which the seller's own
    // note already drives.
    out[check.assertion.field] = check.assertion.value;
  }
  return out;
}
