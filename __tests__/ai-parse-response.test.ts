/**
 * parseAIResponse (lib/actions/ai.ts) — hardened against raw control
 * bytes (literal newlines/tabs/CR) landing inside a JSON string literal.
 *
 * Staging WhatsApp canary, 2026-09-21: a 3-product batch died mid-Gemini
 * because one product's `description`/`highlights` value came back with a
 * literal newline byte instead of the "\n" escape every prompt in this
 * file asks for — V8's JSON.parse rejected it outright with "Bad control
 * character in string literal in JSON at position N", uncaught, deep
 * inside the describe/analyze pipeline.
 */

import { parseAIResponse } from "@/lib/actions/ai";

describe("parseAIResponse — control characters inside string literals", () => {
  it("parses a clean response unchanged", () => {
    const raw = JSON.stringify({ title: "A Product", highlights: "• one\\n• two\\n• three" });
    expect(parseAIResponse(raw)).toEqual({ title: "A Product", highlights: "• one\\n• two\\n• three" });
  });

  it("strips a ```json fence and still parses", () => {
    const raw = "```json\n" + JSON.stringify({ title: "Fenced" }) + "\n```";
    expect(parseAIResponse(raw)).toEqual({ title: "Fenced" });
  });

  it("throws the original V8 error on a raw literal newline inside a string, before the fix", () => {
    // Documents the exact failure this closes: a raw \x0A byte (not the
    // two-character \n escape) inside a JSON string is invalid per spec.
    const brokenJson = `{"title":"ok","description":"line one\nline two"}`;
    expect(() => JSON.parse(brokenJson)).toThrow(/Bad control character/i);
  });

  it("recovers a description with a raw literal newline instead of an escaped \\n", () => {
    const raw = `{"title":"Electric Kettle","description":"Boils water fast.\nGreat for tea and coffee."}`;
    const parsed = parseAIResponse(raw);
    expect(parsed.title).toBe("Electric Kettle");
    expect(parsed.description).toBe("Boils water fast.\nGreat for tea and coffee.");
  });

  it("recovers a highlights field with raw newlines between bullets", () => {
    const raw = `{"title":"Navy Tee","highlights":"• Soft cotton\n• Machine washable\n• True to size\n• Breathable fit"}`;
    const parsed = parseAIResponse(raw);
    expect(parsed.highlights).toBe("• Soft cotton\n• Machine washable\n• True to size\n• Breathable fit");
  });

  it("recovers raw CR and TAB bytes inside a string", () => {
    const raw = `{"title":"CR\rTest","note":"a\tb"}`;
    const parsed = parseAIResponse(raw);
    expect(parsed.title).toBe("CR\rTest");
    expect(parsed.note).toBe("a\tb");
  });

  it("recovers an arbitrary control byte (not just \\n/\\r/\\t) via a \\u escape", () => {
    const rawBell = String.fromCharCode(0x07); // BEL — not one of the named escapes
    const raw = `{"title":"Bell${rawBell}Sound"}`;
    const parsed = parseAIResponse(raw);
    expect(parsed.title).toBe(`Bell${rawBell}Sound`);
  });

  it("never touches insignificant JSON whitespace outside string literals", () => {
    const raw = "{\n  \"title\": \"Spaced Out\",\n  \"description\": \"fine\"\n}";
    const parsed = parseAIResponse(raw);
    expect(parsed).toEqual({ title: "Spaced Out", description: "fine" });
  });

  it("leaves an already-escaped \\n inside a string untouched (does not double-escape)", () => {
    const raw = `{"highlights":"• one\\n• two"}`;
    const parsed = parseAIResponse(raw);
    expect(parsed.highlights).toBe("• one\n• two");
  });

  it("does not get confused by an escaped backslash immediately followed by a quote", () => {
    const raw = `{"path":"C:\\\\","title":"ok"}`;
    const parsed = parseAIResponse(raw);
    expect(parsed.path).toBe("C:\\");
    expect(parsed.title).toBe("ok");
  });

  // Mirrors the actual canary failure shape: a long, real-world
  // description + highlights block (well past 3000 characters, so the
  // bad byte lands near the same position V8 reported live) with a raw
  // newline dropped in partway through, exactly as auto-analyze's prompts
  // ask Gemini to produce for a real kettle listing.
  it("recovers a large real-shaped payload with a raw newline near the position the live canary hit (~3500)", () => {
    const filler = "Boil water quickly and efficiently for your favorite hot beverages. ".repeat(45); // ~3200 chars
    const description =
      filler +
      "With a generous 1.8L capacity, it's perfect for the whole family.\n" + // raw newline here
      "Auto shut-off and boil-dry protection included for safety.";
    const highlights = "• 1.8L capacity\n• Auto shut-off\n• Boil-dry protection\n• Cordless base";

    const payload = {
      title: "Electric Kettle - 1.8L Capacity",
      description,
      highlights,
      color: "Silver",
      weight_kg: 1.2,
    };
    // Build the raw string the way Gemini actually would: valid JSON
    // except the one raw newline byte embedded above (JSON.stringify
    // would have escaped it correctly, so splice it in by hand).
    const raw = JSON.stringify(payload).replace(
      "the whole family.\\n" /* JSON.stringify's own escaped form */,
      "the whole family.\n" /* the literal byte Gemini actually sent */,
    );

    // Sanity check this fixture actually reproduces the real crash first.
    expect(() => JSON.parse(raw)).toThrow(/Bad control character/i);
    expect(raw.length).toBeGreaterThan(3200);

    const parsed = parseAIResponse(raw);
    expect(parsed.title).toBe("Electric Kettle - 1.8L Capacity");
    expect(parsed.description).toBe(description);
    expect(parsed.highlights).toBe(highlights);
    expect(parsed.weight_kg).toBe(1.2);
  });

  it("still throws a clear error when there is genuinely no JSON object", () => {
    expect(() => parseAIResponse("sorry, I can't help with that")).toThrow(/No JSON object/i);
  });
});
