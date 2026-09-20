/**
 * resolveMatchedValue / buildAllowedValueMatchPrompt
 * (lib/jumia/variant-value-match.ts) — the AI-assisted fallback for a
 * seller-stated variant value that doesn't literally match a category's
 * own hardcoded options (e.g. "Large" against an axis whose real option
 * is "L", or "18 inch" against `18"`).
 *
 * resolveMatchedValue is the entire safety boundary: only pure,
 * synchronous logic is tested here. The actual Gemini call
 * (aiMatchAllowedValue, lib/actions/ai.ts) is untested by design, same as
 * the sibling aiReadNoteIntent — the model may fail to find a real match,
 * but resolveMatchedValue guarantees it can never invent one that wasn't
 * in the list it was given.
 */

import { resolveMatchedValue, buildAllowedValueMatchPrompt } from "@/lib/jumia/variant-value-match";

describe("resolveMatchedValue", () => {
  const allowed = ["S", "M", "L", "XL", "One Size Fits All", "..."];

  it("accepts an exact match", () => {
    expect(resolveMatchedValue("M", allowed)).toBe("M");
  });

  it("accepts a case-insensitive match", () => {
    expect(resolveMatchedValue("xl", allowed)).toBe("XL");
  });

  it("rejects a value the model invented that isn't in the allowed list — the entire safety boundary", () => {
    expect(resolveMatchedValue("Medium", allowed)).toBeNull();
  });

  it("treats the literal word NONE as no match", () => {
    expect(resolveMatchedValue("NONE", allowed)).toBeNull();
    expect(resolveMatchedValue("none", allowed)).toBeNull();
  });

  it("treats an empty or whitespace-only answer as no match", () => {
    expect(resolveMatchedValue("", allowed)).toBeNull();
    expect(resolveMatchedValue("   ", allowed)).toBeNull();
  });

  it("trims surrounding whitespace before comparing", () => {
    expect(resolveMatchedValue("  L  ", allowed)).toBe("L");
  });

  it("never matches against an empty allowed list", () => {
    expect(resolveMatchedValue("M", [])).toBeNull();
  });
});

describe("buildAllowedValueMatchPrompt", () => {
  it("includes the stated value and every allowed option", () => {
    const prompt = buildAllowedValueMatchPrompt("Large", ["S", "M", "L", "XL"]);
    expect(prompt).toContain("Large");
    expect(prompt).toContain('"S"');
    expect(prompt).toContain('"M"');
    expect(prompt).toContain('"L"');
    expect(prompt).toContain('"XL"');
  });

  it("instructs the model to answer NONE rather than guess when nothing corresponds", () => {
    const prompt = buildAllowedValueMatchPrompt("Large", ["S", "M", "L", "XL"]);
    expect(prompt).toMatch(/NONE/);
  });

  it("includes the seller's full note as context when given", () => {
    const prompt = buildAllowedValueMatchPrompt("Large", ["S", "M", "L"], "comes in medium and large sizes");
    expect(prompt).toContain("comes in medium and large sizes");
  });

  it("omits the context section entirely when none is given", () => {
    const withContext = buildAllowedValueMatchPrompt("Large", ["S", "M", "L"], "some note");
    const withoutContext = buildAllowedValueMatchPrompt("Large", ["S", "M", "L"], null);
    expect(withoutContext.length).toBeLessThan(withContext.length);
    expect(withoutContext).not.toContain("full note");
  });
});
