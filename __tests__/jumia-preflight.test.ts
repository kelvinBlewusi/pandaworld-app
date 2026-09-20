import { preflightAttributes, snapToAllowed, checkNumericConstraint } from "@/lib/jumia/preflight";
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

// Real values, read off category 1029710 (women's heels) on 2026-09-15,
// after "Fabric" reached Jumia twice and was dropped at push both times.
// snapToAllowed is what both the push path and the draft-time guard in
// lib/actions/auto-analyze.ts use, so these cases pin the behaviour for
// both at once.
describe("snapToAllowed against a real Jumia material_family list", () => {
  const MATERIAL_FAMILY = [
    "Canvas", "Cotton", "Denim", "Leather", "Linen", "Mesh", "Metal",
    "Nylon", "Other", "Polyester", "Rubber", "Satin", "Silk", "Suède",
    "Synthetic", "Textile", "Velvet", "Waterproof Fabric", "Wool",
  ];

  it('refuses "Fabric" rather than guessing at "Waterproof Fabric"', () => {
    // The whole incident. "Fabric" is not an accepted value and the two
    // nearest entries mean different things — snapping to either would be
    // inventing a material the seller never stated.
    expect(snapToAllowed("Fabric", MATERIAL_FAMILY)).toBeNull();
  });

  it("still repairs the drift it is meant to repair", () => {
    expect(snapToAllowed("textile", MATERIAL_FAMILY)).toBe("Textile");
    expect(snapToAllowed("  Leather  ", MATERIAL_FAMILY)).toBe("Leather");
    // Plural handling is a single trailing "s" only — "Canvases" does NOT
    // reduce to "Canvas", and deliberately so: anything cleverer starts
    // guessing at word stems.
    expect(snapToAllowed("Rubbers", MATERIAL_FAMILY)).toBe("Rubber");
    expect(snapToAllowed("Canvases", MATERIAL_FAMILY)).toBeNull();
  });

  it("prefers an exact spelling over a plural guess", () => {
    // "Silks" is itself an accepted value, so it is taken as written
    // rather than being reduced to "Silk".
    expect(snapToAllowed("silks", ["Silk", "Silks"])).toBe("Silks");
  });

  it("refuses when more than one value could be meant", () => {
    // Two entries that differ only by case leave nothing to choose
    // between, and a confidently wrong attribute is worse than an empty
    // one — the same rule the variant reconciler follows.
    expect(snapToAllowed("metal", ["Metal", "METAL"])).toBeNull();
  });
});

describe("preflightAttributes — decimalPlaces", () => {
  // Real rejection, 2026-09-19 batch: "Attribute [capacity_liter] with the
  // value [1.7] should be a number without decimals." A whole-number-only
  // field is a COUNT (a litre capacity, a piece count) — rounding 1.7 to 1
  // or 2 guesses at what's actually being sold, so it's blocked on the
  // very first attempt rather than silently rounded and sent.
  it("blocks (drops) a fractional value on the first attempt when decimalPlaces is 0 — never guesses a rounding", () => {
    const schema = [attr({ name: "capacity_liter", type: "number", decimal_places: 0 })];
    const result = preflightAttributes([{ name: "capacity_liter", value: "1.7" }], schema);
    expect(result.attributes.find((a) => a.name === "capacity_liter")).toBeUndefined();
    expect(result.notes[0].reason).toBe("decimal_mismatch_blocked");
  });

  it("surfaces the blocked attribute as missingRequired when the schema requires it", () => {
    const schema = [attr({ name: "capacity_liter", type: "number", decimal_places: 0, required: true })];
    const result = preflightAttributes([{ name: "capacity_liter", value: "1.7" }], schema);
    expect(result.missingRequired.map((n) => n.attribute)).toContain("capacity_liter");
  });

  it("only blocks decimal_places===0 — a fractional-but-allowed field still rounds (trimming precision, not changing the quantity)", () => {
    const schema = [attr({ name: "weight_kg", type: "number", decimal_places: 2 })];
    const result = preflightAttributes([{ name: "weight_kg", value: "1.2345" }], schema);
    expect(result.attributes[0].value).toBe("1.23");
    expect(result.notes[0].reason).toBe("rounded_number");
  });

  it("rounds to the schema's own decimal-place count, not always to an integer", () => {
    const schema = [attr({ name: "weight_kg", type: "number", decimal_places: 2 })];
    const result = preflightAttributes([{ name: "weight_kg", value: "1.2345" }], schema);
    expect(result.attributes[0].value).toBe("1.23");
  });

  it("leaves an already-compliant value untouched, with no note", () => {
    const schema = [attr({ name: "capacity_liter", type: "number", decimal_places: 0 })];
    const result = preflightAttributes([{ name: "capacity_liter", value: "5" }], schema);
    expect(result.attributes[0].value).toBe("5");
    expect(result.notes).toHaveLength(0);
  });

  it("does nothing when the schema doesn't constrain decimal places", () => {
    const schema = [attr({ name: "weight_kg", type: "number", decimal_places: null })];
    const result = preflightAttributes([{ name: "weight_kg", value: "1.23456" }], schema);
    expect(result.attributes[0].value).toBe("1.23456");
  });

  // Real rejection, recurred 2026-09-20 on a DIFFERENT listing in a
  // DIFFERENT category (1029495) than the 2026-09-19 one above — same
  // exact wire text, but that category's own synced schema has
  // decimal_places: null for capacity_liter (Jumia's schema is
  // inconsistent about this per category for the identical attribute
  // name). The schema-only check above had nothing to block on and shipped
  // "1.7" straight into the same rejection a second time — this is the
  // name-based hardening that closes that gap.
  it("blocks capacity_liter as whole-number-only even when THIS category's schema leaves decimal_places null", () => {
    const schema = [attr({ name: "capacity_liter", type: "number", decimal_places: null })];
    const result = preflightAttributes([{ name: "capacity_liter", value: "1.7" }], schema);
    expect(result.attributes.find((a) => a.name === "capacity_liter")).toBeUndefined();
    expect(result.notes[0].reason).toBe("decimal_mismatch_blocked");
  });

  it("leaves a non-numeric value on a number field alone — not this function's problem", () => {
    const schema = [attr({ name: "capacity_liter", type: "number", decimal_places: 0 })];
    const result = preflightAttributes([{ name: "capacity_liter", value: "about 1.7" }], schema);
    expect(result.attributes[0].value).toBe("about 1.7");
    expect(result.notes).toHaveLength(0);
  });

});

describe("preflightAttributes — notZeroOrNegative", () => {
  // "The attribute [x] with the value [y] should not be null or a
  // negative value." No safe repair exists — dropped, same rule
  // invalid_enum already follows.
  it("drops a zero value rather than guessing a replacement", () => {
    const schema = [attr({ name: "warranty_months", type: "number", not_zero_or_negative: true })];
    const result = preflightAttributes([{ name: "warranty_months", value: "0" }], schema);
    expect(result.attributes).toHaveLength(0);
    expect(result.notes[0].reason).toBe("invalid_number");
  });

  it("drops a negative value the same way", () => {
    const schema = [attr({ name: "warranty_months", type: "number", not_zero_or_negative: true })];
    const result = preflightAttributes([{ name: "warranty_months", value: "-3" }], schema);
    expect(result.attributes).toHaveLength(0);
  });

  it("surfaces as missing_required when the dropped field was required", () => {
    const schema = [attr({ name: "warranty_months", type: "number", not_zero_or_negative: true, required: true })];
    const result = preflightAttributes([{ name: "warranty_months", value: "-3" }], schema);
    expect(result.missingRequired).toHaveLength(1);
  });

  it("keeps a positive value with no note", () => {
    const schema = [attr({ name: "warranty_months", type: "number", not_zero_or_negative: true })];
    const result = preflightAttributes([{ name: "warranty_months", value: "12" }], schema);
    expect(result.attributes[0].value).toBe("12");
    expect(result.notes).toHaveLength(0);
  });

  it("checks the sign BEFORE rounding, so a negative fractional value is dropped, not rounded then dropped", () => {
    const schema = [attr({ name: "x", type: "number", not_zero_or_negative: true, decimal_places: 0 })];
    const result = preflightAttributes([{ name: "x", value: "-1.7" }], schema);
    expect(result.attributes).toHaveLength(0);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0].reason).toBe("invalid_number");
  });

  it("does nothing when the schema doesn't constrain the sign", () => {
    const schema = [attr({ name: "x", type: "number", not_zero_or_negative: false })];
    const result = preflightAttributes([{ name: "x", value: "-3" }], schema);
    expect(result.attributes[0].value).toBe("-3");
  });
});

describe("checkNumericConstraint", () => {
  // Extracted out of preflightAttributes so auto-analyze.ts can run the
  // identical rule at DRAFT time — the moment a category is known —
  // rather than only discovering a bad decimal after a push attempt.
  // Real, repeated rejection this exists to close: "Attribute
  // [capacity_liter] with the value [1.7] should be a number without
  // decimals."
  const capacityField = attr({ name: "capacity_liter", type: "number", decimal_places: 0 });

  it("blocks a fractional value on a whole-number-only field, same as preflightAttributes", () => {
    const result = checkNumericConstraint("1.7", capacityField);
    expect(result.value).toBeNull();
    expect(result.note?.reason).toBe("decimal_mismatch_blocked");
  });

  it("catches capacity_liter as whole-number-only even when the schema leaves decimal_places null", () => {
    const noDeclaredPlaces = attr({ name: "capacity_liter", type: "number", decimal_places: null });
    const result = checkNumericConstraint("1.7", noDeclaredPlaces);
    expect(result.value).toBeNull();
    expect(result.note?.reason).toBe("decimal_mismatch_blocked");
  });

  it("keeps a whole number on a whole-number-only field, unchanged and with no note", () => {
    const result = checkNumericConstraint("2", capacityField);
    expect(result).toEqual({ value: "2" });
  });

  it("rounds excess precision on a field with a non-zero decimal_places, rather than blocking it", () => {
    const twoDp = attr({ name: "price_extra", type: "number", decimal_places: 2 });
    const result = checkNumericConstraint("1.2345", twoDp);
    expect(result.value).toBe("1.23");
    expect(result.note?.reason).toBe("rounded_number");
  });

  it("drops a zero-or-negative value when the schema forbids it", () => {
    const positiveOnly = attr({ name: "weight", type: "number", not_zero_or_negative: true });
    expect(checkNumericConstraint("0", positiveOnly).value).toBeNull();
    expect(checkNumericConstraint("-5", positiveOnly).value).toBeNull();
    expect(checkNumericConstraint("0", positiveOnly).note?.reason).toBe("invalid_number");
  });

  it("leaves a non-numeric value alone — a different, pre-existing problem", () => {
    const result = checkNumericConstraint("true", capacityField);
    expect(result).toEqual({ value: "true" });
  });

  it("leaves an unconstrained number field's value unchanged", () => {
    const unconstrained = attr({ name: "x", type: "number" });
    expect(checkNumericConstraint("1.23456", unconstrained)).toEqual({ value: "1.23456" });
  });
});
