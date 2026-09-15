import {
  parseProductCount,
  readProductCount,
  parseSubmitCommand,
  parseEditCommand,
  extractPrice,
  extractStock,
  extractSalePrice,
  whatsappListingsUrl,
  focusedEditorUrl,
  buyCreditsUrl,
  COUNT_QUICK_PICKS,
  MAX_BATCH_SIZE,
} from "@/lib/whatsapp/batch";

// parseProductCount collapses every rejection to null, which made "50"
// and "a few" indistinguishable to the caller — so a seller who asked for
// 50 products was answered "⚠️ I need a number to get started". They had
// given one. The cap is real and worth stating plainly.
describe("readProductCount — says WHY a count was rejected", () => {
  it("accepts a valid count", () => {
    expect(readProductCount("3")).toEqual({ ok: true, count: 3 });
    expect(readProductCount(String(MAX_BATCH_SIZE))).toEqual({ ok: true, count: MAX_BATCH_SIZE });
  });

  it("distinguishes over-the-cap from gibberish, and reports the number asked for", () => {
    expect(readProductCount(String(MAX_BATCH_SIZE + 1))).toEqual({
      ok: false, reason: "too_many", value: MAX_BATCH_SIZE + 1,
    });
    expect(readProductCount("50")).toEqual({ ok: false, reason: "too_many", value: 50 });
    expect(readProductCount("a few")).toEqual({ ok: false, reason: "no_number" });
    expect(readProductCount("")).toEqual({ ok: false, reason: "no_number" });
  });

  it("distinguishes zero from gibberish", () => {
    expect(readProductCount("0")).toEqual({ ok: false, reason: "too_few", value: 0 });
  });

  it("still rejects negatives as 'no number', not as a count of -1", () => {
    expect(readProductCount("-1")).toEqual({ ok: false, reason: "no_number" });
  });

  it("agrees with parseProductCount on every outcome", () => {
    // The old entry point must keep its exact contract — it is what the
    // button-id round-trip and the existing tests rely on.
    for (const input of ["3", "0", "-1", "21", "50", "a few", "", "  5  ", "3 products"]) {
      const detailed = readProductCount(input);
      expect(parseProductCount(input)).toBe(detailed.ok ? detailed.count : null);
    }
  });
});

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

  it("accepts exactly the cap and rejects one past it", () => {
    // Pinned to the constant rather than a literal: the cap is a capacity
    // decision (see MAX_BATCH_SIZE's comment — concurrent analyses inside a
    // 60s webhook), so if it moves again this test should move with it
    // instead of quietly testing a boundary that no longer exists.
    expect(parseProductCount(String(MAX_BATCH_SIZE))).toBe(MAX_BATCH_SIZE);
    expect(parseProductCount(String(MAX_BATCH_SIZE + 1))).toBeNull();
  });

  it("every quick-pick button is a count the parser accepts", () => {
    for (const pick of COUNT_QUICK_PICKS) {
      expect(parseProductCount(pick.id)).toBe(Number(pick.id));
    }
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

  // Every one of these is a note a real seller actually sent on
  // 2026-09-15. All eight products stated a price; three of them were
  // still pushed to Jumia with "price is required", because the number
  // came BEFORE the currency or sat alone on its own line.
  it("reads the number before the currency — confirmed live failure", () => {
    expect(extractPrice("110 ghs sold in singles")).toBe(110);
    expect(extractPrice("46GHC")).toBe(46);
    expect(extractPrice("200 ₵")).toBe(200);
  });

  it("reads a number alone on its own line — confirmed live failure", () => {
    expect(extractPrice("210\nThe colors available are Blue and Red")).toBe(210);
    expect(extractPrice("Panasonic kettle, 1.7 litres\n200")).toBe(200);
  });

  // The guard that makes the line rule safe. A bare number is the most
  // ambiguous thing a seller can type, so two of them is a refusal, not a
  // coin flip: "42" here is a shoe size and "10" is stock.
  it("refuses to pick when more than one line is a bare number", () => {
    expect(extractPrice("Size\n42\nQuantity\n10")).toBeNull();
  });

  // Still extractSalePrice's territory — widening the shapes must not
  // widen what counts as the regular price.
  it("still leaves a lone sale price alone", () => {
    expect(extractPrice("Sale price is 150")).toBeNull();
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
    //
    // It now also carries a reason. Dropping the dates was always right;
    // doing it silently was not, because to the seller that is
    // indistinguishable from the line never having been read.
    const r = extractSalePrice("sale price 150 from 30 September 2026 to 31 December 2025", now);
    expect(r?.salePrice).toBe(150);
    expect(r?.startDate).toBeUndefined();
    expect(r?.endDate).toBeUndefined();
    expect(r?.dateWarning).toBeTruthy();
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

describe("extractSalePrice — the forms sellers actually type", () => {
  const NOW = new Date("2026-09-14T00:00:00Z");

  // Verbatim from a live note. It produced NOTHING: no sale price, no
  // dates. Three separate reasons, only one of which was intentional.
  const LIVE_NOTE = `Only black is red is available
The price is 200
I will do a promo so make the Sales price 150
Start and end date is 30th September 2026 to 31 December 2025`;

  it('reads "Sales price" — the plural cost a live listing its promo', () => {
    // The pattern required "sale price" exactly, so a single trailing "s"
    // meant the whole clause was invisible. sale_price landed as null and
    // the seller had to type 150 into the editor by hand.
    expect(extractSalePrice(LIVE_NOTE, NOW)?.salePrice).toBe(150);
  });

  it("reads the other ways a promo price gets written", () => {
    expect(extractSalePrice("sale price 150", NOW)?.salePrice).toBe(150);
    expect(extractSalePrice("promo price is 150", NOW)?.salePrice).toBe(150);
    expect(extractSalePrice("promotional price: 150", NOW)?.salePrice).toBe(150);
    expect(extractSalePrice("discounted price at 150", NOW)?.salePrice).toBe(150);
  });

  it('reads a range introduced by a label, not just by "from"', () => {
    // "Start and end date is X to Y" is how the label on the form reads
    // back to you; requiring "from" meant this produced no dates at all.
    const r = extractSalePrice(
      "Sale price 150. Start and end date is 30 September 2026 to 31 December 2026",
      NOW,
    );
    expect(r).toEqual({ salePrice: 150, startDate: "2026-09-30", endDate: "2026-12-31" });
  });

  it('still reads the "from ... to ..." form', () => {
    const r = extractSalePrice("sale price 100 from 20 September 2026 to 30 September 2026", NOW);
    expect(r?.startDate).toBe("2026-09-20");
    expect(r?.endDate).toBe("2026-09-30");
  });

  it("does not read a bare X-to-Y as a sale window", () => {
    // The lead-in has to stay anchored: unanchored, a size range or a
    // delivery estimate would silently become a promo window.
    const sizes = extractSalePrice("sale price 150. Available in sizes 4 to 8", NOW);
    expect(sizes?.startDate).toBeUndefined();
    expect(sizes?.endDate).toBeUndefined();
    const delivery = extractSalePrice("sale price 150. Takes 3 to 5 days", NOW);
    expect(delivery?.startDate).toBeUndefined();
  });

  it("refuses an inverted range and SAYS so", () => {
    // The live note's dates end a year before they start — a typo. The
    // refusal is right; the silence was not. A seller who states a promo
    // window and hears nothing cannot tell the difference between "we
    // read it and it was wrong" and "we never read it".
    const r = extractSalePrice(LIVE_NOTE, NOW);
    expect(r?.salePrice).toBe(150);
    expect(r?.startDate).toBeUndefined();
    expect(r?.endDate).toBeUndefined();
    expect(r?.dateWarning).toMatch(/ends before it starts/);
  });

  it("stays quiet when the dates are fine", () => {
    const r = extractSalePrice("sale price 150 from 1 October 2026 to 31 October 2026", NOW);
    expect(r?.dateWarning).toBeUndefined();
  });

  it("still ignores a percentage discount", () => {
    expect(extractSalePrice("discount 20% off everything", NOW)).toBeNull();
  });
});
