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
jest.mock("@/lib/jumia/brands", () => ({
  findBrandExact: jest.fn(async () => null),
}));

import { resolveBrand } from "@/lib/jumia/api";

const FAKE_TOKEN = "fake-token";

const realFetch = global.fetch;
beforeEach(() => {
  global.fetch = jest.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch;
});
afterEach(() => {
  global.fetch = realFetch;
  jest.clearAllMocks();
});

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

describe("resolveBrand — unresolved brand name falls back to a clean generic pair", () => {
  // A real, previously-shipped bug: when a brand name couldn't be resolved
  // via the local cache or the live Jumia API (unrecognised, or restricted
  // for the category), resolveBrand used to return the fallback's CODE
  // paired with the ORIGINAL brand name text — e.g. {code: 1045133, name:
  // "SomeRestrictedBrand"} — instead of the fallback's own {code, name}
  // pair. Jumia's QC checks the brand name independently of the code, so
  // the restricted name going out unchanged meant a seller's "Fix &
  // resubmit" produced an identical rejection every time.
  it("returns the plain Generic pair, not {code: Generic, name: originalBrand}", async () => {
    const brand = await resolveBrand(FAKE_TOKEN, "SomeUnrecognisedBrand", "Phones & Tablets > Smartphones");
    expect(brand).toEqual({ code: 1045133, name: "Generic" });
  });

  it("returns the Fashion pair, not {code: Fashion, name: originalBrand}, for a Fashion category", async () => {
    const brand = await resolveBrand(FAKE_TOKEN, "SomeRestrictedBrand", "Fashion > Shoes > Men's Sneakers");
    expect(brand).toEqual({ code: 1039426, name: "Fashion" });
  });
});
