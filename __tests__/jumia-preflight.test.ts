import { preflightAttributes, snapToAllowed } from "@/lib/jumia/preflight";
import type { JumiaCategoryAttribute } from "@/lib/jumia/categories";

function attr(over: Partial<JumiaCategoryAttribute> & { name: string }): JumiaCategoryAttribute {
  return {
    label: over.name, type: "string", allowed_values: [], required: false,
    is_variant: false, min_length: null, max_length: null, ...over,
  };
}

describe("snapToAllowed", () => {
  const allowed = ["Metal", "Wood", "Textile"];

  it("returns the schema's own spelling for an exact or case near-miss", () => {
    // Jumia's comparison may be less forgiving than ours, and we know the
    // exact string it accepts — so send that one, not the seller's.
    expect(snapToAllowed("Metal", allowed)).toBe("Metal");
    expect(snapToAllowed("metal", allowed)).toBe("Metal");
    expect(snapToAllowed("  METAL  ", allowed)).toBe("Metal");
  });

  it("handles singular/plural drift in both directions", () => {
    expect(snapToAllowed("Hard Hat", ["Hard Hats"])).toBe("Hard Hats");
    expect(snapToAllowed("Hard Hats", ["Hard Hat"])).toBe("Hard Hat");
  });

  it("refuses to guess when a value isn't clearly one of them", () => {
    // "Fabric" is the real value that cost a whole feed. No allowed value
    // means it — inventing one would be worse than dropping it.
    expect(snapToAllowed("Fabric", allowed)).toBeNull();
    expect(snapToAllowed("", allowed)).toBeNull();
  });

  it("refuses to guess between two equally plausible matches", () => {
    // Picking one of two is how a listing ends up confidently wrong.
    expect(snapToAllowed("blue", ["Blue", "BLUE"])).toBeNull();
  });

  it("passes a value through when the field is free text", () => {
    expect(snapToAllowed("anything at all", [])).toBe("anything at all");
  });
});

describe("preflightAttributes", () => {
  const schema = [
    attr({ name: "material_family", label: "Material", allowed_values: ["Metal", "Wood"] }),
    attr({ name: "model", label: "Model" }),
    attr({ name: "warranty_duration", label: "Warranty", required: true }),
  ];

  it("drops an attribute the category does not declare", () => {
    // The live failure: "Attribute [color_family] is not visible for
    // category [Laptops]" — and Jumia threw away the whole feed for it.
    const r = preflightAttributes([{ name: "color_family", value: "Navy" }], schema);
    expect(r.attributes).toEqual([]);
    expect(r.notes[0]).toMatchObject({ attribute: "color_family", reason: "not_in_schema" });
  });

  it("snaps a near-miss enum instead of dropping it", () => {
    const r = preflightAttributes([{ name: "material_family", value: "metal" }], schema);
    expect(r.attributes).toEqual([{ name: "material_family", value: "Metal" }]);
    expect(r.notes.find((n) => n.reason === "snapped_enum")?.detail).toMatch(/corrected/);
  });

  it("drops an enum value with no plausible match, and says so", () => {
    const r = preflightAttributes([{ name: "material_family", value: "Fabric" }], schema);
    expect(r.attributes).toEqual([]);
    expect(r.notes.find((n) => n.reason === "invalid_enum")).toBeTruthy();
  });

  it("keeps only the valid picks of a multi-select", () => {
    const multi = [attr({ name: "colours", type: "multi", allowed_values: ["Red", "Blue"] })];
    const r = preflightAttributes([{ name: "colours", value: "red, Green, Blue" }], multi);
    expect(r.attributes[0].value).toBe("Red,Blue");
  });

  it("truncates an over-long value at a word boundary", () => {
    const capped = [attr({ name: "model", max_length: 20 })];
    const r = preflightAttributes([{ name: "model", value: "A very long model name indeed" }], capped);
    expect(r.attributes[0].value.length).toBeLessThanOrEqual(20);
    // Not cut mid-word — a broken word looks worse than a shorter value.
    expect(r.attributes[0].value).not.toMatch(/\s$/);
    expect(r.attributes[0].value.endsWith("mod")).toBe(false);
    expect(r.notes.find((n) => n.reason === "truncated")).toBeTruthy();
  });

  it("reports required-but-empty rather than inventing a value", () => {
    const r = preflightAttributes([{ name: "model", value: "X1" }], schema);
    expect(r.missingRequired.map((n) => n.attribute)).toEqual(["warranty_duration"]);
    expect(r.attributes.map((a) => a.name)).toEqual(["model"]);
  });

  it("changes NOTHING when the schema is empty", () => {
    // An empty schema means the fetch failed, not that the category
    // declares nothing. Being wrong about that must never cost the seller
    // attributes Jumia would have accepted.
    const payload = [{ name: "anything", value: "at all" }];
    const r = preflightAttributes(payload, []);
    expect(r.attributes).toEqual(payload);
    expect(r.notes).toEqual([]);
  });

  it("skips empty values without flagging them", () => {
    const r = preflightAttributes([{ name: "model", value: "   " }], schema);
    expect(r.attributes).toEqual([]);
    expect(r.notes.filter((n) => n.reason !== "missing_required")).toEqual([]);
  });

  it("would have prevented the real Laptops rejection", () => {
    // The actual payload shape that failed: a watch's attributes sent
    // against a Laptops schema that declares none of them.
    const laptops = [attr({ name: "ram", allowed_values: ["8 GB", "16 GB"] })];
    const r = preflightAttributes([
      { name: "color_family",    value: "Cream" },
      { name: "main_material",   value: "Leather" },
      { name: "graphics_memory", value: "2 GB" },
      { name: "ram",             value: "8 GB" },
    ], laptops);

    expect(r.attributes).toEqual([{ name: "ram", value: "8 GB" }]);
    expect(r.notes.filter((n) => n.reason === "not_in_schema")).toHaveLength(3);
  });
});

describe("preflightAttributes — carriedElsewhere", () => {
  // Jumia marks these required on effectively every category, and the
  // payload does send all three — as top-level product fields, not as
  // attributes. Counting them missing fired three false positives on
  // every single push, which is why the required list could only ever be
  // logged and never trusted to gate anything.
  const universal: JumiaCategoryAttribute[] = [
    attr({ name: "name",           label: "Name",        required: true }),
    attr({ name: "description",    label: "Product description", required: true }),
    attr({ name: "variation",      label: "Variation",   required: true, is_variant: true }),
    attr({ name: "product_weight", label: "Weight (kg)", required: true }),
  ];

  it("does not report a required attribute the product carries elsewhere", () => {
    const r = preflightAttributes([{ name: "product_weight", value: "1.3 kg" }], universal, {
      carriedElsewhere: ["name", "description", "variation"],
    });
    expect(r.missingRequired).toEqual([]);
  });

  it("still reports the one that is genuinely absent", () => {
    // The real rejection: "The column [product_weight] is missing from
    // the file" — Jumia throws away every product in the feed over it.
    const r = preflightAttributes([{ name: "model", value: "LEVELPRO3" }], universal, {
      carriedElsewhere: ["name", "description", "variation"],
    });
    expect(r.missingRequired.map((n) => n.attribute)).toEqual(["product_weight"]);
    expect(r.missingRequired[0].label).toBe("Weight (kg)");
  });

  it("matches carried names case-insensitively", () => {
    const r = preflightAttributes([{ name: "product_weight", value: "1.3 kg" }], universal, {
      carriedElsewhere: ["Name", "DESCRIPTION", "Variation"],
    });
    expect(r.missingRequired).toEqual([]);
  });

  it("reports everything required when nothing is declared carried", () => {
    // Default behaviour is unchanged for callers that don't opt in.
    const r = preflightAttributes([{ name: "product_weight", value: "1.3 kg" }], universal);
    expect(r.missingRequired.map((n) => n.attribute).sort())
      .toEqual(["description", "name", "variation"]);
  });

  it("treats a whitespace-only required value as missing", () => {
    const r = preflightAttributes([{ name: "product_weight", value: "   " }], universal, {
      carriedElsewhere: ["name", "description", "variation"],
    });
    expect(r.missingRequired.map((n) => n.attribute)).toEqual(["product_weight"]);
  });
});

describe("preflightAttributes — line breaks in long text", () => {
  // Confirmed live, side by side: our editor showed "What's in the box"
  // as three lines, Vendor Center showed it as one unbroken run. Jumia
  // renders the field as HTML, where a newline is only whitespace.
  const longText: JumiaCategoryAttribute[] = [
    attr({ name: "package_content", label: "What's in the box", type: "textarea" }),
    attr({ name: "model",           label: "Model",            type: "string" }),
  ];

  const BOX = "1x Gas Stove with Oven\n1x User manual\n1x Original packaging";

  it("turns newlines into <br> so Jumia keeps them", () => {
    const r = preflightAttributes([{ name: "package_content", value: BOX }], longText);
    expect(r.attributes[0].value)
      .toBe("1x Gas Stove with Oven<br>1x User manual<br>1x Original packaging");
    expect(r.notes.find((n) => n.reason === "line_breaks")).toBeTruthy();
  });

  it("handles \\r\\n as well as \\n", () => {
    const r = preflightAttributes([{ name: "package_content", value: "a\r\nb" }], longText);
    expect(r.attributes[0].value).toBe("a<br>b");
  });

  it("leaves a value that already carries markup alone", () => {
    // That came from the rich-text editor, where the breaks are real
    // <p>/<br> already — converting again would double-space it.
    const html = "<p>1x Gas Stove</p>\n<p>1x User manual</p>";
    const r = preflightAttributes([{ name: "package_content", value: html }], longText);
    expect(r.attributes[0].value).toBe(html);
    expect(r.notes.find((n) => n.reason === "line_breaks")).toBeUndefined();
  });

  it("does NOT touch a short-text field", () => {
    // Only long text is rendered as HTML by Jumia; a <br> in a plain
    // string field would be shown literally.
    const r = preflightAttributes([{ name: "model", value: "KS\n400" }], longText);
    expect(r.attributes[0].value).toBe("KS\n400");
  });

  it("leaves a single-line value untouched and unflagged", () => {
    const r = preflightAttributes([{ name: "package_content", value: "1x Gas Stove" }], longText);
    expect(r.attributes[0].value).toBe("1x Gas Stove");
    expect(r.notes).toEqual([]);
  });
});
