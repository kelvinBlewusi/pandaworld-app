/**
 * What the seller said about WHICH options they actually stock, and
 * whether the draft's variant list respects it.
 *
 * THE GAP THIS CLOSES, verbatim from a live note under a photo of five
 * coloured hard hats:
 *
 *   "Only black is red is available"
 *
 * The draft came back with all five colours from the photo. The seller
 * now has a live Jumia listing offering four colours they do not stock.
 *
 * The prompt already forbids this in as many words — a garbled
 * availability line must never fall back to the image, because "a
 * catalogue/stock photo showing several colour options does not mean the
 * seller actually stocks all of them". The instruction was there and was
 * not followed. So this stops asking and checks, on the same reasoning
 * that keeps price and stock on regex: getting a seller's stock wrong on
 * a live marketplace is worse than asking them.
 *
 * Pure and synchronous. No AI call — an extra model pass to re-read the
 * note would be paying a credit to re-run the judgement that just failed.
 *
 * THE ASYMMETRY THAT DRIVES EVERY RULE BELOW. Too few variants is a
 * seller adding one back in the editor. Too many is stock they must
 * honour or cancel, on a marketplace that penalises cancellations. So
 * where this is unsure, it keeps nothing and asks — never "best guess".
 */

/** Words that can sit inside a claim without naming an option. */
const CONNECTORS = new Set([
  "is", "are", "was", "be", "the", "a", "an", "and", "or", "plus", "with",
  "only", "just", "available", "availabe", "avail", "in", "stock", "left",
  "remaining", "have", "has", "got", "now", "currently", "colour", "color",
  "colours", "colors", "option", "options", "variant", "variants", "one",
  "ones", "size", "sizes", "version", "versions", "them", "this", "that",
  "i", "we", "my", "our", "it", "for", "of", "to", "sale", "sell", "selling",
  // Additive fillers. "we have blue too" / "black, and also red" name
  // exactly as many options as without the filler word — treating "too"
  // or "also" as a candidate option name is what made a live batch drop a
  // seller's whole colour claim, because neither one is ever going to
  // match a colour/size the photo actually shows.
  "too", "also",
]);

/** Markers that introduce a restriction on what's in stock. Each captures
 *  the phrase naming the options.
 *
 *  Anchored on a marker, never on bare values — the same rule that keeps
 *  note-assertions.ts from reading descriptive prose as an instruction. */
const CLAIM_PATTERNS: RegExp[] = [
  // "only red and blue are available" / "only red is available"
  /\bonly\s+([^.!?\n]+?)\s+(?:is|are)\s+(?:available|in\s+stock|left)\b/i,
  // "red and blue only" / "red only"
  /\b([^.!?\n]+?)\s+only\s+(?:is|are)?\s*(?:available|in\s+stock|left)\b/i,
  // "I only have red and blue" / "we have only red"
  /\b(?:i|we)\s+(?:only\s+)?(?:have|got|stock)\s+(?:only\s+)?([^.!?\n]+)/i,
  // "available: red, blue" / "in stock - red"
  /\b(?:available|in\s+stock)\s*[:\-]\s*([^.!?\n]+)/i,
  // "Sizes Medium Large Xtra Large" / "Size: S, M, L" — WhatsApp captions
  // routinely list sizes this way; without this pattern extractVariantClaim
  // returns null and noteWarningsFor never Holds even when the draft soft-
  // snapped "Xtra Large" → XL (staging canary 2026-09-22).
  /\bsizes?\s*[:\-]?\s*([^.!?\n]+)/i,
  // Bare "only red and blue" — last, so the fuller forms above win.
  /\bonly\s+([^.!?\n]+)/i,
];

export interface VariantClaim {
  /** The exact text the claim came from, so a message can quote the
   *  seller back to themselves instead of paraphrasing. */
  source: string;
  /** Every word in the claim that isn't a connector — the candidate
   *  option names, in the order written. */
  tokens: string[];
}

/**
 * The seller's stated restriction on which options exist, if they made
 * one. Null means they said nothing about availability, and the draft's
 * own variant list stands untouched.
 */
export function extractVariantClaim(notes: string | null | undefined): VariantClaim | null {
  const text = (notes ?? "").trim();
  if (!text) return null;

  for (const re of CLAIM_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const tokens = m[1]
      .toLowerCase()
      .split(/[\s,/+]+|\band\b|\bor\b/i)
      .map((t) => t.replace(/[^a-z0-9-]/gi, "").trim())
      .filter((t) => t.length > 0 && !CONNECTORS.has(t));
    if (tokens.length === 0) continue;
    return { source: m[0].trim(), tokens };
  }
  return null;
}

export type VariantReconciliation =
  /** No claim — the draft's variants stand. */
  | { kind: "no_claim" }
  /** Every token in the claim names a variant the draft proposed, and
   *  nothing in the claim is unaccounted for. Keep exactly these. */
  | { kind: "restrict"; keep: string[]; source: string }
  /** The seller was plainly talking about availability, but the claim
   *  can't be resolved against the draft's options. Keep NOTHING and ask. */
  | { kind: "unresolved"; reason: string; source: string };

/**
 * Reconcile a seller's availability claim against the variant labels the
 * model proposed.
 *
 * `restrict` requires the claim to be fully accounted for — every token
 * maps to a proposed label. A single leftover token means the seller
 * named something the draft doesn't have ("black", when the photo shows
 * red/yellow/orange/white/blue), and at that point we no longer know
 * whether they misspoke, meant a colour not pictured, or typed through a
 * word. That is exactly the state the live note was in:
 *
 *   "Only black is red is available"  →  black ✗, red ✓  →  unresolved
 *
 * Resolving it to "Red" on the strength of the one token that happens to
 * match would be a guess about someone's inventory.
 */
export function reconcileVariants(
  claim:    VariantClaim | null,
  proposed: string[],
): VariantReconciliation {
  if (!claim) return { kind: "no_claim" };

  const byLower = new Map(proposed.map((label) => [label.toLowerCase(), label]));

  const matched:   string[] = [];
  const unmatched: string[] = [];
  for (const token of claim.tokens) {
    // A label matches when the token IS it, or is a word inside it —
    // "red" against a proposed "Red Safety Helmet". Never the reverse: a
    // token that merely contains a label ("reddish") is not that label.
    const exact = byLower.get(token);
    if (exact) {
      if (!matched.includes(exact)) matched.push(exact);
      continue;
    }
    const worded = proposed.find((label) =>
      label.toLowerCase().split(/[\s-]+/).includes(token),
    );
    if (worded) {
      if (!matched.includes(worded)) matched.push(worded);
      continue;
    }
    unmatched.push(token);
  }

  if (unmatched.length > 0) {
    return {
      kind:   "unresolved",
      source: claim.source,
      reason: matched.length > 0
        ? `it names ${unmatched.join(", ")}, which isn't one of the options in the photo`
        : `none of ${claim.tokens.join(", ")} matches the options in the photo`,
    };
  }

  if (matched.length === 0) {
    return {
      kind:   "unresolved",
      source: claim.source,
      reason: "it doesn't name any of the options in the photo",
    };
  }

  return { kind: "restrict", keep: matched, source: claim.source };
}

/**
 * Whether the seller's notes say anything about options at all: a claim
 * extractVariantClaim reads, or "comes in red and blue", "colours: …",
 * "3 sizes", "variations: …". Without one a draft is one variant, however
 * many the photos show (owner's request, 2026-10-03: two unlabelled
 * variants on a single product stopped its submit with "Variant 2 has no
 * Variation label").
 */
export function notesNameVariants(notes: string | null | undefined): boolean {
  const text = (notes ?? "").trim();
  if (!text) return false;
  if (extractVariantClaim(text)) return true;
  return /\b(?:comes?\s+in|available\s+in|in\s+(?:different|various|\d+|two|three|four|five|six)\s+(?:colou?rs|sizes|types|flavou?rs|scents|designs|styles)|(?:colou?rs?|variants?|variations?|options?|flavou?rs?|scents?|designs?|styles?|types?)\s*[:\-]|variants\b|variations\b|(?:\d+|two|three|four|five|six|seven|eight|nine|ten)\s+(?:colou?rs|sizes|variants|variations|types|options|flavou?rs|scents|designs|styles))/i.test(text);
}

/** The seller-facing sentence for a claim that couldn't be resolved.
 *  Quotes them verbatim: a seller who wrote a typo recognises it far
 *  faster than they recognise our paraphrase of it. */
export function variantClaimWarning(r: VariantReconciliation): string | null {
  if (r.kind !== "unresolved") return null;
  return `you wrote "${r.source}" — ${r.reason}, so no colour/size options were added. Tap Edit to set the ones you actually stock`;
}
