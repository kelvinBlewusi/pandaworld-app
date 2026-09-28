/**
 * Jumia's listing-price formula as the public calculators use it
 * (lib/marketing/jumia-fees.ts): rounded up to the currency's smallest
 * unit, and never a unit too high from floating-point noise.
 */

import { listingPriceFor } from "@/lib/marketing/jumia-fees";

describe("listingPriceFor", () => {
  it("matches Jumia Ghana's worked example", () => {
    expect(listingPriceFor(950, 6, 20)).toBe(1195);
  });

  it("matches Jumia Côte d'Ivoire's worked example, in whole FCFA", () => {
    expect(listingPriceFor(15000, 500, 17, 1)).toBe(18675);
  });

  it("rounds up to the next pesewa when the price isn't exact", () => {
    expect(listingPriceFor(100, 8, 7)).toBe(116.13); // 116.1290…
  });

  it("doesn't add a pesewa to a price that is exact", () => {
    // Each of these divides out exactly, but float division lands a hair
    // above: 900.0000000000001, 500.00000000000006, 1000.0000000000001.
    expect(listingPriceFor(337, 500, 7)).toBe(900);
    expect(listingPriceFor(345, 120, 7)).toBe(500);
    expect(listingPriceFor(430, 500, 7)).toBe(1000);
  });

  it("never differs from exact arithmetic across realistic prices", () => {
    for (let payout = 1; payout <= 800; payout++) {
      for (const pct of [6, 7, 9, 12, 15, 17, 20]) {
        for (const fee of [0, 6, 8, 120, 500]) {
          // Exact: work in hundredths with integer arithmetic.
          const numer = (payout + fee) * 100 * 100;
          const denom = 100 - pct;
          const exactHundredths = Math.ceil(numer / denom - 1e-9);
          expect(listingPriceFor(payout, fee, pct)).toBeCloseTo(exactHundredths / 100, 6);
        }
      }
    }
  });
});
