/**
 * The per-country calculators: Jumia's formula with each country's fee
 * model, checked against the worked examples Jumia publishes.
 */
import {
  COUNTRY_FEES,
  commissionOn,
  commissionSpan,
  itemFeeFor,
  listPriceFor,
  payoutAt,
} from "@/lib/marketing/country-fees";
import { JUMIA_COUNTRIES } from "@/lib/marketing/countries";

const cat = (code: keyof typeof COUNTRY_FEES, name: string) => {
  const c = COUNTRY_FEES[code].categories.find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} in ${code}`);
  return c;
};

describe("country fee tables", () => {
  it("has a table for every country page, with sane rates and no duplicate names", () => {
    for (const country of JUMIA_COUNTRIES) {
      const fees = COUNTRY_FEES[country.code];
      expect(fees.code).toBe(country.code);
      expect(fees.categories.length).toBeGreaterThan(20);
      const names = fees.categories.map((c) => c.name);
      expect(new Set(names).size).toBe(names.length);
      for (const c of fees.categories) {
        expect(c.commission).toBeGreaterThan(0);
        expect(c.commission).toBeLessThan(30);
        if (fees.itemFee.by === "category") expect(c.fee).toBeDefined();
      }
    }
  });

  it("matches Jumia Ghana's own example: GHC 950 at 20% with GHC 8 shipping lists at GHC 1198", () => {
    const gh = COUNTRY_FEES.GH;
    const fashion = cat("GH", "Fashion");
    expect(fashion.commission).toBe(20);
    expect(itemFeeFor(gh, fashion, "ds", null)).toBe(8);
    expect(listPriceFor(gh, 950, 8, 20, "ds", 1)).toBe(1198);
  });

  it("matches Jumia Côte d'Ivoire's own example: (15,000 + 500) ÷ (1 − 17%) = 18,675 FCFA", () => {
    expect(cat("CI", "Fashion").commission).toBe(17);
    expect(listPriceFor(COUNTRY_FEES.CI, 15000, 500, 17, "ds", 1)).toBe(18675);
  });

  it("prices Nigeria's shipping by item size, Extra small only from the table", () => {
    const ng = COUNTRY_FEES.NG;
    expect(itemFeeFor(ng, cat("NG", "Fashion"), "je", "xs")).toBe(400);
    expect(itemFeeFor(ng, cat("NG", "Fashion"), "ds", "large")).toBe(3800);
    expect(itemFeeFor(ng, cat("NG", "Fashion"), "ds", null)).toBeNull();
  });

  it("applies Egypt's 10 EGP minimum commission on drop-shipped items only", () => {
    const eg = COUNTRY_FEES.EG;
    // Jumia Egypt's example: a 50 EGP computer accessory from your own
    // warehouse pays the 10 EGP minimum, not 14% (7 EGP).
    expect(commissionOn(eg, 50, 14, "ds")).toBe(10);
    expect(commissionOn(eg, 50, 14, "je")).toBeCloseTo(7, 9);
    const list = listPriceFor(eg, 30, 15, 14, "ds", 0.01);
    expect(payoutAt(eg, list, 15, 14, "ds")).toBeGreaterThanOrEqual(30);
    expect(list).toBe(55);
    // Jumia Express offers the under-50 EGP rate; drop shipping doesn't.
    expect(itemFeeFor(eg, null, "je", "under50")).toBe(2);
    expect(itemFeeFor(eg, null, "ds", "under50")).toBeNull();
  });

  it("leaves the fee to the seller where Jumia publishes no table", () => {
    expect(itemFeeFor(COUNTRY_FEES.KE, cat("KE", "Mobile Phones"), "ds", null)).toBeNull();
    expect(itemFeeFor(COUNTRY_FEES.CI, cat("CI", "Fashion"), "je", null)).toBeNull();
  });

  it("listing at the calculated price pays the seller at least what they asked", () => {
    for (const country of JUMIA_COUNTRIES) {
      const fees = COUNTRY_FEES[country.code];
      const step = country.wholeUnits ? 1 : 0.01;
      for (const c of fees.categories) {
        const fee = itemFeeFor(fees, c, "ds", fees.itemFee.by === "size" ? fees.itemFee.sizes[1].id : null) ?? 0;
        const list = listPriceFor(fees, country.samplePrice, fee, c.commission, "ds", step);
        expect(payoutAt(fees, list, fee, c.commission, "ds")).toBeGreaterThanOrEqual(country.samplePrice - 1e-9);
      }
    }
  });

  it("states each country's commission span", () => {
    expect(commissionSpan(COUNTRY_FEES.NG)).toEqual({ min: 7, max: 22 });
    expect(commissionSpan(COUNTRY_FEES.EG)).toEqual({ min: 3.5, max: 17.1 });
  });
});
