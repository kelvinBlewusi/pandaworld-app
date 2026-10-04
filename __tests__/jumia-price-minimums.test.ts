/**
 * Jumia's lowest allowed price per country, learned from its rejections
 * (lib/jumia/price-minimums.ts). Live 2026-10-04: a product went to Jumia
 * at GHS 3 and came back "The Global Price [3] GHS must be equal or more
 * than [8.81] GHS."
 */

import { FakeDb } from "./helpers/fake-supabase";

const db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({
  createServerClient: () => db,
}));

import {
  priceMinimumFor,
  priceMinimumForUser,
  rememberPriceMinimum,
  isBelowMinimum,
  belowMinimumText,
  money,
  _resetPriceMinimumCache,
} from "@/lib/jumia/price-minimums";

const GH_REJECTION = "The Global Price [3] GHS must be equal or more than [8.81] GHS.";

beforeEach(() => {
  db.tables.jumia_price_minimums = [];
  db.tables.jumia_connections = [];
  _resetPriceMinimumCache();
});

describe("rememberPriceMinimum", () => {
  it("saves the minimum a rejection names, for the seller's country", async () => {
    await rememberPriceMinimum("GH", 1000639, GH_REJECTION);

    expect(db.tables.jumia_price_minimums).toHaveLength(1);
    expect(db.tables.jumia_price_minimums[0]).toMatchObject({
      country: "GH", currency: "GHS", min_price: 8.81, category_code: 1000639, last_error: GH_REJECTION,
    });
    _resetPriceMinimumCache();
    expect(await priceMinimumFor("GH")).toEqual({ min: 8.81, currency: "GHS" });
  });

  it("keeps one row per country, with the latest figure", async () => {
    await rememberPriceMinimum("NG", 1, "The Global Price [100] NGN must be equal or more than [500] NGN.");
    await rememberPriceMinimum("NG", 2, "The Global Price [200] NGN must be equal or more than [650] NGN.");

    expect(db.tables.jumia_price_minimums).toHaveLength(1);
    expect(db.tables.jumia_price_minimums[0]).toMatchObject({ country: "NG", min_price: 650, category_code: 2 });
    expect(await priceMinimumFor("NG")).toEqual({ min: 650, currency: "NGN" });
  });

  it("ignores a maximum, a sale price, and any other rejection", async () => {
    await rememberPriceMinimum("GH", 1, "The Global Price [90000] GHS must be equal or less than [50000] GHS.");
    await rememberPriceMinimum("GH", 1, "The Sale Price [3] GHS must be equal or more than [8.81] GHS.");
    await rememberPriceMinimum("GH", 1, "Image is blurry");
    await rememberPriceMinimum(null, 1, GH_REJECTION);

    expect(db.tables.jumia_price_minimums).toHaveLength(0);
  });
});

describe("priceMinimumForUser", () => {
  it("reads the minimum for the country the seller's shop is in", async () => {
    db.tables.jumia_connections = [{ user_id: "user_1", country: "GH" }];
    db.tables.jumia_price_minimums = [{ country: "GH", currency: "GHS", min_price: "8.81" }];

    expect(await priceMinimumForUser("user_1")).toEqual({ min: 8.81, currency: "GHS" });
  });

  it("is null for a country Jumia hasn't named one for yet, or no shop", async () => {
    db.tables.jumia_connections = [{ user_id: "user_1", country: "KE" }];
    db.tables.jumia_price_minimums = [{ country: "GH", currency: "GHS", min_price: 8.81 }];

    expect(await priceMinimumForUser("user_1")).toBeNull();
    expect(await priceMinimumForUser("user_2")).toBeNull();
    expect(await priceMinimumForUser(null)).toBeNull();
  });
});

describe("isBelowMinimum", () => {
  const GH = { min: 8.81, currency: "GHS" };

  it("is true only for a set price under the minimum", () => {
    expect(isBelowMinimum(3, GH)).toBe(true);
    expect(isBelowMinimum("8.80", GH)).toBe(true);
    expect(isBelowMinimum(8.81, GH)).toBe(false);
    expect(isBelowMinimum(150, GH)).toBe(false);
    // No price is its own question ("needs price"), not this one.
    expect(isBelowMinimum(null, GH)).toBe(false);
    expect(isBelowMinimum(0, GH)).toBe(false);
    expect(isBelowMinimum(3, null)).toBe(false);
  });
});

it("words the price and the minimum in the shop's currency", () => {
  expect(belowMinimumText(3, { min: 8.81, currency: "GHS" }))
    .toBe("the price (GHS 3) is below the lowest Jumia allows (GHS 8.81)");
  expect(money(8.81, null)).toBe("8.81");
});
