/**
 * More of the Jumia API in chat (owner, 2026-10-07: "do all"): rules for many
 * products, a live product's content, reports from orders, payouts in
 * detail, brands, the shops under the account and Jumia's warehouse. Jumia's
 * answers follow the shapes in its spec (vendorcenter.jumia.com/api-docs).
 */

import { FakeDb } from "./helpers/fake-supabase";

let db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({ createServerClient: () => db }));
jest.mock("@/lib/jumia/oauth", () => ({ JUMIA_API_BASE: "https://vendor-api.jumia.com" }));
jest.mock("@/lib/jumia/api", () => ({
  COUNTRY_CURRENCY: { GH: "GHS", NG: "NGN" },
  getValidJumiaCredentials: async () => ({ accessToken: "tok", shopId: "shop-1", currency: "GHS", country: "GH" }),
  getFeedStatus: async () => null,
}));
jest.mock("@/lib/jumia/credentials", () => ({ getJumiaConnectionKind: async () => "connected" }));
jest.mock("@/lib/whatsapp/jumia-connect", () => ({ promptJumiaConnection: jest.fn() }));
jest.mock("@/lib/billing/features", () => ({
  hasFeature: async () => true,
  featureAccess: async () => ({ ok: true }),
  featureMinPackName: () => "Pro",
}));
let rewritten = "{}";
jest.mock("@/lib/ai/gemini-client", () => ({ callGeminiBackend: async () => ({ text: rewritten }) }));

type Sent = { kind: string; body: string; ids?: string[] };
const sent: Sent[] = [];
jest.mock("@/lib/whatsapp/client", () => ({
  LIST_MAX_ROWS: 10,
  sendTextIfConfigured: async (_to: string, body: string) => { sent.push({ kind: "text", body }); },
  sendButtonsIfConfigured: async (_to: string, body: string, b: { id: string }[]) => { sent.push({ kind: "buttons", body, ids: b.map((x) => x.id) }); },
  sendListIfConfigured: async (_to: string, body: string) => { sent.push({ kind: "list", body }); },
  sendCtaUrlIfConfigured: async (_to: string, body: string) => { sent.push({ kind: "cta", body }); },
  sendButtonsWithDocumentIfConfigured: async () => {},
  sendTemplateIfConfigured: async () => {},
}));

import { changedPrice, contentItems, pctPrice, productsFromCatalog, type ShopProduct } from "@/lib/jumia/shop";
import { bulkTargets, handleShopTap, htmlToText, proposeBulkChange, proposeContentChange } from "@/lib/whatsapp/shop";
import {
  answerBrand, answerLinkedShops, answerPayoutDetail, answerReport, answerWarehouseStock, daysLeft, handleWarehouseTap, proposeWarehouseOrder,
  proposeWarehouseShipped, salesByProduct, statementLines,
} from "@/lib/whatsapp/shop-insights";
import { _resetPriceMinimumCache } from "@/lib/jumia/price-minimums";
import { _resetBillingModeCache } from "@/lib/billing/mode";

const USER = "seller";
const PHONE = "web:seller";
const PERFUME_50 = "aaaaaaaa-0000-4000-8000-000000000001";
const PERFUME_100 = "aaaaaaaa-0000-4000-8000-000000000002";
const KETTLE = "bbbbbbbb-0000-4000-8000-000000000001";
const BOOT = "cccccccc-0000-4000-8000-000000000001";

/** A product set as GET /catalog/products returns it: the whole product, as an update needs it. */
const set = (id: string, name: string, variations: { id: string; sku: string; variation?: string; status?: string; price?: number; jumiaSku?: string }[]) => ({
  id: `set-${id}`, name, description: `<p>${name}, the original description.</p>`, parentSku: `${id}-PARENT`,
  brand: { code: 1001, name: "Lattafa" }, category: { code: 1000844, name: "Eau de Parfum" }, createdAt: "2026-06-01T10:00:00Z",
  images: [{ url: `https://img/${id}-1.jpg`, primary: true }, { url: `https://img/${id}-2.jpg`, primary: false }],
  attributes: [{ id: "x1", name: "short_description", value: "<ul><li>Old point</li></ul>" }, { id: "x2", name: "color", value: "Brown" }],
  variations: variations.map((v) => ({
    id: v.id, sellerSku: v.sku, variation: v.variation ?? "...", barcodeEan: null,
    attributes: [{ id: "y1", name: "volume", value: v.variation ?? "" }],
    globalPrice: { currency: "USD", value: 9 },
    businessClients: [{ code: "jumia-gh", sku: v.jumiaSku ?? `JM-${v.sku}`, status: v.status ?? "ACTIVE", visible: true, qc: { status: "APPROVED" },
      price: { localValue: v.price ?? 100, localCurrency: "GHS", salePrice: null } }],
  })),
});

let catalog: unknown[] = [];
let stock: Record<string, number> = {};
let orders: Record<string, unknown>[] = [];
let orderItems: Record<string, Record<string, unknown>[]> = {};
let statements: Record<string, unknown>[] = [];
const calls: { method: string; path: string; query: URLSearchParams; body?: Record<string, unknown> }[] = [];

beforeEach(() => {
  db = new FakeDb();
  sent.length = 0;
  calls.length = 0;
  rewritten = "{}";
  _resetPriceMinimumCache();
  _resetBillingModeCache();
  catalog = [
    set("p", "Lattafa Eau de Parfum", [{ id: PERFUME_50, sku: "LAT-50", variation: "50ml", price: 150 }, { id: PERFUME_100, sku: "LAT-100", variation: "100ml", price: 240 }]),
    set("k", "Nasco Electric Kettle 1.7L", [{ id: KETTLE, sku: "NAS-K", price: 99.5 }]),
    set("b", "Wellington Rain Boot", [{ id: BOOT, sku: "WEL-B", status: "INACTIVE", price: 80 }]),
  ];
  stock = { [PERFUME_50]: 0, [PERFUME_100]: 4, [KETTLE]: 3, [BOOT]: 10 };
  orders = [];
  orderItems = {};
  statements = [];
  global.fetch = jest.fn(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, query: url.searchParams, body });
    let out: unknown = {};
    if (url.pathname === "/catalog/products") {
      const sku = url.searchParams.get("sellerSku");
      out = { products: sku ? catalog.filter((s) => (s as { variations: { sellerSku: string }[] }).variations.some((v) => v.sellerSku === sku)) : catalog, isLastPage: true };
    } else if (url.pathname === "/catalog/stock") {
      out = { products: Object.entries(stock).map(([id, n]) => ({ id, globalStock: n })), isLastPage: true };
    } else if (url.pathname.startsWith("/feeds/products/")) out = { feedId: "feed-1" };
    else if (url.pathname === "/orders") out = { orders, nextToken: null, isLastPage: true };
    else if (url.pathname === "/orders/items") out = url.searchParams.getAll("orderId").map((id) => ({ orderId: id, items: orderItems[id] ?? [] }));
    else if (url.pathname === "/payout-statement") out = { statements };
    else if (url.pathname === "/shops-of-master-shop") out = [
      { id: "shop-1", name: "GEM MALL", businessClients: [{ code: "jumia-gh", countryCode: "GH", status: "ACTIVE" }] },
      { id: "shop-2", name: "GEM MALL NG", businessClients: [{ code: "jumia-ng", countryCode: "NG", status: "INACTIVE" }] },
    ];
    else if (url.pathname === "/consignment-stock") out = { simpleSku: url.searchParams.get("sku"), received: 40, quarantined: 2, defective: 1, canceled: 0, returned: 0, failed: 0 };
    else if (url.pathname === "/consignment-order") out = { purchaseOrderNumber: "PO-7781" };
    return new Response(JSON.stringify(out), { status: method === "POST" && url.pathname === "/consignment-order" ? 201 : 200 });
  }) as unknown as typeof fetch;
});

const writes = () => calls.filter((c) => c.method !== "GET");
const last = () => sent[sent.length - 1];
const products = (): ShopProduct[] => productsFromCatalog({ products: catalog }, "GH").map((p) => ({ ...p, stock: stock[p.sid] ?? null }));

describe("prices by a percentage", () => {
  it("whole prices stay whole, others to the cent", () => {
    expect(pctPrice(150, 10)).toBe(165);
    expect(pctPrice(99.5, -10)).toBe(89.55);
    expect(changedPrice({ price: 200 }, { kind: "sale_pct", pct: 10, start: "2026-10-10", end: "2026-10-11" })).toBe(180);
    expect(changedPrice({ price: 200 }, { kind: "status", active: true })).toBeNull();
  });
});

describe("rules for many products", () => {
  it("picks by scope and leaves out what wouldn't change", () => {
    const all = products();
    expect(bulkTargets(all, "out_of_stock", null, { kind: "status", active: false }, null).targets.map((p) => p.sellerSku)).toEqual(["LAT-50"]);
    const off = bulkTargets(all, "all", null, { kind: "status", active: false }, null);
    expect(off.targets.map((p) => p.sellerSku)).toEqual(["LAT-50", "LAT-100", "NAS-K"]);
    expect(off.skipped).toEqual([{ reason: "already off", count: 1 }]);
    expect(bulkTargets(all, "matching", "parfum", { kind: "price_pct", pct: 5 }, null).targets.map((p) => p.sellerSku)).toEqual(["LAT-50", "LAT-100"]);
    // "Those", "the last 10" (owner's web chat, 2026-10-08): only the products just listed.
    expect(bulkTargets(all, "listed", null, { kind: "stock", stock: 20 }, null, [PERFUME_50, KETTLE]).targets.map((p) => p.sellerSku)).toEqual(["LAT-50", "NAS-K"]);
    expect(bulkTargets(all, "listed", null, { kind: "stock", stock: 20 }, null).targets).toEqual([]);
    // Below Jumia's lowest price: left out, said.
    const cut = bulkTargets(all, "all", null, { kind: "price_pct", pct: -50 }, 70);
    expect(cut.targets.map((p) => p.sellerSku)).toEqual(["LAT-50", "LAT-100"]);
    expect(cut.skipped).toEqual([{ reason: "would go below Jumia's lowest price", count: 2 }]);
  });

  it("is said in full, and one tap sends one feed with each product's own new price", async () => {
    expect(await proposeBulkChange(USER, PHONE, "matching", "lattafa parfum", { kind: "sale_pct", pct: 10, start: "2026-10-10", end: "2026-10-11" }))
      .toBe("offered bulk sale_pct for 2 (matching: lattafa parfum)");
    const offer = last();
    expect(offer.body).toContain("Change these 2 products on Jumia?");
    expect(offer.body).toContain("GHS 135 (10% off) from 2026-10-10 to 2026-10-11");
    expect(offer.body).toContain("GHS 216 (10% off)");
    expect(writes()).toHaveLength(0);

    await handleShopTap(USER, PHONE, offer.ids![0]);
    const feeds = writes().filter((c) => c.path === "/feeds/products/price");
    expect(feeds).toHaveLength(1);
    const items = (feeds[0].body as { products: { sellerSku: string; price: { value: number; salePrice: { value: number; startAt: string } } }[] }).products;
    expect(items.map((i) => [i.sellerSku, i.price.value, i.price.salePrice.value, i.price.salePrice.startAt])).toEqual([
      ["LAT-50", 150, 135, "2026-10-10 00:00"], ["LAT-100", 240, 216, "2026-10-10 00:00"],
    ]);
    expect(last().body).toContain("✅ Sent to Jumia for 2 products");
  });

  it("nothing to change is said, not offered", async () => {
    stock[PERFUME_50] = 5;
    expect(await proposeBulkChange(USER, PHONE, "out_of_stock", null, { kind: "status", active: false })).toBe("bulk none: out_of_stock");
    expect(last().body).toContain("Nothing to change");
  });
});

describe("a live product's content", () => {
  it("the new name is shown, and the tap sends the whole product with only the name changed", async () => {
    expect(await proposeContentChange(USER, PHONE, "kettle", { name: "Nasco 1.7L Cordless Electric Kettle - Silver" })).toBe("offered content (name) for NAS-K");
    expect(last().body).toContain('Update *Nasco Electric Kettle 1.7L* (SKU NAS-K) on Jumia: name → "Nasco 1.7L Cordless Electric Kettle - Silver"?');
    await handleShopTap(USER, PHONE, last().ids![0]);
    const feed = writes().find((c) => c.path === "/feeds/products/update")!;
    const item = (feed.body as { products: Record<string, unknown>[] }).products[0];
    expect(item).toMatchObject({
      id: KETTLE, sellerSku: "NAS-K", parentSku: "k-PARENT",
      name: { value: "Nasco 1.7L Cordless Electric Kettle - Silver" },
      description: { value: "<p>Nasco Electric Kettle 1.7L, the original description.</p>" },
      brand: { code: 1001, name: "Lattafa" }, category: { code: 1000844, name: "Eau de Parfum" },
      images: [{ url: "https://img/k-1.jpg", primary: true }, { url: "https://img/k-2.jpg", primary: false }],
    });
    expect(item).not.toHaveProperty("price");
    expect(item).not.toHaveProperty("stock");
  });

  it("every size of a product goes in the update, with new highlights in short_description", async () => {
    const r = await contentItems("tok", products().filter((p) => p.sellerSku === "LAT-50"), { highlights: "<ul><li>New</li></ul>" });
    expect(r.ok && r.data.map((i) => i.sellerSku)).toEqual(["LAT-50", "LAT-100"]);
    const attrs = r.ok ? (r.data[0].attributes as { name: string; value: string }[]) : [];
    expect(attrs.find((a) => a.name === "short_description")!.value).toBe("<ul><li>New</li></ul>");
    expect(attrs.find((a) => a.name === "volume")!.value).toBe("50ml");
  });

  it("a rewrite is written from what Jumia has now and shown before the tap", async () => {
    rewritten = '{"description":"<p>A sturdy rain boot.</p><ul><li>Waterproof</li></ul>"}';
    expect(await proposeContentChange(USER, PHONE, "wellington boot", { rewrite: ["description"], instructions: "rewrite it" })).toBe("offered content (description) for WEL-B");
    expect(last().body).toContain("*New description:*\nA sturdy rain boot.\n• Waterproof");
  });

  it("a brand Jumia doesn't have isn't sent; one it has is, with its code", async () => {
    db.tables.jumia_brands = [{ code: 2002, name: "Nasco" }];
    expect(await proposeContentChange(USER, PHONE, "kettle", { brand: "Nascoo" })).toBe("brand unknown");
    expect(last().body).toContain("isn't a brand on Jumia");
    expect(await proposeContentChange(USER, PHONE, "kettle", { brand: "nasco" })).toBe("offered content (brand) for NAS-K");
    expect(last().body).toContain("brand → Nasco");
  });

  it("descriptions are shown as plain lines", () => {
    expect(htmlToText("<p>One &amp; two</p><ul><li>A</li><li>B</li></ul>")).toBe("One & two\n• A\n• B");
  });
});

describe("reports from their orders", () => {
  const item = (sku: string, name: string, status: string, paid = 100) => ({ id: `${sku}-${Math.random()}`, status, paidPriceLocal: paid, country: { currencyCode: "GHS" }, product: { sellerSku: sku, name } });

  it("sales by product: sold, returned, failed and cancelled apart", () => {
    const s = salesByProduct([item("A", "a", "DELIVERED"), item("A", "a", "returned"), item("A", "a", "Failed Delivery"), item("A", "a", "CANCELED"), item("A", "a", "SHIPPED", 50)] as never);
    expect(s.get("A")).toMatchObject({ sold: 2, revenue: 150, returned: 1, failed: 1, cancelled: 1 });
    expect(daysLeft(10, 30, 30)).toBe(10);
    expect(daysLeft(10, 0, 30)).toBeNull();
  });

  beforeEach(() => {
    orders = [{ id: "o1", number: "1", createdAt: "2026-10-01 10:00:00" }, { id: "o2", number: "2", createdAt: "2026-10-02 10:00:00" }];
    orderItems = {
      o1: [item("NAS-K", "Nasco Electric Kettle 1.7L", "DELIVERED"), item("NAS-K", "Nasco Electric Kettle 1.7L", "DELIVERED"), item("LAT-100", "Lattafa Eau de Parfum", "RETURNED", 240)],
      o2: [item("NAS-K", "Nasco Electric Kettle 1.7L", "SHIPPED"), item("LAT-100", "Lattafa Eau de Parfum", "DELIVERED", 240)],
    };
  });

  it("best sellers", async () => {
    await answerReport(USER, PHONE, "best_sellers", "month");
    expect(last().body).toContain("🏆 Your best sellers in the last 30 days");
    expect(last().body).toContain("1. Nasco Electric Kettle 1.7L: 3 sold · GHS 300");
    expect(last().body).toContain("2. Lattafa Eau de Parfum: 1 sold · GHS 240");
  });

  it("restock: what runs out within two weeks at the rate it sold", async () => {
    await answerReport(USER, PHONE, "restock", "month");
    // Kettle: 3 left, 3 sold in 30 days → about 30 days, not listed. Perfume 100ml: 4 left, 1 sold → not soon.
    expect(last().body).toContain("Nothing runs out in the next 2 weeks");
    stock[KETTLE] = 1;
    orderItems.o2.push(...Array.from({ length: 20 }, () => item("NAS-K", "Nasco Electric Kettle 1.7L", "DELIVERED")));
    db = new FakeDb();
    await answerReport(USER, PHONE, "restock", "month");
    expect(last().body).toContain("• Nasco Electric Kettle 1.7L: 1 left, about 1 day · sold 23");
  });

  it("products with no sale, and returns", async () => {
    await answerReport(USER, PHONE, "slow_movers", "month");
    expect(last().body).toBe("✅ Every product that's on sold at least once in the last 30 days.");
    catalog.push(set("x", "Silver Crest Blender 1.5L", [{ id: "dddddddd-0000-4000-8000-000000000001", sku: "SC-BL" }]));
    stock["dddddddd-0000-4000-8000-000000000001"] = 6;
    db = new FakeDb();
    await answerReport(USER, PHONE, "slow_movers", "month");
    // The boot is off and the 50ml is out of stock: neither is listed.
    expect(last().body).toContain("🐢 1 product on Jumia with no sale in the last 30 days, most stock first:\n• Silver Crest Blender 1.5L: 6 in stock");
    expect(last().body).not.toContain("Wellington");
    await answerReport(USER, PHONE, "returns", "month");
    expect(last().body).toContain("↩️ Returns and failed deliveries in the last 30 days: 1 of 5 items (20%)");
    expect(last().body).toContain("• Lattafa Eau de Parfum: 1 returned of 2 (50%)");
  });
});

describe("payouts in detail", () => {
  beforeEach(() => {
    statements = [
      { statementNumber: "GH11-20261005", createdAt: "2026-10-05 03:00:00", updatedAt: null, openingBalance: 0, itemRevenue: 1200, feesTotal: 180, shipmentFee: 40,
        refunds: 100, closingBalance: 920, payout: { amount: 920, currency: "GHS" }, paid: false, paymentReference: null },
      { statementNumber: "GH11-20260928", createdAt: "2026-09-28 03:00:00", updatedAt: "2026-10-01 09:00:00", itemRevenue: 500, feesTotal: 75,
        payout: { amount: 425, currency: "GHS" }, paid: true, paymentReference: "TRX-9" },
    ];
  });

  it("every statement, one line each", async () => {
    await answerPayoutDetail(USER, PHONE, "history", null);
    expect(last().body).toContain("• 2026-10-05 · GH11-20261005 · *GHS 920* · not paid yet");
    expect(last().body).toContain("• 2026-10-01 · GH11-20260928 · *GHS 425* · paid (ref TRX-9)");
  });

  it("one statement line by line, by its number", async () => {
    await answerPayoutDetail(USER, PHONE, "breakdown", "GH11-20260928");
    expect(last().body).toContain("🧾 Statement GH11-20260928 (2026-10-01)");
    expect(last().body).toContain("• Sales: GHS 500");
    expect(last().body).toContain("• All fees: -GHS 75");
    expect(statementLines({ number: "x", createdAt: null, updatedAt: null, paid: false, reference: null, amount: 0, currency: "GHS", openingBalance: 0, itemRevenue: 0, feesTotal: null, refunds: null, closingBalance: null }, String)).toEqual([]);
  });
});

describe("brands, shops and Jumia's warehouse", () => {
  it("a brand on Jumia, or the close ones", async () => {
    db.tables.jumia_brands = [{ code: 1001, name: "Lattafa" }, { code: 1002, name: "Lattafa Pride" }];
    await answerBrand(USER, PHONE, "lattafa", null);
    expect(last().body).toBe("✅ *Lattafa* is a brand on Jumia.");
    await answerBrand(USER, PHONE, "Lattafah", null);
    expect(last().body).toContain('"Lattafah" isn\'t in Jumia\'s brand list. Close ones: Lattafa, Lattafa Pride.');
  });

  it("the shops under the account", async () => {
    await answerLinkedShops(USER, PHONE);
    expect(last().body).toContain("• *GEM MALL*: Ghana");
    expect(last().body).toContain("• *GEM MALL NG*: Nigeria (inactive)");
  });

  it("what the warehouse holds, by Jumia's own SKU", async () => {
    await answerWarehouseStock(USER, PHONE, "kettle");
    expect(calls.find((c) => c.path === "/consignment-stock")!.query.get("sku")).toBe("JM-NAS-K");
    expect(last().body).toContain("• Nasco Electric Kettle 1.7L (SKU NAS-K): 40 received · 2 in quarantine · 1 defective");
  });

  it("a delivery order is made only on the tap, and marking it shipped too", async () => {
    await proposeWarehouseOrder(USER, PHONE, [{ product: "kettle", quantity: 50 }], "2026-10-20");
    expect(last().body).toContain("• Nasco Electric Kettle 1.7L (SKU NAS-K): 50");
    expect(last().body).toContain("Shipping on 2026-10-20.");
    expect(writes()).toHaveLength(0);
    await handleWarehouseTap(USER, PHONE, last().ids![0]);
    expect(writes()[0]).toMatchObject({ method: "POST", path: "/consignment-order",
      body: { shopId: "shop-1", businessClientCode: "jumia-gh", shippingDate: "2026-10-20 09:00:00", products: [{ sku: "JM-NAS-K", quantity: 50 }] } });
    expect(last().body).toContain("Delivery order *PO-7781* created");
    // Tapped again: already done.
    await handleWarehouseTap(USER, PHONE, sent[sent.length - 2].ids![0]);
    expect(last().body).toBe("That was already handled.");

    await proposeWarehouseShipped(USER, PHONE, "PO-7781", "DHL998877", null);
    await handleWarehouseTap(USER, PHONE, last().ids![0]);
    expect(writes()[1]).toMatchObject({ method: "PATCH", path: "/consignment-order/PO-7781", body: { isShipped: true, trackingNumber: "DHL998877" } });
  });

  it("No leaves Jumia alone", async () => {
    await proposeWarehouseOrder(USER, PHONE, [{ product: "kettle", quantity: 5 }], null);
    await handleWarehouseTap(USER, PHONE, last().ids![1]);
    expect(last().body).toBe("OK, nothing sent to Jumia.");
    expect(writes()).toHaveLength(0);
  });
});
