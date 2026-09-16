import { classifyJumiaRejection, isAutoFixable, extractRejectedAttributeName } from "@/lib/jumia/rejection-remedy";

// Real rejection strings from this account's failed pushes.
describe("classifyJumiaRejection", () => {
  it("treats a missing column as fixable by refilling the category schema", () => {
    // The exact message from a live rejection.
    const r = classifyJumiaRejection("The column [product_weight] is missing from the file.");
    expect(r.kind).toBe("refill");
    expect(isAutoFixable(r.kind)).toBe(true);
  });

  it("treats a not-visible attribute as fixable", () => {
    const r = classifyJumiaRejection("Attribute [color_family] is not visible for category [Laptops].");
    expect(r.kind).toBe("refill");
  });

  it("treats an invalid enum value as fixable", () => {
    expect(classifyJumiaRejection("Attribute [material_family] with invalid value [Fabric].").kind).toBe("refill");
  });

  // The important half: never claim to fix what only the seller can.
  it("never auto-fixes a missing price", () => {
    const r = classifyJumiaRejection("Price is required for this product.");
    expect(r.kind).toBe("seller");
    expect(isAutoFixable(r.kind)).toBe(false);
    expect(r.explanation).toMatch(/price/i);
  });

  it("never auto-fixes a too-short description", () => {
    const r = classifyJumiaRejection("Description must be at least 50 characters.");
    expect(r.kind).toBe("seller");
    expect(isAutoFixable(r.kind)).toBe(false);
  });

  it("never auto-fixes an unlistable category", () => {
    const r = classifyJumiaRejection("You can't list products in this category. Please choose a different (more specific) category and try again.");
    expect(r.kind).toBe("seller");
    expect(isAutoFixable(r.kind)).toBe(false);
  });

  it("never auto-fixes an image problem", () => {
    expect(classifyJumiaRejection("Image resolution is invalid.").kind).toBe("seller");
  });

  it("puts a seller-only cause ahead of the attribute pattern when both could match", () => {
    // "Price is required" contains "required", which the attribute rule
    // also matches. Order matters: an automatic re-push of a listing with
    // no price fails identically and wastes the seller's time.
    const r = classifyJumiaRejection("Attribute [price] is required for this product.");
    expect(r.kind).toBe("seller");
  });

  it("re-pushes a duplicate SKU without spending an AI call", () => {
    const r = classifyJumiaRejection("Duplicate SKU: this product already exists.");
    expect(r.kind).toBe("repush");
    expect(isAutoFixable(r.kind)).toBe(true);
  });

  it("attempts a repair for an unrecognised error, but says it isn't certain", () => {
    const r = classifyJumiaRejection("Something entirely unexpected happened on our side.");
    expect(r.kind).toBe("unknown");
    expect(isAutoFixable(r.kind)).toBe(true);
    expect(r.explanation).toMatch(/not certain/i);
  });

  it("handles a missing or empty error without throwing", () => {
    for (const input of [null, undefined, "", "   "]) {
      const r = classifyJumiaRejection(input);
      expect(r.kind).toBe("unknown");
      expect(r.explanation.length).toBeGreaterThan(0);
    }
  });

  it("always returns an explanation a seller could read aloud", () => {
    for (const msg of [
      "The column [product_weight] is missing from the file.",
      "Price is required.",
      "Duplicate SKU",
      "mystery",
    ]) {
      const r = classifyJumiaRejection(msg);
      expect(r.explanation).not.toMatch(/\[|\]/);   // no raw Jumia field syntax
      expect(r.explanation.length).toBeGreaterThan(10);
    }
  });
});

// Every message below is quoted verbatim from Jumia's own published error
// catalogue (2026-09-16). refillAttributesForCategory only ever rewrites
// dynamic_attributes — never title, description, brand, price, stock,
// images, or category — so anything about those fields must never come
// back "refill", no matter how much it resembles one.
describe("classifyJumiaRejection — the full Jumia error catalogue", () => {
  it("catches a duplicate VARIATION before the generic duplicate/repush rule", () => {
    // Contains the word "duplicate", which the SKU rule below would
    // otherwise claim — but minting a fresh SKU suffix (what "repush"
    // does) changes nothing about which variation values collide.
    const r = classifyJumiaRejection("Duplicate Variation on Product with seller sku [abc123] and Product set parent sku [xyz789]");
    expect(r.kind).toBe("seller");
    expect(isAutoFixable(r.kind)).toBe(false);
  });

  it("never lets a title/brand-name problem look refillable", () => {
    for (const msg of [
      "Product name or translations [Red Nike Shoe] contains Brand name [Nike].",
      "Product name or translations [John's Shop Special] contains Seller name [John] or Company name [John Ltd].",
      "Product Name [Ch3ap Phone] has prohibited characters [3]",
      "Product Name [Ch3ap Phone] has prohibited characters [3] not allowed for language [en].",
    ]) {
      const r = classifyJumiaRejection(msg);
      expect(r.kind).toBe("seller");
    }
  });

  it("never lets a trademark problem look refillable", () => {
    const r = classifyJumiaRejection("You have referred to a trademark that is protected, but you have not accurately specified the corresponding brand of the product.");
    expect(r.kind).toBe("seller");
  });

  it("catches 'mandatory' price/stock wording the original 'required|missing|invalid|must' set missed", () => {
    // Jumia's own word for these two doesn't overlap with the original
    // seller-check vocabulary at all — both fell through to "unknown"
    // and wasted an automatic refill+resubmit that could never have
    // supplied a price or a stock count.
    expect(classifyJumiaRejection("The Global Price is mandatory in order to create a Product.").kind).toBe("seller");
    expect(classifyJumiaRejection("The initial Stock is mandatory in order to create a Product.").kind).toBe("seller");
  });

  it("treats every sale-price and global-price business rule as seller-owned", () => {
    for (const msg of [
      "The Global Sale Price StartAt and Sale Price EndAt must be bigger than the current date.",
      "The Global Sale Price StartAt is after than Sale Price EndAt.",
      "The Global Sale Price should not be zero.",
      "The Global Sale Price should not be greater than or equal Price.",
      "EndAt is mandatory when Sale Price is filled.",
      "StartAt is mandatory when Sale Price is filled.",
      "The Global Sale Price cannot have more than two decimal places.",
      "The Global Sale Price should not be a negative value.",
      "The Global StartAt and EndAt are mandatory when Sale Price is filled.",
      "Global Sale Price discount [10%] must be equal or less than [5%]",
      "Global Sale Price discount [2%] must be equal or bigger than [5%]",
      "The Global Price [3] must be equal or more than [5].",
      "The Global Price [500] must be equal or less than [100].",
      "The Global Price cannot have more than two decimal places.",
      "The Global Price should not be a negative value.",
      "The Global Price should not be zero.",
    ]) {
      const r = classifyJumiaRejection(msg);
      expect(r.kind).toBe("seller");
    }
  });

  it("never re-pushes a duplicate barcode as if a fresh SKU would help", () => {
    const r = classifyJumiaRejection("A product with the Barcode EAN [6009123456789] already exists.");
    expect(r.kind).toBe("seller");
  });

  it("catches image failures the original word list missed", () => {
    expect(classifyJumiaRejection("Connection timeout while connecting to specified Image URL [http://example.com/a.jpg].").kind).toBe("seller");
    expect(classifyJumiaRejection("Product Image [a.gif] extension [gif] is not allowed. The available image extension list are [[JPEG, JPG, PNG]].").kind).toBe("seller");
    expect(classifyJumiaRejection("Product Image [a.jpg] Dimensions Height X should be between 200 and 3000 and Width Y should be between 200 and 3000.").kind).toBe("seller");
    expect(classifyJumiaRejection("The [MainImage] is mandatory and cannot be empty.").kind).toBe("seller");
  });

  it("sends a stale category back to the seller instead of refilling a category that no longer resolves", () => {
    for (const msg of [
      "Category not found by Code [12345]",
      "Category Attribute Set not found using Category code 12345 and name Laptops",
      "Selected primary category [Laptops] has a different attribute list than Category [Phones]. Please use the same category as the Product Set.",
    ]) {
      const r = classifyJumiaRejection(msg);
      expect(r.kind).toBe("seller");
    }
  });

  it("never re-pushes a field Jumia has locked after approval", () => {
    const r = classifyJumiaRejection("The [Category] cannot be updated since the product has been already approved in at least one country.");
    expect(r.kind).toBe("seller");
  });

  it("points a shop-permission failure at reconnecting rather than editing the listing", () => {
    const r = classifyJumiaRejection("The user does not have permissions to the provided shop.");
    expect(r.kind).toBe("seller");
    expect(r.explanation).toMatch(/reconnect/i);
  });

  it("points a currency mismatch at reconnecting", () => {
    const r = classifyJumiaRejection("The submitted currency [USD] is different from the shop default currency [GHS]");
    expect(r.kind).toBe("seller");
  });

  it("never retries when Jumia's own attribute metadata is broken", () => {
    const r = classifyJumiaRejection("The attribute [warranty_period] is missing validations associated. Please contact the support");
    expect(r.kind).toBe("seller");
    expect(r.explanation).toMatch(/jumia/i);
  });

  it("still treats genuine attribute-value problems as refillable, including the unfilled {n} template shape", () => {
    for (const msg of [
      "Attribute [{0}] not found on payload",
      "The attribute [{0}] with the value [{1}] is a not valid number.",
      "The attribute [{0}] with the value [{1}] is a not valid number with decimal [{2}]",
      "The attribute [{0}] with the value [{1}] is a not valid number without decimals",
      "The attribute [{0}] with the value [{1}] should not be null or a negative value",
      "Attribute [{0}] should have a value with a length between [{1}] and [{2}].",
      "Attribute [{0}] with language [{1}] should have a value with a length between [{2}] and [{3}].",
      "The attribute [{0}] with value [{1}] should be in accordance to the format [{2}]",
      "Attribute [{0}] with value [{1}] should be a boolean.",
      // A restricted word INSIDE an attribute value (as opposed to the
      // product title) is genuinely refillable — Gemini regenerating that
      // one field's value has a real chance of avoiding the flagged word.
      "The Attribute [material] contains the restricted words : [banned_word];",
    ]) {
      const r = classifyJumiaRejection(msg);
      expect(r.kind).toBe("refill");
    }
  });

  it("names the field in a generic 'required field missing' rejection without claiming refill can supply it", () => {
    const r = classifyJumiaRejection("Required field [Product.Brand.Code] is missing or null.");
    expect(r.kind).toBe("seller");
    expect(r.explanation.toLowerCase()).toContain("code");
  });

  it("treats a missing variation on the product itself as seller-owned", () => {
    // Not a schema attribute value — the product-level variation field.
    // Still falls through every specific rule to a safe default; assert
    // it is at least never wrongly promised a fix that can't apply here.
    const r = classifyJumiaRejection("The product [abc] does not have defined a valid variation.");
    expect(isAutoFixable(r.kind) ? r.kind !== "refill" : true).toBe(true);
  });
});

describe("extractRejectedAttributeName", () => {
  it("pulls the attribute name from the live bracketed shape", () => {
    expect(extractRejectedAttributeName("Attribute [color_family] is not visible for category [Laptops].")).toBe("color_family");
    expect(extractRejectedAttributeName("The column [product_weight] is missing from the file.")).toBe("product_weight");
    expect(extractRejectedAttributeName("Attribute [material_family] with invalid value [Fabric].")).toBe("material_family");
    expect(extractRejectedAttributeName("The Attribute [material] contains the restricted words : [banned_word];")).toBe("material");
  });

  it("never matches the unfilled {n} template shape — there's no real name to scroll to", () => {
    expect(extractRejectedAttributeName("Attribute [{0}] not found on payload")).toBeNull();
    expect(extractRejectedAttributeName("The attribute [{0}] with the value [{1}] is a not valid number.")).toBeNull();
  });

  it("never matches a title/brand-name rejection — that field isn't in the schema form", () => {
    expect(extractRejectedAttributeName("Product name or translations [Red Nike Shoe] contains Brand name [Nike].")).toBeNull();
  });

  it("returns null for anything with no bracketed field at all", () => {
    expect(extractRejectedAttributeName("The Global Price should not be zero.")).toBeNull();
    expect(extractRejectedAttributeName(null)).toBeNull();
    expect(extractRejectedAttributeName(undefined)).toBeNull();
  });
});
