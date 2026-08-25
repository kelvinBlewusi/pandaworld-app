import { buildStyleGuideBlock } from "@/lib/ai/content-style-rules";
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
});
