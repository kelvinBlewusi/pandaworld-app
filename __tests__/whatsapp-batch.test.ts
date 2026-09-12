import {
  parseProductCount,
  parseSubmitCommand,
  parseEditCommand,
  extractPrice,
  extractStock,
  whatsappListingsUrl,
  focusedEditorUrl,
} from "@/lib/whatsapp/batch";

describe("parseProductCount", () => {
  it("parses a plain number", () => {
    expect(parseProductCount("3")).toBe(3);
    expect(parseProductCount("  5  ")).toBe(5);
  });

  it("tolerates surrounding words", () => {
    expect(parseProductCount("3 products")).toBe(3);
  });

  it("rejects zero, negatives, and anything above the cap", () => {
    expect(parseProductCount("0")).toBeNull();
    expect(parseProductCount("-1")).toBeNull();
    expect(parseProductCount("21")).toBeNull();
  });

  it("returns null for non-numeric text", () => {
    expect(parseProductCount("a few")).toBeNull();
    expect(parseProductCount("")).toBeNull();
  });
});

describe("parseSubmitCommand", () => {
  it("treats bare 'submit' as submit-all", () => {
    expect(parseSubmitCommand("submit")).toEqual({ all: true });
    expect(parseSubmitCommand("Submit")).toEqual({ all: true });
    expect(parseSubmitCommand("submit all")).toEqual({ all: true });
  });

  it("extracts specific product numbers", () => {
    expect(parseSubmitCommand("submit 1 and 4")).toEqual({ all: false, seqs: [1, 4] });
    expect(parseSubmitCommand("submit 2, 3")).toEqual({ all: false, seqs: [2, 3] });
  });

  it("dedupes and sorts numbers", () => {
    expect(parseSubmitCommand("submit 3 1 3")).toEqual({ all: false, seqs: [1, 3] });
  });

  it("returns null for non-submit messages", () => {
    expect(parseSubmitCommand("2: change the price to 150")).toBeNull();
    expect(parseSubmitCommand("hello")).toBeNull();
  });
});

describe("parseEditCommand", () => {
  it("extracts a numbered edit", () => {
    expect(parseEditCommand("2: change the price to 150", 4)).toEqual({
      needsSeq: false, seq: 2, text: "change the price to 150",
    });
  });

  it("accepts 'product N -' and '#N:' forms", () => {
    expect(parseEditCommand("product 3 - make it size L", 4)).toEqual({
      needsSeq: false, seq: 3, text: "make it size L",
    });
    expect(parseEditCommand("#1: it's blue not black", 4)).toEqual({
      needsSeq: false, seq: 1, text: "it's blue not black",
    });
  });

  it("applies directly to product 1 with no number when the batch has one product", () => {
    expect(parseEditCommand("change the color to blue", 1)).toEqual({
      needsSeq: false, seq: 1, text: "change the color to blue",
    });
  });

  it("asks for a number when the batch has more than one product and none was given", () => {
    expect(parseEditCommand("change the color to blue", 3)).toEqual({
      needsSeq: true, text: "change the color to blue",
    });
  });

  it("returns null for a submit command or empty text", () => {
    expect(parseEditCommand("submit 2", 3)).toBeNull();
    expect(parseEditCommand("", 3)).toBeNull();
  });
});

describe("extractPrice", () => {
  it("parses an explicitly labeled price", () => {
    expect(extractPrice("price 150")).toBe(150);
    expect(extractPrice("price: GHS 150")).toBe(150);
    expect(extractPrice("Price=99.50")).toBe(99.5);
  });

  it("parses a currency-prefixed or cedis-suffixed number without a 'price' label", () => {
    expect(extractPrice("₵150")).toBe(150);
    expect(extractPrice("it's 150 cedis")).toBe(150);
  });

  it("returns null when no explicit price is stated", () => {
    expect(extractPrice("comes in 3 sizes")).toBeNull();
    expect(extractPrice("this is a pack of 6")).toBeNull();
  });
});

describe("extractStock", () => {
  it("parses labeled stock/qty/quantity", () => {
    expect(extractStock("stock 10")).toBe(10);
    expect(extractStock("qty: 5")).toBe(5);
    expect(extractStock("quantity=20")).toBe(20);
  });

  it("returns null when not explicitly labeled", () => {
    expect(extractStock("price 150")).toBeNull();
    expect(extractStock("3 sizes available")).toBeNull();
  });
});

describe("whatsappListingsUrl", () => {
  it("links to the whatsapp-listings page", () => {
    expect(whatsappListingsUrl()).toContain("/extension/whatsapp-listings");
  });

  it("includes the batch id as a query param when given", () => {
    expect(whatsappListingsUrl("batch-123")).toContain("batch=batch-123");
  });
});

describe("focusedEditorUrl", () => {
  it("links to the focused editor for a specific listing", () => {
    const url = focusedEditorUrl("listing-abc");
    expect(url).toContain("/extension/whatsapp-listings/listing-abc");
  });
});
