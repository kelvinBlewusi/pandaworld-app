/**
 * Regression coverage for item 4 of the post-20-product-batch external
 * advice review: JUMIA_RESTRICTED_WORDS is our own copy of Jumia's
 * blacklist, and assertListingReady (lib/jumia/listing-ready.ts) already
 * runs it before every push — but a word missing from OUR list slips
 * through that gate and only gets caught by Jumia itself, on a real
 * submission. Three such words were confirmed live in the WhatsApp
 * transcripts reviewed this session, each with Jumia's own exact
 * rejection string (see CONTRIBUTING.md — no fix here without one):
 *
 *   - "supreme" — 2026-09-17 batch, FreePods Pro description:
 *     "The Attribute [description] contains the restricted words : supreme"
 *   - "second hand" — 2026-09-19 batch, DIY Wall Clock description:
 *     "The Attribute [description] contains the restricted words : second hand"
 *   - "allure" — 2026-09-15 production listing, paired with a trademark
 *     warning (Chanel's Allure line):
 *     "The Attribute [description] contains the restricted words : allure"
 */

import { findRestrictedWords, stripRestrictedWords } from "@/lib/ai/restricted-words";

describe("JUMIA_RESTRICTED_WORDS — words confirmed missing from a live rejection", () => {
  it('catches "supreme" the way Jumia rejected it (FreePods Pro description, 2026-09-17)', () => {
    const description = "FreePods Pro ANC Wireless Headphones deliver supreme sound quality with hybrid noise cancellation.";
    expect(findRestrictedWords(description)).toContain("supreme");
    expect(stripRestrictedWords(description)).not.toMatch(/\bsupreme\b/i);
  });

  it('catches "second hand" the way Jumia rejected it (DIY Wall Clock description, 2026-09-19)', () => {
    const description = "This wall clock is not second hand — it ships brand new with large numbers and a 3D effect.";
    expect(findRestrictedWords(description)).toContain("second hand");
    expect(stripRestrictedWords(description)).not.toMatch(/second hand/i);
  });

  it('catches "allure" the way Jumia rejected it (production listing, 2026-09-15)', () => {
    const description = "Inspired by the allure of classic fragrances, this perfume oil lasts all day.";
    expect(findRestrictedWords(description)).toContain("allure");
    expect(stripRestrictedWords(description)).not.toMatch(/\ballure\b/i);
  });

  it("still matches case-insensitively and at a sentence boundary", () => {
    expect(findRestrictedWords("Supreme quality.")).toContain("supreme");
    expect(findRestrictedWords("SECOND HAND items not accepted.")).toContain("second hand");
    expect(findRestrictedWords("Allure.")).toContain("allure");
  });

  // Whole-word matching (the same \b(...)\b regex every existing entry
  // relies on) must not fire on "supreme"/"allure" as a PREFIX of a longer
  // unrelated word — otherwise ordinary product copy gets silently
  // mangled. "second hand" is a two-word phrase (like the existing "brand
  // new"/"next day delivery" entries) so this isn't a concern for it in
  // the same way — a literal "second hand" substring is always the
  // intended match, same tradeoff those existing entries already accept.
  it("does not false-positive on 'supreme'/'allure' as a prefix of a longer word", () => {
    expect(findRestrictedWords("Supremely comfortable ergonomic design.")).not.toContain("supreme");
    expect(findRestrictedWords("Allureth is not a real word, but this checks the boundary anyway.")).toEqual([]);
  });

  it("strips all three from one string, leaving the rest of the sentence intact", () => {
    const text = "This supreme, second hand item has real allure for collectors.";
    const stripped = stripRestrictedWords(text);
    expect(stripped).not.toMatch(/\bsupreme\b/i);
    expect(stripped).not.toMatch(/second hand/i);
    expect(stripped).not.toMatch(/\ballure\b/i);
    expect(stripped).toContain("This");
    expect(stripped).toContain("item");
    expect(stripped).toContain("for collectors");
  });
});
