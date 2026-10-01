/**
 * A category the seller names in their notes is used when drafting (see
 * lib/jumia/stated-category.ts). Live, 2026-10-01: two wigs captioned
 * "Category is wigs" were drafted under Hair Extensions and Fascinators.
 */

const CATALOGUE = [
  "Health & Beauty > Personal Care > Hair Care > Extensions, Wigs & Accessories > Wigs",
  "Health & Beauty > Personal Care > Hair Care > Extensions, Wigs & Accessories > Hair Extensions",
  "Health & Beauty > Personal Care > Hair Care > Extensions, Wigs & Accessories > Wig Caps",
  "Fashion > Women's Fashion > Costumes & Accessories > Women > Wigs",
  "Fashion > Costumes & Accessories > Kids & Baby > Girls > Wigs",
  "Toys & Games > Dress Up & Pretend Play > Wigs",
  "Health & Beauty > Personal Care > Skin Care > Body > Cleansers > Body Washes",
  "Home & Office > Arts, Crafts & Sewing > Crafting > Craft Supplies > Wiggle Eyes",
].map((path, i) => ({
  code: 1000 + i, path, name: path.split(" > ").pop()!,
  parent_code: null, level: 5, is_leaf: true, attribute_set_sid: `sid-${i}`, attribute_set_name: null,
}));

let refused = new Set<number>();
jest.mock("@/lib/jumia/categories", () => ({
  getListableCategories: async () => CATALOGUE,
}));
jest.mock("@/lib/jumia/unlistable-categories", () => ({
  sellerCountry:        async () => "GH",
  blockedCategoryCodes: async () => new Set(refused),
}));

import { resolveStatedCategory, statedCategoryText } from "@/lib/jumia/stated-category";

const code = (path: string) => CATALOGUE.find((c) => c.path === path)!.code;
const HAIR_WIGS = "Health & Beauty > Personal Care > Hair Care > Extensions, Wigs & Accessories > Wigs";

beforeEach(() => { refused = new Set(); });

describe("statedCategoryText", () => {
  it("reads the category from its own line of a caption", () => {
    expect(statedCategoryText("Price GHC 89\nCategory is wigs")).toBe("wigs");
    expect(statedCategoryText("category: Body Washes\nPrice 240")).toBe("Body Washes");
  });

  it("is null when the notes don't name a category", () => {
    expect(statedCategoryText("Brand is Palmolive\nPrice 240")).toBeNull();
    expect(statedCategoryText(null)).toBeNull();
  });
});

describe("resolveStatedCategory", () => {
  it("uses the one category that fits as the seller's", async () => {
    const stated = await resolveStatedCategory("user_1", "Price 240\nCategory is Body Washes", "Shower Cream");
    expect(stated).toEqual({ kind: "match", category: expect.objectContaining({ path: "Health & Beauty > Personal Care > Skin Care > Body > Cleansers > Body Washes" }) });
  });

  it("offers every Wigs category for the AI to choose from, never Hair Extensions", async () => {
    const stated = await resolveStatedCategory("user_1", "Price GHC 89\nCategory is wigs", "Curly Lace Front Wig - Human Hair");
    expect(stated?.kind).toBe("options");
    const codes = stated!.kind === "options" ? stated!.options.map((o) => o.code) : [];
    expect(codes).toContain(code(HAIR_WIGS));
    expect(codes).not.toContain(code("Health & Beauty > Personal Care > Hair Care > Extensions, Wigs & Accessories > Hair Extensions"));
    expect(codes).toHaveLength(4); // every category called Wigs
  });

  it("reads past a comma after the category", async () => {
    const stated = await resolveStatedCategory("user_1", "Category is wigs, 18 inch", "Wig");
    expect(stated?.kind).toBe("options");
  });

  it("leaves out a category Jumia refused for this seller", async () => {
    refused = new Set([code("Health & Beauty > Personal Care > Skin Care > Body > Cleansers > Body Washes")]);
    expect(await resolveStatedCategory("user_1", "Category is Body Washes", "Shower Cream")).toBeNull();
  });

  it("ignores a name that only loosely matches", async () => {
    expect(await resolveStatedCategory("user_1", "Category is wiggly things", "Toy")).toBeNull();
  });
});
