/**
 * The variation question's pieces (lib/whatsapp/variation-question.ts):
 * reading a seller's reply as the category's own stocked options.
 */
jest.mock("@/lib/supabase/server", () => ({ createServerClient: () => ({}) }));
jest.mock("@/lib/jumia/categories", () => ({ getCategoryAttributes: async () => [] }));

import { isVariationBlock, parseVariations, variationQuestion } from "@/lib/whatsapp/variation-question";

const OPTIONS = ["100ml", "105ml", "10ml", "12 Bottles", "12 Bottles(1 Carton)", "Large"];

describe("parseVariations", () => {
  it("takes one option, however it's spaced or cased", () => {
    expect(parseVariations(OPTIONS, "100 ML")).toEqual({ ok: true, values: ["100ml"] });
    expect(parseVariations(OPTIONS, "large")).toEqual({ ok: true, values: ["Large"] });
  });

  it("takes several, separated by commas, and, & or new lines, once each", () => {
    expect(parseVariations(OPTIONS, "10ml, 105ml and 10ml")).toEqual({ ok: true, values: ["10ml", "105ml"] });
    expect(parseVariations(OPTIONS, "100ml\n105ml & Large")).toEqual({ ok: true, values: ["100ml", "105ml", "Large"] });
  });

  it("tells an exact option from a longer one that starts the same", () => {
    expect(parseVariations(OPTIONS, "12 bottles")).toEqual({ ok: true, values: ["12 Bottles"] });
  });

  it("names what isn't an option", () => {
    expect(parseVariations(OPTIONS, "100ml, 200ml")).toEqual({ ok: false, unknown: ["200ml"] });
  });

  it("takes any text when the category has no list", () => {
    expect(parseVariations([], "Small, Medium")).toEqual({ ok: true, values: ["Small", "Medium"] });
  });
});

describe("isVariationBlock", () => {
  it("knows the reasons a variation stops a product", () => {
    expect(isVariationBlock("This category needs a variation picked from its own stocked options (100ml, 105ml)")).toBe(true);
    expect(isVariationBlock(`Variation "Navy Blue" isn't one of this category's stocked options (Blue, Black)`)).toBe(true);
    expect(isVariationBlock("Variant 2 has no Variation label — type one before submitting.")).toBe(true);
    expect(isVariationBlock("price is required")).toBe(false);
  });
});

describe("variationQuestion", () => {
  it("names five options and how many more", () => {
    const many = Array.from({ length: 58 }, (_, i) => `${i + 1}ml`);
    expect(variationQuestion("Vintage Radio Eau de Parfum", many)).toBe(
      "*Vintage Radio Eau de Parfum*\n*What variation(s) do you have?* Reply with one or more of the stocked options (1ml, 2ml, 3ml, 4ml, 5ml and 53 more), or pick in the editor.",
    );
  });
});
