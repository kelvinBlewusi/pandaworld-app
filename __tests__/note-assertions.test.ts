import {
  extractNoteAssertions,
  checkAssertions,
  correctionsFrom,
} from "@/lib/whatsapp/note-assertions";

// Price, stock and sale price are already read from notes by regex and
// applied directly — seller-owned fields this codebase refuses to let an
// AI guess. Everything else the seller says was handed to the model as
// free text and never checked: if the seller wrote pink and the draft
// said red, nothing noticed. Prompting is a request; this is the
// verification.
describe("extractNoteAssertions", () => {
  it("reads a colour list the way a seller actually writes it", () => {
    const [a] = extractNoteAssertions("Nice bike lock, comes in red, blue and green. Price 120");
    expect(a.field).toBe("color");
    expect(a.values).toEqual(["Red", "Blue", "Green"]);
    expect(a.value).toBe("Red");
  });

  it("reads colours from a labelled list", () => {
    expect(extractNoteAssertions("colours: pink, black")[0].values).toEqual(["Pink", "Black"]);
    expect(extractNoteAssertions("Colors - Silver / Gold")[0].values).toEqual(["Silver", "Gold"]);
  });

  it("reads brand, material and model when explicitly labelled", () => {
    const found = extractNoteAssertions("brand: Kaisheng. material is steel. Model: KS-400");
    const byField = Object.fromEntries(found.map((f) => [f.field, f.value]));
    expect(byField.brand).toBe("Kaisheng");
    expect(byField.main_material).toBe("Steel");
    // Preserved verbatim: a model code's capitalisation carries meaning,
    // and normalising it would overrule the seller on the one thing this
    // module exists to preserve.
    expect(byField.model).toBe("KS-400");
  });

  it("reads 'made of' as a material statement", () => {
    expect(extractNoteAssertions("made of stainless steel")[0]).toMatchObject({
      field: "main_material", value: "Stainless Steel",
    });
  });

  // The precision half — a false assertion silently rewrites a seller's
  // listing, which is worse than missing one.
  it("does NOT treat a bare adjective in prose as a colour", () => {
    expect(extractNoteAssertions("this red lock is very strong")).toEqual([]);
    expect(extractNoteAssertions("a nice pink cable")).toEqual([]);
  });

  it("does not mistake 'available in stock' for a colour", () => {
    expect(extractNoteAssertions("available in stock now")).toEqual([]);
    expect(extractNoteAssertions("comes in bulk")).toEqual([]);
  });

  it("ignores vague quantifiers rather than asserting them", () => {
    expect(extractNoteAssertions("comes in various")).toEqual([]);
    expect(extractNoteAssertions("colours: assorted")).toEqual([]);
  });

  it("takes the first explicit statement when a field is stated twice", () => {
    const found = extractNoteAssertions("brand: Kaisheng, brand: Something Else");
    expect(found.filter((f) => f.field === "brand")).toHaveLength(1);
    expect(found[0].value).toBe("Kaisheng");
  });

  it("quotes the seller's own words back, for messages and logs", () => {
    expect(extractNoteAssertions("comes in red and blue")[0].source).toMatch(/comes in red and blue/i);
  });

  it("handles empty input", () => {
    for (const input of [null, undefined, "", "   "]) {
      expect(extractNoteAssertions(input)).toEqual([]);
    }
  });
});

describe("checkAssertions", () => {
  const stated = extractNoteAssertions("comes in pink and black. brand: Kaisheng");

  it("flags a draft that contradicts what the seller said", () => {
    // The exact failure this exists for: seller says pink, draft says red.
    const checks = checkAssertions(stated, { color: "Red", brand: "Kaisheng" });
    const colour = checks.find((c) => c.assertion.field === "color")!;
    expect(colour.honoured).toBe(false);
    expect(colour.actual).toBe("Red");
  });

  it("accepts a draft that agrees", () => {
    const checks = checkAssertions(stated, { color: "Pink", brand: "Kaisheng" });
    expect(checks.every((c) => c.honoured)).toBe(true);
  });

  it("accepts a MORE specific value rather than overwriting it", () => {
    // "material: steel" is satisfied by "Stainless Steel" — demanding
    // equality would replace a better value with a worse one.
    const material = extractNoteAssertions("material: steel");
    expect(checkAssertions(material, { main_material: "Stainless Steel" })[0].honoured).toBe(true);
  });

  it("counts any of several stated colours as honoured", () => {
    expect(checkAssertions(stated, { color: "Black", brand: "Kaisheng" })
      .find((c) => c.assertion.field === "color")!.honoured).toBe(true);
  });

  it("treats an empty draft field as not honoured", () => {
    const checks = checkAssertions(stated, { color: "", brand: null });
    expect(checks.every((c) => !c.honoured)).toBe(true);
  });
});

describe("correctionsFrom", () => {
  it("returns the seller's word for anything the draft got wrong", () => {
    const stated = extractNoteAssertions("comes in pink. brand: Kaisheng");
    const fixes = correctionsFrom(checkAssertions(stated, { color: "Red", brand: "Generic" }));
    expect(fixes).toEqual({ color: "Pink", brand: "Kaisheng" });
  });

  it("returns nothing when the draft already agrees", () => {
    const stated = extractNoteAssertions("comes in pink");
    expect(correctionsFrom(checkAssertions(stated, { color: "Pink" }))).toEqual({});
  });

  it("returns nothing when the seller asserted nothing", () => {
    expect(correctionsFrom(checkAssertions([], { color: "Red" }))).toEqual({});
  });
});
