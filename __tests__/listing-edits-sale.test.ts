/**
 * A sale set in chat reaches the product's variants (owner's test,
 * 2026-10-07): "Sale 100 from 20th October to 28th October" was saved on the
 * listing only, and the draft's editor, which shows each variant's own
 * sale, showed none.
 */

import { FakeDb } from "./helpers/fake-supabase";

const db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({ createServerClient: () => db }));

import { carrySaleToVariants, dropVariantSalesFrom } from "@/lib/whatsapp/listing-edits";

const SALE = { salePrice: 100, startDate: "2026-10-20", endDate: "2026-10-28" };
const variant = (id: string, sale: number | null, start: string | null = null, end: string | null = null) =>
  ({ id, listing_id: "l1", variation: id, sale_price: sale, sale_start_date: start, sale_end_date: end });
const sales = () => (db.tables.variants as Record<string, unknown>[]).map((v) => [v.id, v.sale_price, v.sale_start_date, v.sale_end_date]);

describe("carrySaleToVariants", () => {
  it("gives a variant with no sale the one set in chat", async () => {
    db.tables.variants = [variant("100ml", null)];
    expect(await carrySaleToVariants("l1", { sale_price: 100, sale_start_date: "2026-10-20", sale_end_date: "2026-10-28" }, SALE)).toBe(1);
    expect(sales()).toEqual([["100ml", 100, "2026-10-20", "2026-10-28"]]);
  });

  it("changes a sale all the variants share", async () => {
    db.tables.variants = [variant("S", 90, "2026-10-01", "2026-10-05"), variant("M", 90, "2026-10-01", "2026-10-05")];
    expect(await carrySaleToVariants("l1", {}, SALE)).toBe(2);
    expect(sales().map((s) => s[1])).toEqual([100, 100]);
  });

  it("keeps a variant's own different sale, and moves those that followed the listing's", async () => {
    db.tables.variants = [variant("S", 90, "2026-10-01", "2026-10-05"), variant("M", 70, "2026-11-01", "2026-11-05"), variant("L", null)];
    await carrySaleToVariants("l1", { sale_price: 90, sale_start_date: "2026-10-01", sale_end_date: "2026-10-05" }, SALE);
    expect(sales()).toEqual([
      ["S", 100, "2026-10-20", "2026-10-28"],
      ["M", 70, "2026-11-01", "2026-11-05"],
      ["L", 100, "2026-10-20", "2026-10-28"],
    ]);
  });
});

describe("dropVariantSalesFrom", () => {
  it("clears a sale at or above a new price, and keeps one below it", async () => {
    db.tables.variants = [variant("S", 120, "2026-10-01", "2026-10-05"), variant("M", 80, "2026-10-01", "2026-10-05")];
    await dropVariantSalesFrom("l1", 100);
    expect(sales()).toEqual([["S", null, null, null], ["M", 80, "2026-10-01", "2026-10-05"]]);
  });
});
