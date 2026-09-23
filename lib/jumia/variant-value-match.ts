/**
 * Match what a seller said about a product's variant to one of a Jumia
 * category's own hardcoded allowed values, when the two don't literally
 * match.
 *
 * THE GAP THIS CLOSES. snapToAllowedWithSynonyms (lib/jumia/preflight.ts)
 * already bridges casing ("pink"/"Pink"), plurals ("Hard Hat"/"Hard
 * Hats"), and a couple of British/American spelling pairs ("Grey"/
 * "Gray"). None of that helps when a seller writes "Large" for a category
 * whose own axis is the abbreviation "L", or "18 inch" for an axis that
 * spells it "18\"" — those aren't spelling drift, they're a genuinely
 * different string for the same option. A live example that motivated
 * this: a Backpacks & Carriers listing whose seller note named a size the
 * category's own axis DID stock, but not in the seller's wording, so it
 * fell back to the "..." placeholder instead of the size the seller
 * actually meant.
 *
 * A hand-written table of synonyms (small/S, medium/M, ...) only covers
 * the phrasings someone thought of, and Jumia's categories are not all
 * clothing sizes — the same gap shows up on inches, capacities, pack
 * counts, anything with its own closed vocabulary. So instead of growing
 * a table forever, the category's own exact, closed list of options is
 * handed to a model and it is asked which one the seller meant BY
 * MEANING, not spelling.
 *
 * WHY THIS IS SAFE THE SAME WAY note-intent.ts'S QUOTE CHECK IS. The
 * model is never allowed to invent a new option — resolveMatchedValue
 * only accepts an answer that is character-for-character (case aside)
 * one of the exact values it was given. A wrong answer here is "missed a
 * real match", not "made one up" — the same asymmetry variant-claims.ts
 * follows: nothing safe to send beats something invented.
 */

export function buildAllowedValueMatchPrompt(
  stated:  string,
  allowed: string[],
  context?: string | null,
): string {
  const trimmedContext = (context ?? "").trim();
  return `A seller described part of a product listing like this: "${stated}"${
    trimmedContext
      ? `\n\nTheir full note, for context (do not use anything from here that isn't relevant to the field above):\n"""\n${trimmedContext}\n"""`
      : ""
  }

This product's category on Jumia only accepts ONE of the following EXACT values for this field — nothing else is allowed:
${allowed.map((a) => `- "${a}"`).join("\n")}

Which one of these exact values does the seller's description correspond to? Match by MEANING, not spelling — for example "Medium" means "M", "Large" means "L", "18 inch" means \`18"\`, "Extra Large" means "XL", if those happen to be among the category's own options above. If none of the listed values plausibly correspond to what the seller said, say so rather than guessing.

Return ONLY this JSON, nothing else:
{ "match": "<one of the exact values listed above, copied character-for-character, or the word NONE if none of them correspond>" }`;
}

/**
 * True only when `candidate` is (case aside) one of `allowed` — never
 * trust anything else the model returns, no matter how plausible-looking.
 * This is the entire safety boundary: the model chooses among options
 * it was handed, it does not get to mint a new one.
 */
export function resolveMatchedValue(candidate: string, allowed: string[]): string | null {
  const trimmed = candidate.trim();
  if (!trimmed || trimmed.toUpperCase() === "NONE") return null;

  const exact = allowed.find((a) => a === trimmed);
  if (exact) return exact;

  return allowed.find((a) => a.toLowerCase() === trimmed.toLowerCase()) ?? null;
}
