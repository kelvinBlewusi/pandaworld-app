import {
  buildStyleGuideBlock,
  buildSearchGroundingInstruction,
  buildDescriptionAndHighlightsStyleBlock,
  detectPhotoNarration,
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

// The live bug this rule exists to prevent: descriptions opened with
// hundreds of characters of BARE prose before their first tag (measured
// at 319, 373 and 609 on real listings) while highlights, asked for a
// <ul>, always started at character 1. RichTextField's HTML sniffing
// then read the description as plain text and escaped it, so sellers saw
// "<strong>" and "<ul>" spelled out on screen in one field and rendered
// properly in the other — same component, same page.
describe("well-formed HTML rule", () => {
  it("is attached to every block that asks for description or highlights", () => {
    for (const block of [buildDescriptionAndHighlightsStyleBlock(), buildDescriptionStyleBlock()]) {
      expect(block).toContain("WELL-FORMED HTML");
      expect(block).toMatch(/wrap each prose paragraph in <p>/);
    }
  });

  it("bans the empty bold heading seen in a live description", () => {
    // A shipped listing contained a bare "<strong>:</strong>", which
    // renders on Jumia as a stray bold colon.
    expect(buildDescriptionStyleBlock()).toContain("<strong>:</strong>");
  });

  it("is NOT attached when only the title rule applies — a title is a plain string", () => {
    const titleOnly = buildStyleGuideBlock([{ label: "Name", type: "text" }]);
    expect(titleOnly).toContain("Name/title:");
    expect(titleOnly).not.toContain("WELL-FORMED HTML");
  });

  it("is not emitted at all when no rule applies", () => {
    expect(buildStyleGuideBlock([{ label: "Warranty duration", type: "text" }])).toBe("");
  });
});

// A live listing for a pink combination cable lock read:
//
//   "The 'NEW TO GO' branding suggests a modern and updated design, while
//    the 'KAISHENG YOUPIN' logo indicates a focus on quality hardware
//    tools. The packaging also highlights 'Your car guard, new generation
//    explosion-proof series,' emphasizing its protective capabilities."
//
// That is an image caption, not a product description. It describes the
// blister pack, hedges like an observer, and reproduces a literal
// translation of Chinese packaging copy — while never telling the buyer
// they can lock a bike in seconds without carrying a key.
describe("buyer-focus rule", () => {
  it("is attached to every block that writes narrative copy", () => {
    for (const block of [buildDescriptionAndHighlightsStyleBlock(), buildDescriptionStyleBlock()]) {
      expect(block).toContain("WRITE TO THE BUYER");
    }
  });

  it("bans the exact constructions that produced that copy", () => {
    const block = buildDescriptionAndHighlightsStyleBlock();
    for (const banned of ["the packaging highlights", "the logo indicates", "the branding suggests", "appears to be"]) {
      expect(block).toContain(banned);
    }
  });

  it("forbids reproducing packaging slogans, and says why", () => {
    const block = buildDescriptionAndHighlightsStyleBlock();
    expect(block).toMatch(/never quote a slogan/i);
    expect(block).toMatch(/translate foreign marketing copy/i);
  });

  it("tells the model packaging text is a source of facts, not content", () => {
    expect(buildDescriptionAndHighlightsStyleBlock()).toMatch(/SOURCE of facts/i);
  });

  it("is NOT attached when only the title rule applies", () => {
    const titleOnly = buildStyleGuideBlock([{ label: "Name", type: "text" }]);
    expect(titleOnly).not.toContain("WRITE TO THE BUYER");
  });
});

describe("detectPhotoNarration", () => {
  it("catches the real sentences from that listing", () => {
    expect(detectPhotoNarration("The 'KAISHENG YOUPIN' logo indicates a focus on quality hardware tools."))
      .toContain("logo indicates");
    expect(detectPhotoNarration("The packaging also highlights 'Your car guard'."))
      .toEqual(expect.arrayContaining([expect.stringContaining("packaging also highlights")]));
    expect(detectPhotoNarration("The branding suggests a modern design.")).not.toHaveLength(0);
  });

  it("catches image-caption openers and observer hedging", () => {
    expect(detectPhotoNarration("The image shows a pink cable lock.")).not.toHaveLength(0);
    expect(detectPhotoNarration("Pictured here is the 4-digit dial.")).not.toHaveLength(0);
    expect(detectPhotoNarration("It appears to be made of steel.")).not.toHaveLength(0);
  });

  it("stays quiet on copy that actually sells the product", () => {
    // The rewrite this rule is meant to produce.
    const good =
      "<p>Lock your bike in seconds with a <strong>4-digit combination</strong> — no key to lose, " +
      "no fumbling at the rack. The flexible 1.2m steel cable threads through wheel spokes and " +
      "around railings, and the bright pink sleeve makes it easy to spot in a crowded stand.</p>";
    expect(detectPhotoNarration(good)).toEqual([]);
  });

  it("does not fire on innocent uses of the same words", () => {
    // "shows" and "indicates" are ordinary words; only the narration
    // constructions should match, or the signal is worthless.
    expect(detectPhotoNarration("The dial indicates which digits are set.")).toEqual([]);
    expect(detectPhotoNarration("A bright colour shows up well at night.")).toEqual([]);
  });

  it("handles empty input", () => {
    expect(detectPhotoNarration("")).toEqual([]);
    expect(detectPhotoNarration(null)).toEqual([]);
    expect(detectPhotoNarration(undefined)).toEqual([]);
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
