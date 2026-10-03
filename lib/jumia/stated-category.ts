/**
 * A category the seller named in their notes, e.g. a WhatsApp caption
 * "Price GHC 89\nCategory is wigs". Live, 2026-10-01: that caption was
 * only ever a hint to the AI, whose shortlist didn't include Wigs, so two
 * wigs were drafted under Hair Extensions and Fascinators.
 *
 * Read the same way as a typed answer to the bot's category question
 * (lib/whatsapp/category-question.ts), so "category: Body Washes", a
 * pasted path and a bare name all work here too.
 */

import { listableLeafCategories, matchCategoryAnswer, normalizeWords, parseCategoryInstruction, refusedCategoryCodes, type CategoryChoice } from "@/lib/whatsapp/category-question";

/** What the notes say about the category, when they say anything usable. */
export type StatedCategory =
  /** One category fits: the seller's choice, as if they'd picked it. */
  | { kind: "match"; category: CategoryChoice }
  /** Several share the name, or the name is a parent: the AI picks among these. */
  | { kind: "options"; options: CategoryChoice[] }
  /**
   * No category has the name as written, but some come close ("Portable
   * Power Banks" for "Portable Power Banks & Battery Packs"): offered to
   * the AI first, marked, beside its usual candidates (owner's request,
   * 2026-10-03). Not the whole shortlist, since a close name can still be
   * the wrong shelf.
   */
  | { kind: "near"; options: CategoryChoice[] };

/** At most this many close matches go in front of the AI's candidates. */
const MAX_NEAR = 3;

/** Words that don't tell categories apart. */
const FILLER = new Set(["and", "or", "for", "of", "the", "with", "in", "on", "a", "an", "to"]);

/**
 * A close match worth offering: every word the seller wrote is a whole
 * word of the category's path ("power banks" in "Portable Power Banks &
 * Battery Packs"). The text search behind the near matches is fuzzy, and
 * "wiggly things" finding "Wiggle Eyes" is not a category the seller meant.
 */
function closeEnough(stated: string, option: CategoryChoice): boolean {
  const wanted = normalizeWords(stated).split(" ").filter((w) => w && !FILLER.has(w));
  if (wanted.length === 0) return false;
  const have = new Set(normalizeWords(option.path).split(" "));
  return wanted.every((w) => have.has(w));
}

/**
 * The category text from the first line of the notes that names one
 * ("Category is wigs" → "wigs"). Line by line, so a price or size on the
 * next line isn't read as part of the category.
 */
export function statedCategoryText(notes: string | null | undefined): string | null {
  for (const line of (notes ?? "").split(/\n+/)) {
    const parsed = parseCategoryInstruction(line);
    if (parsed) return parsed.category;
  }
  return null;
}

/**
 * Resolve the category named in the notes against Jumia's listable leaves,
 * leaving out any Jumia has refused in the seller's country. Close matches
 * whose path holds every word the seller wrote are offered to the AI
 * beside its own candidates ("near"); looser ones don't count, since the
 * AI's own pick still sees the notes. Tried as written, then up to the
 * first comma ("wigs, 18 inch"), since a category name can contain one too
 * ("Bags, Cases & Sleeves").
 */
export async function resolveStatedCategory(
  userId: string,
  notes:  string | null | undefined,
  title:  string | null | undefined,
): Promise<StatedCategory | null> {
  const text = statedCategoryText(notes);
  if (!text) return null;

  const [leaves, refused] = await Promise.all([listableLeafCategories(), refusedCategoryCodes(userId, null)]);
  const attempts = [text, text.split(/[,;]/)[0].trim()].filter((t, i, all) => t.length >= 2 && all.indexOf(t) === i);
  let near: CategoryChoice[] = [];
  for (const attempt of attempts) {
    const answer = matchCategoryAnswer(attempt, leaves, refused, { title, limit: 8 });
    if (answer.kind === "match") return { kind: "match", category: answer.category };
    // Every category of that exact name (Jumia has seven called Wigs), or
    // the five likeliest under a named parent.
    if (answer.kind === "choose" && (answer.exact || answer.under)) {
      return { kind: "options", options: answer.options.slice(0, answer.exact ? 8 : 5) };
    }
    // Kept until every attempt has had its chance at an exact match.
    if (answer.kind === "choose" && near.length === 0) {
      near = answer.options.filter((o) => closeEnough(attempt, o)).slice(0, MAX_NEAR);
    }
  }
  return near.length > 0 ? { kind: "near", options: near } : null;
}
