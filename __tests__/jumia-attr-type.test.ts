import { mapAttrType } from "@/lib/jumia/categories";

describe("mapAttrType — documented string codes", () => {
  it("maps every code Jumia's spec lists", () => {
    expect(mapAttrType("BOOLEAN", false)).toBe("boolean");
    expect(mapAttrType("DATE", false)).toBe("date");
    expect(mapAttrType("DATE_TIME", false)).toBe("datetime");
    expect(mapAttrType("NUMBER", false)).toBe("number");
    expect(mapAttrType("MULTI_SELECTION", false)).toBe("multi");
    expect(mapAttrType("SELECTION", false)).toBe("enum");
    expect(mapAttrType("TEXT_AREA", false)).toBe("textarea");
    expect(mapAttrType("TEXT", false)).toBe("string");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(mapAttrType("  text_area  ", false)).toBe("textarea");
  });
});

describe("mapAttrType — legacy numeric codes", () => {
  // These were mis-mapped for the life of the cache. The corrections are
  // read off the live data, not off the spec — the spec comment in this
  // file said 1=number, 2=boolean, and the cache proves both wrong.

  it("maps code 2 to number, not boolean", () => {
    // Every one of the 19 names that landed in the old "boolean" bucket
    // is a quantity — capacity_liter, cpu_cores, voltage, pages. Jumia
    // said so itself: "Attribute [capacity_liter] with the value [0.35]
    // should be a number without decimals."
    expect(mapAttrType(2, false)).toBe("number");
    expect(mapAttrType("2", false)).toBe("number");
  });

  it("maps code 1 to textarea, not number", () => {
    // The old "number" bucket was description, short_description,
    // package_content, product_warranty, warranty_address — 594
    // categories each, all long free text. A number input for a product
    // description is nonsense that only survived because a name-based
    // override in SchemaField was quietly papering over it.
    expect(mapAttrType(1, false)).toBe("textarea");
  });

  it("keeps code 5 with code 1 until something distinguishes them", () => {
    expect(mapAttrType(5, false)).toBe("textarea");
  });

  it("still maps the select codes", () => {
    expect(mapAttrType(3, false)).toBe("multi");
    expect(mapAttrType(4, false)).toBe("enum");
  });

  it("never produces boolean from a numeric code", () => {
    // Nothing in the live cache is genuinely boolean. A real one arrives
    // as the string "BOOLEAN", handled above.
    for (const code of [0, 1, 2, 3, 4, 5, 6, 99]) {
      expect(mapAttrType(code, false)).not.toBe("boolean");
    }
  });

  it("falls back to enum when a code is unknown but options exist", () => {
    expect(mapAttrType(99, true)).toBe("enum");
  });

  it("falls back to string for an unknown code with no options", () => {
    expect(mapAttrType(99, false)).toBe("string");
    expect(mapAttrType(null, false)).toBe("string");
    expect(mapAttrType(undefined, false)).toBe("string");
  });
});
