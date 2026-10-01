/**
 * Reading a category the seller types for a draft: product number and
 * category name, from however they phrase it.
 */
import { parseCategoryInstruction } from "@/lib/whatsapp/category-question";
import { diverseTop } from "@/lib/jumia/category-search";

describe("parseCategoryInstruction", () => {
  it.each([
    ["Product one category is “Educational Tablets”", 1, "Educational Tablets"],
    ["1 category: Educational Tablets", 1, "Educational Tablets"],
    ["2 category Lotions", 2, "Lotions"],
    ["change the category of product 2 to Lotions", 2, "Lotions"],
    ["category for product 3 should be Malt Drinks", 3, "Malt Drinks"],
    ["the category is Phones & Tablets > Tablets > Educational Tablets", null, "Phones & Tablets > Tablets > Educational Tablets"],
    ["Category: Educational Tablets.", null, "Educational Tablets"],
  ])("%s", (text, seq, category) => {
    expect(parseCategoryInstruction(text)).toEqual({ seq, category });
  });

  it("ignores text that doesn't say category, or names none", () => {
    expect(parseCategoryInstruction("Educational Tablets")).toBeNull();
    expect(parseCategoryInstruction("2 change price to 150")).toBeNull();
    expect(parseCategoryInstruction("what category?")).toBeNull();
  });

  it("doesn't read a size as a product number", () => {
    expect(parseCategoryInstruction("4GB tablet category is Educational Tablets")).toEqual({ seq: null, category: "Educational Tablets" });
  });
});

describe("diverseTop", () => {
  const c = (path: string) => ({ path });
  const CASES   = c("Phones & Tablets > Tablet Accessories > Bags, Cases & Sleeves > Cases");
  const BAGS    = c("Phones & Tablets > Tablet Accessories > Bags, Cases & Sleeves > Bags");
  const SLEEVES = c("Phones & Tablets > Tablet Accessories > Bags, Cases & Sleeves > Sleeves");
  const EDU     = c("Phones & Tablets > Tablets > Educational Tablets");

  it("keeps a third sibling from crowding out another branch", () => {
    expect(diverseTop([CASES, BAGS, SLEEVES, EDU], 3)).toEqual([CASES, BAGS, EDU]);
  });

  it("falls back to siblings when nothing else is left", () => {
    expect(diverseTop([CASES, BAGS, SLEEVES], 3)).toEqual([CASES, BAGS, SLEEVES]);
    expect(diverseTop([EDU], 3)).toEqual([EDU]);
  });
});
