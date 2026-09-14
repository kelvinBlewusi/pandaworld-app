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
