import {
  parseNotes,
  buildMockProduct,
  mapProductToFields,
  type HarvestedField,
} from "@/lib/extension/fill";

describe("parseNotes", () => {
  it("returns empty for blank input", () => {
    expect(parseNotes("")).toEqual({ price: null, extraFeatures: [], raw: "" });
    expect(parseNotes(undefined)).toEqual({ price: null, extraFeatures: [], raw: "" });
  });

  it("extracts a labelled price", () => {
    expect(parseNotes("price 250, leather strap").price).toBe(250);
    expect(parseNotes("GHS 1,299.99").price).toBeCloseTo(1299.99);
    expect(parseNotes("sells for 80 cedis").price).toBe(80);
  });

  it("splits features and drops the price fragment", () => {
    const p = parseNotes("price 250, water resistant, leather strap");
    expect(p.extraFeatures).toEqual(["water resistant", "leather strap"]);
  });
});

describe("mapProductToFields — Watches POC", () => {
  const fields: HarvestedField[] = [
    { label: "Name", type: "text", required: true },
    { label: "Brand", type: "combobox", required: true, options: ["Casio", "Fossil", "Generic"] },
    { label: "Color family", type: "select", required: false, options: ["Black", "White", "Blue"] },
    { label: "Weight (kg)", type: "text", required: true },
    { label: "Product description", type: "richtext", required: true },
    { label: "Highlights", type: "richtext", required: true },
    { label: "What's in the box", type: "richtext", required: false },
    { label: "Product warranty", type: "richtext", required: false },
  ];

  it("fills every mappable field", () => {
    const product = buildMockProduct("water resistant, leather strap", "Watches");
    const { values } = mapProductToFields(product, fields, "water resistant, leather strap");

    expect(values["Name"]).toMatch(/Wristwatch/);
    expect(values["Weight (kg)"]).toBe("0.2");
    expect(values["Product description"]).toMatch(/^<p>/);
    expect(values["Highlights"]).toMatch(/^<ul><li>/);
    expect(values["What's in the box"]).toContain("1x Wristwatch");
    expect(values["Product warranty"]).toBe("N/A");
  });

  it("falls back to Generic brand and warns", () => {
    const product = buildMockProduct("", "Watches"); // brand null
    const { values, warnings } = mapProductToFields(product, fields, "");
    expect(values["Brand"]).toBe("Generic");
    expect(warnings.some((w) => /Generic/.test(w))).toBe(true);
  });

  it("snaps color family to an allowed option", () => {
    const product = { ...buildMockProduct("", "Watches"), color_family: "black" };
    const { values } = mapProductToFields(product, fields, "");
    expect(values["Color family"]).toBe("Black"); // exact-cased option
  });

  it("does not write price into any field, but warns to set it on Variants", () => {
    const product = buildMockProduct("price 250", "Watches");
    const { values, warnings } = mapProductToFields(product, fields, "price 250");
    expect(Object.values(values).some((v) => v.includes("250"))).toBe(false);
    expect(warnings.some((w) => /Variants/.test(w))).toBe(true);
  });

  it("highlights render as a real bulleted list", () => {
    const product = buildMockProduct("water resistant, leather strap, 30m depth", "Watches");
    const { values } = mapProductToFields(product, fields, "water resistant, leather strap, 30m depth");
    expect(values["Highlights"]).toBe(
      "<ul><li>water resistant</li><li>leather strap</li><li>30m depth</li></ul>",
    );
  });

  it("does not warn about seller-owned fields (Category, price, stock)", () => {
    const withSellerFields: HarvestedField[] = [
      ...fields,
      { label: "Category", type: "combobox", required: true },
      { label: "Stock", type: "text", required: true },
    ];
    const product = buildMockProduct("", "Watches");
    const { values, warnings } = mapProductToFields(product, withSellerFields, "");
    expect(values["Category"]).toBeUndefined();
    expect(values["Stock"]).toBeUndefined();
    expect(warnings.some((w) => /Category|Stock/.test(w))).toBe(false);
  });

  it("warns on an unmappable required field", () => {
    const extra: HarvestedField[] = [
      ...fields,
      { label: "Sport/activity", type: "text", required: true },
    ];
    const product = buildMockProduct("", "Watches");
    const { warnings } = mapProductToFields(product, extra, "");
    expect(warnings.some((w) => /Sport\/activity/.test(w))).toBe(true);
  });
});
