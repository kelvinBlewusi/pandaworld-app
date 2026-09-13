import {
  parseProductCount,
  parseSubmitCommand,
  parseEditCommand,
  extractPrice,
  extractStock,
  extractSalePrice,
  whatsappListingsUrl,
  focusedEditorUrl,
  buyCreditsUrl,
  COUNT_QUICK_PICKS,
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

describe("COUNT_QUICK_PICKS", () => {
  it("stays within WhatsApp's 3-button, 20-char-title limits", () => {
    expect(COUNT_QUICK_PICKS.length).toBeLessThanOrEqual(3);
    for (const button of COUNT_QUICK_PICKS) expect(button.title.length).toBeLessThanOrEqual(20);
  });

  it("every button id round-trips through parseProductCount to its own number", () => {
    // A button tap surfaces as plain text equal to its id (see
    // lib/whatsapp/message-content.ts's contentOf) — these ids must parse
    // back to the count the button claims to offer.
    COUNT_QUICK_PICKS.forEach((button, i) => {
      expect(parseProductCount(button.id)).toBe(i + 1);
    });
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
  it("extracts a numbered edit as explicit", () => {
    expect(parseEditCommand("2: change the price to 150", 4)).toEqual({
      needsSeq: false, seq: 2, text: "change the price to 150", explicit: true,
    });
  });

  it("accepts 'product N -' and '#N:' forms, both explicit", () => {
    expect(parseEditCommand("product 3 - make it size L", 4)).toEqual({
      needsSeq: false, seq: 3, text: "make it size L", explicit: true,
    });
    expect(parseEditCommand("#1: it's blue not black", 4)).toEqual({
      needsSeq: false, seq: 1, text: "it's blue not black", explicit: true,
    });
  });

  it("applies directly to product 1 with no number when the batch has one product, marked not explicit", () => {
    expect(parseEditCommand("change the color to blue", 1)).toEqual({
      needsSeq: false, seq: 1, text: "change the color to blue", explicit: false,
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

  it("treats a bare number with nothing else as the price — confirmed live failure", () => {
    expect(extractPrice("200")).toBe(200);
    expect(extractPrice("  99.50  ")).toBe(99.5);
  });

  it("parses a full-sentence 'is'/'was' phrasing — confirmed live failure", () => {
    // A seller typed "The variation is red\nThe price is 150\nDone" and was
    // told "still needs: price" despite stating it plainly — the old regex
    // only tolerated whitespace/':'/'=' between "price" and the number, not
    // the word "is" a natural sentence puts there.
    expect(extractPrice("The price is 150")).toBe(150);
    expect(extractPrice("the price was 99.50")).toBe(99.5);
    expect(extractPrice("Variation is red\nThe price is 150\nDone")).toBe(150);
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

  it("parses a full-sentence 'is'/'was' phrasing", () => {
    expect(extractStock("the stock is 10")).toBe(10);
    expect(extractStock("quantity was 20")).toBe(20);
  });
});

describe("extractSalePrice", () => {
  // Fixed "now" so year-inference in date parsing is deterministic.
  const now = new Date("2026-09-13T00:00:00Z");

  it("returns null when no sale price is stated", () => {
    expect(extractSalePrice("price 150", now)).toBeNull();
    expect(extractSalePrice("comes in 3 sizes", now)).toBeNull();
  });

  it("parses a bare sale price with no dates", () => {
    expect(extractSalePrice("sale price 120", now)).toEqual({ salePrice: 120 });
    expect(extractSalePrice("discount to 80", now)).toEqual({ salePrice: 80 });
  });

  it("does not treat the regular price as the sale price, or vice versa", () => {
    expect(extractPrice("price 150, sale price 100")).toBe(150);
    expect(extractSalePrice("price 150, sale price 100", now)).toEqual({ salePrice: 100 });
    // A message with ONLY a sale price must not leak into extractPrice.
    expect(extractPrice("sale price 100")).toBeNull();
  });

  it("does not misread a percentage discount as a flat sale price", () => {
    expect(extractSalePrice("discount 20% off", now)).toBeNull();
    expect(extractSalePrice("20% discount", now)).toBeNull();
  });

  it("parses an ISO date range", () => {
    expect(extractSalePrice("sale price 100 from 2026-09-20 to 2026-09-30", now)).toEqual({
      salePrice: 100,
      startDate: "2026-09-20",
      endDate:   "2026-09-30",
    });
  });

  it("parses 'day month' and 'month day' ranges, inferring the current year", () => {
    expect(extractSalePrice("sale price 100 from 20 September to 30 September", now)).toEqual({
      salePrice: 100,
      startDate: "2026-09-20",
      endDate:   "2026-09-30",
    });
    expect(extractSalePrice("sale price 100 from September 20 to September 30", now)).toEqual({
      salePrice: 100,
      startDate: "2026-09-20",
      endDate:   "2026-09-30",
    });
  });

  it("rolls a yearless date into next year when it's already in the past", () => {
    // "now" is 2026-09-13; "1 January" with no year would be in the past
    // this year, so it must mean next January, not a retroactive sale.
    expect(extractSalePrice("sale price 50 until 1 January", now)).toEqual({
      salePrice: 50,
      endDate:   "2027-01-01",
    });
  });

  it("honours an explicit year", () => {
    expect(extractSalePrice("sale price 100 until December 25, 2026", now)).toEqual({
      salePrice: 100,
      endDate:   "2026-12-25",
    });
  });

  it("keeps the sale price even when the date phrase doesn't parse", () => {
    expect(extractSalePrice("sale price 100 from next week to sometime later", now)).toEqual({
      salePrice: 100,
    });
  });

  it("supports 'until'/'till' with only an end date", () => {
    expect(extractSalePrice("sale price 90 until 2026-10-01", now)).toEqual({
      salePrice: 90,
      endDate:   "2026-10-01",
    });
  });

  it("drops both dates when the range is inverted (start after end) — confirmed live failure", () => {
    // A seller typed "30th September 2026 to 31 December 2025" — both
    // sides carry an explicit year, so neither rolls forward, and the
    // pairing is nonsensical (start is over a year after end). There's no
    // reliable way to guess which side is the typo, so both are dropped —
    // the sale price itself must still register.
    expect(
      extractSalePrice("sale price 150 from 30 September 2026 to 31 December 2025", now),
    ).toEqual({ salePrice: 150 });
  });

  it("keeps a valid range when start is genuinely before end", () => {
    expect(
      extractSalePrice("sale price 150 from 30 September 2025 to 31 December 2026", now),
    ).toEqual({ salePrice: 150, startDate: "2025-09-30", endDate: "2026-12-31" });
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

describe("buyCreditsUrl", () => {
  it("links to the extension dashboard", () => {
    expect(buyCreditsUrl()).toContain("/extension/dashboard");
  });
});
