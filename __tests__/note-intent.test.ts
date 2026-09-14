import { verifyNoteIntent, buildNoteIntentPrompt } from "@/lib/whatsapp/note-intent";

/** The two live notes that motivated this. Between them they expressed
 *  nine intentions; the regex layer caught two. */
const LASER =
  "It costs 300Ghs Comes in 3 colors black, red and blue It has a sales price of 250 Starts and end date is 20th September to 30th September";
const STOVE = `this product is a single variant, it price is GHS3500
WHAT IS IN THE BOX IS “1x Gas Stove”`;

describe("verifyNoteIntent — the hallucination gate", () => {
  // This is the whole reason a model is allowed near a seller's price.
  // It may be flexible about PHRASING and has no latitude over FACTS.

  it("drops a value whose quote is not in the note", () => {
    const r = verifyNoteIntent(
      { selling_price: { value: 999, quote: "the price is 999" } },
      LASER,
    );
    expect(r.intent.selling_price).toBeUndefined();
    expect(r.rejected[0].reason).toContain("not in the note");
  });

  it("drops a value with no quote at all", () => {
    const r = verifyNoteIntent({ selling_price: { value: 300 } }, LASER);
    expect(r.intent.selling_price).toBeUndefined();
    expect(r.rejected[0].reason).toBe("no quote given");
  });

  it("drops a number that does not appear in its own quote", () => {
    // The subtle case: a real quote, a wrong number. "It costs 300Ghs"
    // is genuinely in the note — 3000 is not in it.
    const r = verifyNoteIntent(
      { selling_price: { value: 3000, quote: "It costs 300Ghs" } },
      LASER,
    );
    expect(r.intent.selling_price).toBeUndefined();
    expect(r.rejected[0].reason).toContain("does not appear");
  });

  it("keeps a number that IS in its quote", () => {
    const r = verifyNoteIntent(
      { selling_price: { value: 300, quote: "It costs 300Ghs" } },
      LASER,
    );
    expect(r.intent.selling_price).toEqual({ value: 300, quote: "It costs 300Ghs" });
  });

  it("reads through line breaks and smart quotes", () => {
    // Models reformat whitespace and curly quotes constantly and
    // harmlessly; that must not read as a failed quote.
    const r = verifyNoteIntent(
      { whats_in_the_box: { value: "1x Gas Stove", quote: 'WHAT IS IN THE BOX IS "1x Gas Stove"' } },
      STOVE,
    );
    expect(r.intent.whats_in_the_box?.value).toBe("1x Gas Stove");
  });

  it("ignores junk input entirely", () => {
    expect(verifyNoteIntent(null, LASER).intent).toEqual({});
    expect(verifyNoteIntent("nope", LASER).intent).toEqual({});
    expect(verifyNoteIntent([1, 2], LASER).intent).toEqual({});
    expect(verifyNoteIntent({ selling_price: { value: 300, quote: "x" } }, "").intent).toEqual({});
  });
});

describe("verifyNoteIntent — numbers", () => {
  it("rejects a non-number and a non-positive one", () => {
    const r = verifyNoteIntent(
      {
        selling_price: { value: "lots", quote: "It costs 300Ghs" },
        sale_price:    { value: -5, quote: "sales price of 250" },
      },
      LASER,
    );
    expect(r.intent.selling_price).toBeUndefined();
    expect(r.intent.sale_price).toBeUndefined();
  });

  it("accepts a number written as a string when it checks out", () => {
    const r = verifyNoteIntent(
      { sale_price: { value: "250", quote: "sales price of 250" } },
      LASER,
    );
    expect(r.intent.sale_price?.value).toBe(250);
  });

  it("rounds quantity but not price", () => {
    const note = "I have 4.6 of them at 99.95 each";
    const r = verifyNoteIntent(
      {
        quantity:      { value: 4.6,   quote: "I have 4.6 of them" },
        selling_price: { value: 99.95, quote: "at 99.95 each" },
      },
      note,
    );
    expect(r.intent.quantity?.value).toBe(5);
    expect(r.intent.selling_price?.value).toBe(99.95);
  });
});

describe("verifyNoteIntent — dates", () => {
  const note = "sale from 2026-09-20 to 2026-09-30, or maybe 2026-13-45";

  it("keeps a real ISO window", () => {
    const r = verifyNoteIntent(
      {
        sale_start_date: { value: "2026-09-20", quote: "from 2026-09-20" },
        sale_end_date:   { value: "2026-09-30", quote: "to 2026-09-30" },
      },
      note,
    );
    expect(r.intent.sale_start_date?.value).toBe("2026-09-20");
    expect(r.intent.sale_end_date?.value).toBe("2026-09-30");
  });

  it("rejects a date that is not real", () => {
    const r = verifyNoteIntent(
      { sale_end_date: { value: "2026-13-45", quote: "or maybe 2026-13-45" } },
      note,
    );
    expect(r.intent.sale_end_date).toBeUndefined();
    expect(r.rejected[0].reason).toContain("not a real");
  });

  it("drops BOTH ends of an inverted window", () => {
    // Same rule extractSalePrice already follows: there is no safe way to
    // guess which side is the typo, so neither is kept.
    const inverted = "sale from 2026-09-30 to 2025-12-31";
    const r = verifyNoteIntent(
      {
        sale_start_date: { value: "2026-09-30", quote: "from 2026-09-30" },
        sale_end_date:   { value: "2025-12-31", quote: "to 2025-12-31" },
      },
      inverted,
    );
    expect(r.intent.sale_start_date).toBeUndefined();
    expect(r.intent.sale_end_date).toBeUndefined();
    expect(r.rejected.some((x) => x.reason.includes("ends before it starts"))).toBe(true);
  });
});

describe("verifyNoteIntent — variants", () => {
  it("reads the colours out of an unpunctuated note", () => {
    // The regex layer turned this note into a colour called
    // "Blue It Has A Sales Price Of 250 Starts", because with no full
    // stops its capture ran to the end of the message.
    const r = verifyNoteIntent(
      { variants: { value: ["Black", "Red", "Blue"], quote: "Comes in 3 colors black, red and blue" } },
      LASER,
    );
    expect(r.intent.variants?.value).toEqual(["Black", "Red", "Blue"]);
  });

  it("drops only the labels that are not in the quote", () => {
    const r = verifyNoteIntent(
      { variants: { value: ["Black", "Red", "Blue", "Green"], quote: "Comes in 3 colors black, red and blue" } },
      LASER,
    );
    expect(r.intent.variants?.value).toEqual(["Black", "Red", "Blue"]);
    expect(r.rejected[0].reason).toContain("Green");
  });

  it("keeps an empty list — 'single variant' is a real statement", () => {
    const r = verifyNoteIntent(
      { variants: { value: [], quote: "this product is a single variant" } },
      STOVE,
    );
    expect(r.intent.variants?.value).toEqual([]);
  });

  it("drops the lot when the quote is invented", () => {
    const r = verifyNoteIntent(
      { variants: { value: ["Black"], quote: "available in black only" } },
      LASER,
    );
    expect(r.intent.variants).toBeUndefined();
  });
});

describe("verifyNoteIntent — free text", () => {
  it("rejects a value the model padded out", () => {
    // Lifting what the seller said is the job. Writing prose around it
    // is how "1x Gas Stove" becomes a marketing sentence.
    const r = verifyNoteIntent(
      {
        whats_in_the_box: {
          value: "1x Gas Stove, 1x user manual, 1x warranty card and a set of burner caps",
          quote: 'WHAT IS IN THE BOX IS "1x Gas Stove"',
        },
      },
      STOVE,
    );
    expect(r.intent.whats_in_the_box).toBeUndefined();
    expect(r.rejected[0].reason).toContain("longer than the note said");
  });

  it("keeps brand, colour, material and model when quoted", () => {
    const note = "brand is Kaisheng, model KS-400, made of stainless steel, colour pink";
    const r = verifyNoteIntent(
      {
        brand:         { value: "Kaisheng",        quote: "brand is Kaisheng" },
        model:         { value: "KS-400",          quote: "model KS-400" },
        main_material: { value: "stainless steel", quote: "made of stainless steel" },
        color:         { value: "pink",            quote: "colour pink" },
      },
      note,
    );
    expect(r.intent.brand?.value).toBe("Kaisheng");
    expect(r.intent.model?.value).toBe("KS-400");
    expect(r.intent.main_material?.value).toBe("stainless steel");
    expect(r.intent.color?.value).toBe("pink");
  });
});

describe("buildNoteIntentPrompt", () => {
  it("includes the note and forbids inferring from the product", () => {
    const p = buildNoteIntentPrompt(LASER, "2026-09-14");
    expect(p).toContain(LASER);
    expect(p).toContain("2026-09-14");
    // The pass is text-only so it cannot blend what a photo SHOWS with
    // what the seller SAID — the failure that put five photographed
    // colours onto a listing whose note restricted it.
    expect(p).toMatch(/cannot see the product/i);
    expect(p).toMatch(/VERBATIM/);
  });
});
