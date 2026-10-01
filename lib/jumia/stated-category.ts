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

import { listableLeafCategories, matchCategoryAnswer, parseCategoryInstruction, refusedCategoryCodes, type CategoryChoice } from "@/lib/whatsapp/category-question";

/** What the notes say about the category, when they say anything usable. */
export type StatedCategory =
  /** One category fits: the seller's choice, as if they'd picked it. */
  | { kind: "match"; category: CategoryChoice }
  /** Several share the name, or the name is a parent: the AI picks among these. */
  | { kind: "options"; options: CategoryChoice[] };

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
 * leaving out any Jumia has refused in the seller's country. Near matches
 * don't count: guessing from a loose match is worse than the AI's own
 * pick, which still sees the notes. Tried as written, then up to the first
 * comma ("wigs, 18 inch"), since a category name can contain one too
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
  for (const attempt of attempts) {
    const answer = matchCategoryAnswer(attempt, leaves, refused, { title, limit: 8 });
    if (answer.kind === "match") return { kind: "match", category: answer.category };
    // Every category of that exact name (Jumia has seven called Wigs), or
    // the five likeliest under a named parent.
    if (answer.kind === "choose" && (answer.exact || answer.under)) {
      return { kind: "options", options: answer.options.slice(0, answer.exact ? 8 : 5) };
    }
  }
  return null;
}
