import { classifyJumiaRejection, isAutoFixable } from "@/lib/jumia/rejection-remedy";

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
