import { isJumiaHouseBrand } from "@/lib/ai/jumia-content-policy";

describe("isJumiaHouseBrand", () => {
  // Real jumia_brands catalog entries (code 1061295 "Jumia", plus the
  // house-label family "Jumia Mall", "Jumia Deals", "Jumia Book", ...) —
  // all genuinely valid, listable Jumia brand codes, which is exactly why
  // the AI picking one from a photo's Jumia watermark ships live unnoticed
  // instead of getting rejected.
  it("catches Jumia's own brand name, case-insensitively and trimmed", () => {
    expect(isJumiaHouseBrand("Jumia")).toBe(true);
    expect(isJumiaHouseBrand("jumia")).toBe(true);
    expect(isJumiaHouseBrand("  Jumia  ")).toBe(true);
  });

  it("catches Jumia house-label variants", () => {
    expect(isJumiaHouseBrand("Jumia Mall")).toBe(true);
    expect(isJumiaHouseBrand("Jumia Deals")).toBe(true);
    expect(isJumiaHouseBrand("jumia express")).toBe(true);
  });

  it("does not false-positive on a real brand that merely starts with the same letters", () => {
    expect(isJumiaHouseBrand("Jumiaphone")).toBe(false);
  });

  it("leaves a real product brand alone", () => {
    expect(isJumiaHouseBrand("Samsung")).toBe(false);
    expect(isJumiaHouseBrand("Generic")).toBe(false);
  });

  it("handles null/undefined/empty without throwing", () => {
    expect(isJumiaHouseBrand(null)).toBe(false);
    expect(isJumiaHouseBrand(undefined)).toBe(false);
    expect(isJumiaHouseBrand("")).toBe(false);
  });
});
