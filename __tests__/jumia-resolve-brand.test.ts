/**
 * resolveBrand's fashion-aware fallback (fix 1).
 *
 * BRAND_GENERIC_FASHION (code 1039426) existed in lib/jumia/api.ts and was
 * never referenced — every unresolved brand fell back to plain "Generic"
 * (code 1045133), including shoes, bags, watches and jewelry, which Jumia
 * rejects on Fashion categories ("Product category doesn't allow Generic
 * brand"). Only the no-brand-name branch is exercised here: it's the one
 * path that needs neither the DB brand cache nor a live Jumia API call, so
 * it's testable with no mocking at all.
 */
import { resolveBrand } from "@/lib/jumia/api";

const FAKE_TOKEN = "fake-token";

describe("resolveBrand — fashion-aware generic fallback", () => {
  it("falls back to plain Generic (1045133) for a non-fashion category", async () => {
    const brand = await resolveBrand(FAKE_TOKEN, null, "Phones & Tablets > Smartphones");
    expect(brand).toEqual({ code: 1045133, name: "Generic" });
  });

  it("falls back to Fashion (1039426) for a Fashion category", async () => {
    const brand = await resolveBrand(FAKE_TOKEN, null, "Fashion > Shoes > Men's Sneakers");
    expect(brand).toEqual({ code: 1039426, name: "Fashion" });
  });

  it.each([
    "Fashion > Women's Clothing",
    "Bags, Wallets & Belts",
    "Watches & Jewelry",
    "Eyewear > Sunglasses",
  ])("recognises %p as a Fashion category", async (categoryPath) => {
    const brand = await resolveBrand(FAKE_TOKEN, null, categoryPath);
    expect(brand.code).toBe(1039426);
  });

  it("falls back to plain Generic when no category hint is given at all", async () => {
    const brand = await resolveBrand(FAKE_TOKEN, null, null);
    expect(brand).toEqual({ code: 1045133, name: "Generic" });
  });
});
