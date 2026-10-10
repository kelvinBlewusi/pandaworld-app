/**
 * Answers laid out for the Listing Assistant's page (owner, 2026-10-09: "our
 * presentation of results is bad ... tables if needed or graphics if
 * possible"): the blocks, how they're stored, and how a research answer is
 * laid out.
 */

import { productStatusCell, richBlocks, stockCell } from "@/lib/whatsapp/rich-blocks";
import { describeOutboundMessage } from "@/lib/whatsapp/message-log";
import { groupProducts, productsTable, researchLayout, type Block } from "@/lib/whatsapp/shop-research";
import type { ShopProduct } from "@/lib/jumia/shop";

const product = (o: Partial<ShopProduct>): ShopProduct => ({
  sid: "s1", setSid: null, sellerSku: "SKU-1", name: "Nasco Blender 1.5L", variation: null, brand: "Nasco", categoryCode: "1", createdAt: "2026-10-01 09:00:00",
  status: "ACTIVE", visible: true, qcStatus: "APPROVED", qcReason: null, price: 250, salePrice: null, saleStart: null, saleEnd: null, currency: "GHS",
  imageUrl: null, stock: 5, ...o,
});

describe("rich answers", () => {
  it("only blocks it can draw are kept from a stored message", () => {
    expect(richBlocks(null)).toBeNull();
    expect(richBlocks({ blocks: [] })).toBeNull();
    expect(richBlocks({ blocks: [{ kind: "script" }, { kind: "text", text: "Hi" }] })).toEqual([{ kind: "text", text: "Hi" }]);
  });

  it("statuses and stock are coloured", () => {
    expect(productStatusCell(product({}))).toEqual({ text: "On", tone: "good" });
    expect(productStatusCell(product({ stock: 0 }))).toEqual({ text: "Out of stock", tone: "bad" });
    expect(productStatusCell(product({ qcStatus: "REJECTED" }))).toEqual({ text: "Rejected", tone: "bad" });
    expect(productStatusCell(product({ status: "INACTIVE" }))).toEqual({ text: "Off", tone: "neutral" });
    expect(stockCell(0)).toEqual({ text: "0", tone: "bad" });
    expect(stockCell(2)).toEqual({ text: "2", tone: "warn" });
    expect(stockCell(40)).toEqual({ text: "40", tone: "neutral" });
  });

  it("the page's copy of a message keeps its blocks; WhatsApp's is the text", () => {
    const rich = { blocks: [{ kind: "heading", text: "🛍️ Your Jumia shop" }] };
    expect(describeOutboundMessage("web:user_1", { to: "web:user_1", type: "text", text: { body: "🛍️ Your Jumia shop: 3 products" }, rich }))
      .toMatchObject({ messageType: "text", bodyText: "🛍️ Your Jumia shop: 3 products", payload: { rich } });
    expect(describeOutboundMessage("233200000000", { to: "233200000000", type: "text", text: { body: "Hi" } })).not.toHaveProperty("payload");
  });

  it("products as a table: sizes with the name, sale price, coloured stock and state", () => {
    const groups = groupProducts([
      product({ sid: "a", setSid: "set", sellerSku: "G-M", name: "Satin Gown", variation: "M", stock: 0, price: 150 }),
      product({ sid: "b", setSid: "set", sellerSku: "G-L", name: "Satin Gown", variation: "L", stock: 2, price: 160 }),
      product({ sid: "c", sellerSku: "K-1", name: "Kettle", qcStatus: "REJECTED", stock: 9 }),
    ], "2026-10-09");
    const t = productsTable(groups, (n) => `GHS ${n}`, "Africa/Accra", new Date("2026-10-09T12:00:00Z"));
    expect(t.columns).toEqual(["Product", "Price", "Stock", "State", "Added"]);
    expect(t.rows[0]).toEqual(["Satin Gown (M, L)", "GHS 150–GHS 160", { text: "2", tone: "warn" }, { text: "On", tone: "good" }, "1 Oct"]);
    expect(t.rows[1][3]).toEqual({ text: "Rejected", tone: "bad" });
  });

  it("one read is its own table; several put the written answer first with the tables folded", () => {
    const table = { kind: "table" as const, columns: ["Product"], rows: [["Kettle"]] };
    const one: Block[] = [{ title: "Products, newest first: 1", lines: ["• Kettle"], rich: [table] }];
    expect(researchLayout(one, "Your newest is the kettle.", "", true)).toEqual([
      { kind: "heading", text: "Products, newest first: 1" }, table, { kind: "note", text: "Read from Jumia just now." },
    ]);
    const two: Block[] = [...one, { title: "Payouts", lines: ["Couldn't read this from Jumia just now (timeout)."], failed: true }];
    const laid = researchLayout(two, "The kettle is new; payouts didn't load.", "Say *more* for the next 30.", true);
    expect(laid[0]).toEqual({ kind: "text", text: "The kettle is new; payouts didn't load." });
    expect(laid[1]).toEqual({ ...table, title: "Products, newest first: 1", folded: true });
    expect(laid).toContainEqual({ kind: "note", text: "Payouts: Couldn't read this from Jumia just now (timeout).", tone: "warn" });
    expect(laid).toContainEqual({ kind: "text", text: "Say *more* for the next 30." });
  });
});
