import {
  buildStyleGuideBlock,
  buildSearchGroundingInstruction,
  buildDescriptionAndHighlightsStyleBlock,
  buildDescriptionStyleBlock,
} from "@/lib/ai/content-style-rules";
import type { HarvestedField } from "@/lib/extension/fill";

describe("buildStyleGuideBlock", () => {
  it("returns nothing when the page has no Name/Description/Highlights field", () => {
    const fields: HarvestedField[] = [{ label: "Weight (kg)", type: "text" }];
    expect(buildStyleGuideBlock(fields)).toBe("");
  });

  it("includes only the rules for fields present on the page", () => {
    const fields: HarvestedField[] = [
      { label: "Name", type: "text" },
      { label: "Weight (kg)", type: "text" },
    ];
    const block = buildStyleGuideBlock(fields);
    expect(block).toContain("Name/title:");
    expect(block).not.toContain("Description:");
    expect(block).not.toContain("Highlights:");
  });

  it("does not treat 'Brand' as a Name field", () => {
    const fields: HarvestedField[] = [{ label: "Brand", type: "combobox" }];
    expect(buildStyleGuideBlock(fields)).toBe("");
  });

  it("includes all three rules plus the closing rule when all three fields are present", () => {
    const fields: HarvestedField[] = [
      { label: "Name", type: "text" },
      { label: "Product description", type: "richtext" },
      { label: "Highlights", type: "richtext" },
    ];
    const block = buildStyleGuideBlock(fields);
    expect(block).toContain("Name/title:");
    expect(block).toContain("Description:");
    expect(block).toContain("Highlights:");
    expect(block).toContain("Never end description or highlights with a request for reviews");
    expect(block.startsWith("\n\nCONTENT STYLE:\n")).toBe(true);
  });

  it("explicitly frees tables from a fixed 2-column Spec/Value shape", () => {
    const fields: HarvestedField[] = [
      { label: "Product description", type: "richtext" },
      { label: "Highlights", type: "richtext" },
    ];
    const block = buildStyleGuideBlock(fields);
    // The old, rigid instruction locked every table to this exact shape —
    // it should be gone, replaced by explicit "use however many columns/
    // rows fit" language (which is allowed to still mention "2-column" only
    // to say tables AREN'T capped there).
    expect(block).not.toContain("<tr><td>Spec</td><td>Value</td></tr>");
    expect(block).toMatch(/not capped at a?n? ?2-column|use as many columns/i);
  });

  it("sets explicit character-count floors (1500 Description / 800 Highlights), excluding tables", () => {
    const withNarrative = buildStyleGuideBlock([
      { label: "Product description", type: "richtext" },
      { label: "Highlights", type: "richtext" },
    ]);
    expect(withNarrative).toMatch(/at least 1500 characters/);
    expect(withNarrative).toMatch(/at least 800 characters/);
    // Both floors must explicitly exclude table content, or a big <table>
    // could satisfy the minimum with no real written substance.
    expect(withNarrative.match(/not counting anything inside a <table>/g)?.length).toBe(2);
    expect(withNarrative).toContain("too thin to be useful");
  });

  it("leaves whether to use a table entirely up to the AI, for both fields", () => {
    const block = buildStyleGuideBlock([
      { label: "Product description", type: "richtext" },
      { label: "Highlights", type: "richtext" },
    ]);
    expect(block).toMatch(/table at all is (entirely )?(your|its) own call/);
  });

  it("tells the AI structure should vary between listings, not follow one fixed template", () => {
    const block = buildStyleGuideBlock([
      { label: "Product description", type: "richtext" },
      { label: "Highlights", type: "richtext" },
    ]);
    expect(block).toMatch(/vary from one listing to the next/);
  });

  it("no longer carries its own search-grounding instruction — that's unconditional now, in buildSearchGroundingInstruction", () => {
    // Regression guard: this used to live as a field-gated CONTENT_STYLE_RULES
    // entry here. It moved out to apply to structured attributes too (Model,
    // Country of origin, ...), not just Description/Highlights — asserting
    // its absence here prevents it silently coming back and duplicating.
    const withNarrative = buildStyleGuideBlock([
      { label: "Product description", type: "richtext" },
      { label: "Highlights", type: "richtext" },
    ]);
    expect(withNarrative).not.toContain("You have web search available");
  });
});

describe("buildDescriptionAndHighlightsStyleBlock", () => {
  it("matches what buildStyleGuideBlock returns when both fields are present, for the main analyze pipeline (no HarvestedField list to filter against)", () => {
    const viaFields = buildStyleGuideBlock([
      { label: "Product description", type: "richtext" },
      { label: "Highlights", type: "richtext" },
    ]);
    expect(buildDescriptionAndHighlightsStyleBlock()).toBe(viaFields);
  });

  it("excludes the Name/title rule — a title isn't a rich-text/table field", () => {
    const block = buildDescriptionAndHighlightsStyleBlock();
    expect(block).not.toContain("Name/title:");
    expect(block).toContain("Description:");
    expect(block).toContain("Highlights:");
  });
});

describe("buildDescriptionStyleBlock", () => {
  it("includes only the Description rule, not Highlights", () => {
    const block = buildDescriptionStyleBlock();
    expect(block).toContain("Description:");
    expect(block).not.toContain("Highlights:");
    expect(block).not.toContain("Name/title:");
  });

  it("still carries the 1500-character floor and the closing rule", () => {
    const block = buildDescriptionStyleBlock();
    expect(block).toMatch(/at least 1500 characters/);
    expect(block).toContain("Never end description or highlights with a request for reviews");
  });
});

describe("buildSearchGroundingInstruction", () => {
  it("is unconditional — not gated by which fields are on the page", () => {
    expect(buildSearchGroundingInstruction()).toContain("You have web search available");
  });

  it("covers structured attributes as well as Description/Highlights", () => {
    const block = buildSearchGroundingInstruction();
    expect(block).toContain("Description/Highlights");
    expect(block).toMatch(/Model.*Main material.*Country of origin.*Certifications/);
  });

  it("still forbids citations from leaking into narrative copy or a structured field's value", () => {
    const block = buildSearchGroundingInstruction();
    expect(block).toContain("never surface the search itself in the copy");
    expect(block).toMatch(/never a citation, URL/);
  });

  it("gates on confidence — never asserts a searched fact without it", () => {
    const block = buildSearchGroundingInstruction();
    expect(block).toMatch(/genuinely confident/);
  });
});
