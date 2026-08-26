import {
  parseNotes,
  buildMockProduct,
  mapProductToFields,
  finalizeAiValues,
  isSellerOwned,
  isDegenerateName,
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

  it("extracts a price written as natural language ('price is 210')", () => {
    expect(parseNotes("the price is 210 and the quantity is 20").price).toBe(210);
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

  it("warns (with no Price field on the page) when a price is detected in notes but has nowhere to go", () => {
    const product = buildMockProduct("price 250", "Watches");
    const { values, warnings } = mapProductToFields(product, fields, "price 250");
    expect(Object.values(values).some((v) => v.includes("250"))).toBe(false);
    expect(warnings.some((w) => /no Price field was found/.test(w))).toBe(true);
  });

  it("fills a real Price field from notes as digits only, and warns to double-check it", () => {
    const withPrice: HarvestedField[] = [...fields, { label: "Price", type: "text", required: true }];
    const product = buildMockProduct("price 250", "Watches");
    const { values, warnings } = mapProductToFields(product, withPrice, "price 250");
    expect(values["Price"]).toBe("250");
    expect(warnings.some((w) => /Filled Price \(250\)/.test(w))).toBe(true);
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

describe("isSellerOwned", () => {
  it("flags seller-owned fields", () => {
    ["Sale Price", "Stock", "Category", "Country", "Currency"].forEach((l) =>
      expect(isSellerOwned(l)).toBe(true),
    );
  });
  it("does not flag AI/notes fields — Quantity, SKU, and base Price are all notes-fillable now", () => {
    ["Name", "Brand", "Product description", "Weight (kg)", "Quantity", "Seller SKU", "Price"].forEach((l) =>
      expect(isSellerOwned(l)).toBe(false),
    );
  });
  it("does not flag 'Country of origin' — exact 'Country' match only, so this legitimate product attribute stays AI-fillable", () => {
    expect(isSellerOwned("Country of origin")).toBe(false);
  });
});

describe("variant-qualified labels (multi-variant listings)", () => {
  it("still recognises a seller-owned field through the variant suffix", () => {
    expect(isSellerOwned("Sale Price (Variant 2)")).toBe(true);
    expect(isSellerOwned("Price (Variant 2)")).toBe(false);
    expect(isSellerOwned("Seller SKU (Variant 2)")).toBe(false);
  });

  it("fills every variant's Price from the notes, not just the first", () => {
    const fields: HarvestedField[] = [
      { label: "Price (Variant 1)", type: "text", variantIndex: 1 },
      { label: "Price (Variant 2)", type: "text", variantIndex: 2 },
    ];
    const { values } = finalizeAiValues({}, fields, "the price is 250");
    expect(values["Price (Variant 1)"]).toBe("250");
    expect(values["Price (Variant 2)"]).toBe("250");
  });

  it("keeps each variant's own distinct AI values", () => {
    const fields: HarvestedField[] = [
      { label: "Variation (Variant 1)", type: "text", variantIndex: 1 },
      { label: "Variation (Variant 2)", type: "text", variantIndex: 2 },
    ];
    const { values } = finalizeAiValues(
      { "Variation (Variant 1)": "Black", "Variation (Variant 2)": "Brown" },
      fields,
      "",
    );
    expect(values["Variation (Variant 1)"]).toBe("Black");
    expect(values["Variation (Variant 2)"]).toBe("Brown");
  });
});

describe("isDegenerateName", () => {
  it("flags a bare 'Generic' (any case) and anything under 15 non-space characters", () => {
    expect(isDegenerateName("Generic")).toBe(true);
    expect(isDegenerateName("generic")).toBe(true);
    expect(isDegenerateName("Watch")).toBe(true);
    expect(isDegenerateName("")).toBe(true);
  });
  it("flags 'generic' padded into a longer title to dodge the length check — confirmed happening live on the flash-lite model", () => {
    expect(isDegenerateName("Generic Product For This Item")).toBe(true);
    expect(isDegenerateName("Wholesale Pack of 30 Generic Award Medals")).toBe(true);
  });
  it("does not flag a real, specific title", () => {
    expect(isDegenerateName("Wholesale Pack of 30 Gold Award Medals with Ribbons")).toBe(false);
  });
});

describe("finalizeAiValues (real-AI post-processing)", () => {
  const fields: HarvestedField[] = [
    { label: "Name", type: "text" },
    { label: "Product description", type: "richtext" },
    { label: "Highlights", type: "richtext" },
    { label: "What's in the box", type: "richtext" },
    { label: "Watch Type", type: "select", options: ["Analog", "Digital", "Smart"] },
    { label: "Price", type: "text" },
    { label: "Warranty Type", type: "select", options: ["Repair by Vendor", "N/A", "None"] },
    { label: "Warranty Duration", type: "select", options: ["1 Year", "2 Years", "N/A", "None"] },
  ];

  it("wraps rich-text as HTML and bulletizes highlights", () => {
    const raw = {
      Name: "Casio Analog Watch",
      "Product description": "A dependable everyday watch.",
      Highlights: "Water resistant\nLeather strap",
    };
    const { values } = finalizeAiValues(raw, fields, "");
    expect(values["Name"]).toBe("Casio Analog Watch");
    expect(values["Product description"]).toBe("<p>A dependable everyday watch.</p>");
    expect(values["Highlights"]).toBe("<ul><li>Water resistant</li><li>Leather strap</li></ul>");
  });

  it("splits box contents onto separate lines even with no newlines from the AI", () => {
    const raw = { "What's in the box": "1x SLIN SF-G20 Chronograph Watch 1x User Manual 1x Packaging" };
    const { values } = finalizeAiValues(raw, fields, "");
    expect(values["What's in the box"]).toBe(
      "<p>1x SLIN SF-G20 Chronograph Watch<br>1x User Manual<br>1x Packaging</p>",
    );
  });

  it("keeps a newline-separated box list as-is (just wraps it)", () => {
    const raw = { "What's in the box": "1x Watch\n1x Manual" };
    const { values } = finalizeAiValues(raw, fields, "");
    expect(values["What's in the box"]).toBe("<p>1x Watch<br>1x Manual</p>");
  });

  it("keeps HTML the AI already returned", () => {
    const raw = { "Product description": "<p>Already <strong>html</strong>.</p>" };
    const { values } = finalizeAiValues(raw, fields, "");
    expect(values["Product description"]).toBe("<p>Already <strong>html</strong>.</p>");
  });

  it("snaps a select to an allowed option and drops invalid ones", () => {
    const ok = finalizeAiValues({ "Watch Type": "analog" }, fields, "");
    expect(ok.values["Watch Type"]).toBe("Analog");
    const bad = finalizeAiValues({ "Watch Type": "Sundial" }, fields, "");
    expect(bad.values["Watch Type"]).toBeUndefined();
    expect(bad.warnings.some((w) => /Watch Type/.test(w))).toBe(true);
  });

  it("leaves Price blank when notes give no price, even if the AI guessed one", () => {
    const { values } = finalizeAiValues({ Price: "250" }, fields, "");
    expect(values["Price"]).toBeUndefined();
  });

  it("fills Price deterministically from notes as digits only, ignoring whatever the AI itself returned", () => {
    const { values, warnings } = finalizeAiValues({ Price: "GHS 999 — wrong" }, fields, "the price is 250");
    expect(values["Price"]).toBe("250");
    expect(warnings.some((w) => /Filled Price \(250\)/.test(w))).toBe(true);
  });

  it("rejects a degenerate product name — confirmed happening live (the AI returned the Brand fallback word as the title)", () => {
    const generic = finalizeAiValues({ Name: "Generic" }, fields, "");
    expect(generic.values["Name"]).toBeUndefined();
    expect(generic.warnings.some((w) => /too generic/.test(w))).toBe(true);

    const tooShort = finalizeAiValues({ Name: "Watch" }, fields, "");
    expect(tooShort.values["Name"]).toBeUndefined();

    const real = finalizeAiValues({ Name: "Wholesale Pack of 30 Gold Award Medals with Ribbons" }, fields, "");
    expect(real.values["Name"]).toBe("Wholesale Pack of 30 Gold Award Medals with Ribbons");
  });

  it("rejects a Name that's actually another field's dropdown option — confirmed happening live on a fresh listing (Name came back \"Repair by Vendor\", a Warranty Type option)", () => {
    // A long-enough option that isDegenerateName's length check alone
    // would NOT catch, so this actually exercises the new cross-field
    // guard rather than the pre-existing "too short" one — "Repair by
    // Vendor" itself happens to be 14 non-space characters, just under
    // that guard's own threshold, which is why the live bug needed this
    // second check at all.
    const withWarranty: HarvestedField[] = [
      ...fields,
      { label: "Warranty Type", type: "select", options: ["Service Center - Greater Accra", "N/A", "None"] },
    ];
    const { values, warnings } = finalizeAiValues(
      { Name: "Service Center - Greater Accra" },
      withWarranty,
      "",
    );
    expect(values["Name"]).toBeUndefined();
    expect(warnings.some((w) => /meant for "Warranty Type"/.test(w))).toBe(true);

    // A real title merely SHARING a word with some option is fine — only an
    // exact whole-string match is rejected.
    const ok = finalizeAiValues(
      { Name: "Vendor-Grade Stainless Steel Repair Kit, 40-Piece" },
      withWarranty,
      "",
    );
    expect(ok.values["Name"]).toBe("Vendor-Grade Stainless Steel Repair Kit, 40-Piece");
  });

  it("keeps several values for a multi-select field (Color family accepts more than one)", () => {
    const multiFields: HarvestedField[] = [
      { label: "Color family", type: "combobox", multi: true, options: ["Black", "Brown", "Blue"] },
    ];
    const { values } = finalizeAiValues({ "Color family": "Black, Brown" }, multiFields, "");
    expect(values["Color family"]).toBe("Black, Brown");
  });

  it("keeps only the real options from a multi-value answer, and still drops one with no valid part", () => {
    const multiFields: HarvestedField[] = [
      { label: "Color family", type: "combobox", multi: true, options: ["Black", "Brown"] },
    ];
    expect(finalizeAiValues({ "Color family": "Black, Chartreuse" }, multiFields, "").values["Color family"]).toBe("Black");
    expect(finalizeAiValues({ "Color family": "Chartreuse, Puce" }, multiFields, "").values["Color family"]).toBeUndefined();
  });

  it("does not split a comma-containing answer on a single-select field", () => {
    const singleFields: HarvestedField[] = [
      { label: "Warranty Address", type: "combobox", options: ["Accra, Ghana", "Lagos"] },
    ];
    const { values } = finalizeAiValues({ "Warranty Address": "Accra, Ghana" }, singleFields, "");
    expect(values["Warranty Address"]).toBe("Accra, Ghana");
  });

  it("drops Warranty Duration when Warranty Type is N/A, even if the AI filled a duration in", () => {
    const { values } = finalizeAiValues(
      { "Warranty Type": "N/A", "Warranty Duration": "1 Year" },
      fields,
      "",
    );
    expect(values["Warranty Type"]).toBe("N/A");
    expect(values["Warranty Duration"]).toBeUndefined();
  });

  it("keeps Warranty Duration when Warranty Type is a real warranty", () => {
    const { values } = finalizeAiValues(
      { "Warranty Type": "Repair by Vendor", "Warranty Duration": "1 Year" },
      fields,
      "",
    );
    expect(values["Warranty Type"]).toBe("Repair by Vendor");
    expect(values["Warranty Duration"]).toBe("1 Year");
  });
});
