import { normaliseRichTextValue } from "@/lib/utils/rich-text-value";

// The confirmed live failure: on the review page, Description displayed
// its markup to the seller as literal "<strong>" and "<ul>" text while
// Highlights — the same field type, the same component, the same page —
// rendered properly.
//
// Cause was entirely in here. The HTML test was anchored to the START of
// the value, so it only recognised content that opened with a tag.
// Highlights always begins "<ul>". A Description routinely opens with an
// unwrapped prose paragraph and doesn't reach its first tag for hundreds
// of characters — measured at 319, 373 and 609 on real listings. Anchored,
// those read as plain text and got escaped, tags and all.
describe("normaliseRichTextValue — HTML detection", () => {
  it("passes through a value that opens with a tag (the Highlights shape)", () => {
    const html = "<ul>\n<li><strong>Reliable Head Protection:</strong> Essential safety gear.</li>\n</ul>";
    expect(normaliseRichTextValue(html)).toBe(html);
  });

  it("passes through a value whose first tag is hundreds of characters in — the live bug", () => {
    const prose = "This collection features a variety of vibrant safety helmets, essential for protecting workers. ".repeat(6);
    const mixed = `${prose}<ul> <li><strong>Robust Protection:</strong> Shields against falling objects.</li> </ul>`;
    expect(mixed.indexOf("<")).toBeGreaterThan(300);

    const out = normaliseRichTextValue(mixed);
    expect(out).toBe(mixed);
    // The precise symptom: real tags must never come back escaped.
    expect(out).not.toContain("&lt;strong&gt;");
    expect(out).not.toContain("&lt;ul&gt;");
  });

  it("recognises an inline tag on its own, not just block elements", () => {
    const v = "Durable and light. <strong>Built to last.</strong>";
    expect(normaliseRichTextValue(v)).toBe(v);
  });

  it("still escapes a genuinely plain-text value, so stray angle brackets are safe", () => {
    // No recognised tag anywhere — this really is plain text, and a bare
    // "<" in it (a size like "<10kg") must not become broken markup.
    expect(normaliseRichTextValue("Fits loads <10kg")).toBe("<p>Fits loads &lt;10kg</p>");
  });
});

describe("normaliseRichTextValue — plain-text conversion", () => {
  it("converts a legacy bullet list into a real <ul>", () => {
    expect(normaliseRichTextValue("• Durable build\n• Ventilated design")).toBe(
      "<ul><li>Durable build</li><li>Ventilated design</li></ul>",
    );
  });

  it("needs two bullets — one line starting with a dash is a sentence, not a list", () => {
    expect(normaliseRichTextValue("- Only one line here")).toBe("<p>- Only one line here</p>");
  });

  it("splits blank-line-separated blocks into paragraphs and single breaks into <br>", () => {
    expect(normaliseRichTextValue("First para\nsecond line\n\nSecond para")).toBe(
      "<p>First para<br>second line</p><p>Second para</p>",
    );
  });

  it("returns an empty string for empty or whitespace-only input", () => {
    expect(normaliseRichTextValue("")).toBe("");
    expect(normaliseRichTextValue("   \n  ")).toBe("");
  });
});
