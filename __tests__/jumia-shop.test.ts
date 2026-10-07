/**
 * The seller's live Jumia shop on WhatsApp (owner, 2026-10-07: "implement the
 * rest from the API and wire it conversationally"): lib/jumia/shop.ts (the
 * Vendor API), lib/whatsapp/shop.ts (what the seller sees, the confirm tap)
 * and lib/whatsapp/shop-notices.ts (what they're told unasked). Jumia's
 * answers follow the shapes in its spec (vendorcenter.jumia.com/api-docs).
 */

import { FakeDb } from "./helpers/fake-supabase";

let db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({ createServerClient: () => db }));
jest.mock("@/lib/jumia/oauth", () => ({ JUMIA_API_BASE: "https://vendor-api.jumia.com" }));

let feed: { status: string; failed: number; errors: unknown[]; raw?: unknown } | null = { status: "DONE", failed: 0, errors: [] };
let feedReads = 0;
jest.mock("@/lib/jumia/api", () => ({
  COUNTRY_CURRENCY: { GH: "GHS", NG: "NGN", KE: "KES" },
  getValidJumiaCredentials: async () => ({ accessToken: "tok_secret", shopId: "s", currency: "GHS", country: "GH" }),
  getFeedStatus: async () => { feedReads++; return feed ? { total: 1, success: feed.failed ? 0 : 1, raw: {}, ...feed } : null; },
}));
jest.mock("@/lib/jumia/credentials", () => ({ getJumiaConnectionKind: async () => "connected" }));
jest.mock("@/lib/whatsapp/jumia-connect", () => ({ promptJumiaConnection: jest.fn() }));
jest.mock("@/lib/whatsapp/credit-gate", () => ({ botPausedForCredits: async () => false }));

const off = new Set<string>();
jest.mock("@/lib/billing/features", () => ({
  hasFeature: async (_u: string, f: string) => !off.has(f),
  featureAccess: async (_u: string, f: string) => (off.has(f) ? { ok: false, blockedBy: "pack" } : { ok: true }),
  featureMinPackName: () => "Pro",
}));

type Sent = { kind: string; body: string; ids?: string[] };
const sent: Sent[] = [];
jest.mock("@/lib/whatsapp/client", () => ({
  LIST_MAX_ROWS: 10,
  sendTextIfConfigured: async (_to: string, body: string) => { sent.push({ kind: "text", body }); },
  sendButtonsIfConfigured: async (_to: string, body: string, b: { id: string }[]) => { sent.push({ kind: "buttons", body, ids: b.map((x) => x.id) }); },
  sendListIfConfigured: async (_to: string, body: string, _b: string, r: { id: string }[]) => { sent.push({ kind: "list", body, ids: r.map((x) => x.id) }); },
  sendCtaUrlIfConfigured: async (_to: string, body: string) => { sent.push({ kind: "cta", body }); },
  sendButtonsWithDocumentIfConfigured: async () => {},
  sendTemplateIfConfigured: async () => {},
}));

import {
  feedItemResults, findProducts, productsFromCatalog, sendLiveChange, sendLiveChanges, statementsFrom, summarizeOrders, syncCatalog, type ShopProduct,
} from "@/lib/jumia/shop";
import {
  answerFees, answerListings, answerOrderStatus, answerPayouts, answerProductInfo, answerProducts, answerSales, answerStock, groupTargets,
  handleShopTap, lowStockNote, parseShopTap, periodStart, proposeLiveChange,
} from "@/lib/whatsapp/shop";
import { COUNTRY_FEES, feeCategoryForPath } from "@/lib/marketing/country-fees";
import { orderUpdatesText, runShopNotices } from "@/lib/whatsapp/shop-notices";
import { parseAction, productBacked } from "@/lib/whatsapp/assistant";
import { _resetPriceMinimumCache } from "@/lib/jumia/price-minimums";

const USER = "seller";
const PHONE = "233200000000";
const FRIDGE = "11111111-0000-4000-8000-000000000001";
const FRIDGE2 = "11111111-0000-4000-8000-000000000002";
const SHIRT_M = "22222222-0000-4000-8000-000000000001";
const SHIRT_L = "22222222-0000-4000-8000-000000000002";
const BLENDER = "33333333-0000-4000-8000-000000000001";

/** A product set as GET /catalog/products returns it, with one business client per country. */
const set = (id: string, name: string, brand: string, variations: { id: string; sku: string; variation?: string; status?: string; qc?: string; reason?: string; price?: number }[]) => ({
  id: `set-${id}`, name, brand: { name: brand }, category: { code: "1004141" }, createdAt: "2026-09-01T10:00:00Z",
  images: [{ url: `https://img/${id}.jpg`, primary: true }],
  variations: variations.map((v) => ({
    id: v.id, sellerSku: v.sku, variation: v.variation ?? "...",
    globalPrice: { currency: "USD", value: 99 },
    businessClients: [
      { code: "jumia-ng", status: "DELETED", qc: { status: "REJECTED" }, price: { localValue: 1, localCurrency: "NGN" } },
      { code: "jumia-gh", status: v.status ?? "ACTIVE", visible: true, qc: { status: v.qc ?? "APPROVED", rejectionReason: v.reason ?? null },
        price: { localValue: v.price ?? 4500, localCurrency: "GHS", salePrice: null } },
    ],
  })),
});

let catalog: unknown[] = [];
let stock: Record<string, number> = {};
let orders: Record<string, unknown>[] = [];
let orderItems: Record<string, Record<string, unknown>[]> = {};
let statements: Record<string, unknown>[] = [];
const calls: { method: string; path: string; query: URLSearchParams; body?: unknown }[] = [];

beforeEach(() => {
  db = new FakeDb();
  sent.length = 0;
  calls.length = 0;
  off.clear();
  feed = { status: "DONE", failed: 0, errors: [] };
  feedReads = 0;
  _resetPriceMinimumCache();
  catalog = [
    set("f", "Hisense 205L Double Door Fridge", "Hisense", [{ id: FRIDGE, sku: "HIS-205" }]),
    set("f2", "LG 250L Top Freezer Fridge", "LG", [{ id: FRIDGE2, sku: "LG-250", price: 5200 }]),
    set("s", "Men's Cotton T-Shirt", "Generic", [{ id: SHIRT_M, sku: "TEE-M", variation: "M" }, { id: SHIRT_L, sku: "TEE-L", variation: "L", status: "INACTIVE" }]),
    set("b", "Nasco Blender 1.5L", "Nasco", [{ id: BLENDER, sku: "NAS-BL", qc: "REJECTED", reason: "Poor image quality" }]),
  ];
  stock = { [FRIDGE]: 3, [FRIDGE2]: 0, [SHIRT_M]: 12, [SHIRT_L]: 2, [BLENDER]: 7 };
  orders = [];
  orderItems = {};
  statements = [];
  global.fetch = jest.fn(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, query: url.searchParams, body });
    let out: unknown = {};
    if (url.pathname === "/catalog/products") out = { products: catalog, nextToken: null, isLastPage: true };
    else if (url.pathname === "/catalog/stock") {
      const sids = url.searchParams.getAll("productSids");
      const ids = sids.length ? sids : Object.keys(stock);
      out = { products: ids.filter((id) => id in stock).map((id) => ({ id, sellerSku: "x", globalStock: stock[id], lastStockUpdatedAt: "2026-10-01T00:00:00Z" })), isLastPage: true };
    } else if (url.pathname.startsWith("/feeds/products/")) out = { feedId: "feed-0001" };
    else if (url.pathname === "/orders") out = { orders, nextToken: null, isLastPage: true };
    else if (url.pathname === "/orders/items") out = url.searchParams.getAll("orderId").map((id) => ({ orderId: id, items: orderItems[id] ?? [] }));
    else if (url.pathname === "/payout-statement") out = { statements, page: { current: 1, totalOfPages: 1 } };
    return new Response(JSON.stringify(out), { status: 200 });
  }) as unknown as typeof fetch;
});

const writes = () => calls.filter((c) => c.method !== "GET");
const last = () => sent[sent.length - 1];

describe("the catalog", () => {
  it("one row per variation, with the seller's own country's status, QC and price", () => {
    const rows = productsFromCatalog({ products: catalog }, "GH");
    expect(rows).toHaveLength(5);
    const fridge = rows.find((r) => r.sid === FRIDGE)!;
    expect(fridge).toMatchObject({ sellerSku: "HIS-205", name: "Hisense 205L Double Door Fridge", status: "ACTIVE", qcStatus: "APPROVED", price: 4500, currency: "GHS", categoryCode: "1004141", imageUrl: "https://img/f.jpg" });
    expect(rows.find((r) => r.sid === SHIRT_L)).toMatchObject({ variation: "L", status: "INACTIVE" });
    expect(rows.find((r) => r.sid === BLENDER)).toMatchObject({ qcStatus: "REJECTED", qcReason: "Poor image quality" });
  });

  it("is read with its stock into jumia_products, and not read again while fresh", async () => {
    const r = await syncCatalog(USER, { accessToken: "t", country: "GH" });
    expect(r).toEqual({ ok: true, count: 5, fresh: true });
    expect(db.tables.jumia_products.find((p) => p.product_sid === FRIDGE)).toMatchObject({ stock: 3, user_id: USER });
    calls.length = 0;
    expect(await syncCatalog(USER, { accessToken: "t", country: "GH" })).toEqual({ ok: true, count: 5, fresh: false });
    expect(calls).toHaveLength(0);
  });

  it("drops products no longer in the shop", async () => {
    await syncCatalog(USER, { accessToken: "t", country: "GH" });
    catalog = catalog.slice(0, 1);
    await new Promise((r) => setTimeout(r, 5));
    await syncCatalog(USER, { accessToken: "t", country: "GH" }, { force: true });
    expect(db.tables.jumia_products.map((p) => p.product_sid)).toEqual([FRIDGE]);
  });
});

describe("finding the product the seller means", () => {
  const all = () => productsFromCatalog({ products: catalog }, "GH");
  it("by their words, by SKU, and every one that fits", () => {
    expect(findProducts(all(), "the Hisense fridge").map((p) => p.sid)).toEqual([FRIDGE]);
    expect(findProducts(all(), "fridges").map((p) => p.sid).sort()).toEqual([FRIDGE, FRIDGE2].sort());
    expect(findProducts(all(), "tee-l").map((p) => p.sid)).toEqual([SHIRT_L]);
    expect(findProducts(all(), "t-shirt large").length).toBeGreaterThan(0);
    expect(findProducts(all(), "washing machine")).toEqual([]);
  });
});

describe("the Vendor API calls for a live change", () => {
  const fridge = (): ShopProduct => productsFromCatalog({ products: catalog }, "GH").find((p) => p.sid === FRIDGE)!;
  const ctx = { country: "GH", currency: "GHS" };
  it("stock", async () => {
    expect(await sendLiveChange("t", fridge(), { kind: "stock", stock: 20 }, ctx)).toEqual({ ok: true, data: { feedId: "feed-0001" } });
    expect(writes()[0]).toMatchObject({ path: "/feeds/products/stock", body: { products: [{ sellerSku: "HIS-205", id: FRIDGE, stock: 20 }] } });
  });
  it("price, for the seller's country too", async () => {
    await sendLiveChange("t", fridge(), { kind: "price", price: 4200 }, ctx);
    const price = { currency: "GHS", value: 4200 };
    expect(writes()[0]).toMatchObject({ path: "/feeds/products/price", body: { products: [{ sellerSku: "HIS-205", id: FRIDGE, category: 1004141, price, businessClients: [{ businessClientCode: "jumia-gh", price }] }] } });
  });
  it("a sale with its dates, and ending one", async () => {
    await sendLiveChange("t", fridge(), { kind: "sale", sale: { price: 3999, start: "2026-10-10", end: "2026-10-20" } }, ctx);
    expect((writes()[0].body as { products: { price: unknown }[] }).products[0].price).toEqual({
      currency: "GHS", value: 4500, salePrice: { value: 3999, startAt: "2026-10-10 00:00", endAt: "2026-10-20 23:59" },
    });
    await sendLiveChange("t", fridge(), { kind: "sale", sale: null }, ctx);
    expect((writes()[1].body as { products: { price: unknown }[] }).products[0].price).toEqual({
      currency: "GHS", value: 4500, salePrice: { value: null, startAt: null, endAt: null },
    });
  });
  it("on and off", async () => {
    await sendLiveChange("t", fridge(), { kind: "status", active: false }, ctx);
    expect(writes()[0]).toMatchObject({ path: "/feeds/products/status", body: { products: [{ sellerSku: "HIS-205", id: FRIDGE, createdAt: "2026-09-01", businessClients: [{ businessClientCode: "jumia-gh", status: "INACTIVE" }] }] } });
  });
});

describe("changing a live product on WhatsApp", () => {
  it("one tap to confirm, then the feed; nothing reaches Jumia before the tap", async () => {
    await proposeLiveChange(USER, PHONE, "Hisense fridge", { kind: "stock", stock: 20 });
    expect(writes()).toHaveLength(0);
    const offer = last();
    expect(offer.kind).toBe("buttons");
    expect(offer.body).toBe("Change *Hisense 205L Double Door Fridge* (SKU HIS-205): stock 3 → 20?\n\nThis changes it on Jumia.");
    const [yes, no] = offer.ids!;
    expect(yes).toMatch(/^lchg:[0-9a-f-]{36}$/);
    expect(no).toMatch(/^lchgno:/);

    await handleShopTap(USER, PHONE, yes);
    expect(writes()).toEqual([expect.objectContaining({ path: "/feeds/products/stock" })]);
    expect(db.tables.jumia_product_changes[0]).toMatchObject({ status: "sent", feed_id: "feed-0001", seller_sku: "HIS-205" });
    expect(last().body).toContain("✅ Sent to Jumia: *Hisense 205L Double Door Fridge*, stock 3 → 20.");

    await handleShopTap(USER, PHONE, yes);
    expect(last().body).toBe("That change was already handled.");
    expect(writes()).toHaveLength(1);
  });

  it("several fit: a list, then the one picked is confirmed before anything changes", async () => {
    await proposeLiveChange(USER, PHONE, "fridge", { kind: "price", price: 4100 });
    const list = last();
    expect(list.kind).toBe("list");
    expect(list.body).toContain("I'll ask you to confirm before anything changes on Jumia");
    expect(list.ids).toHaveLength(2);
    const pick = list.ids!.find((id) => id.endsWith(":1"))!;
    await handleShopTap(USER, PHONE, pick);
    // Live 2026-10-07: one tap on a row once sent a change nobody asked for.
    expect(writes()).toHaveLength(0);
    const confirm = last();
    expect(confirm).toMatchObject({ kind: "buttons" });
    expect(confirm.body).toMatch(/^Change \*.+\* \(SKU .+\): price GHS [\d,]+ → GHS 4,100\?/);
    await handleShopTap(USER, PHONE, confirm.ids![0]);
    expect(writes()).toHaveLength(1);
    expect(writes()[0].path).toBe("/feeds/products/price");
  });

  it("\"it\" is the product just changed", async () => {
    await proposeLiveChange(USER, PHONE, "fridge", { kind: "stock", stock: 9 }, { preferSid: FRIDGE2 });
    expect(last()).toMatchObject({ kind: "buttons" });
    expect(last().body).toContain("LG 250L Top Freezer Fridge");
  });

  it("No changes nothing", async () => {
    await proposeLiveChange(USER, PHONE, "blender", { kind: "status", active: false });
    await handleShopTap(USER, PHONE, last().ids![1]);
    expect(last().body).toBe("OK, nothing changed on Jumia.");
    expect(writes()).toHaveLength(0);
  });

  it("an old offer isn't applied", async () => {
    await proposeLiveChange(USER, PHONE, "blender", { kind: "stock", stock: 5 });
    db.tables.jumia_product_changes[0].created_at = new Date(Date.now() - 31 * 60_000).toISOString();
    await handleShopTap(USER, PHONE, last().ids![0]);
    expect(writes()).toHaveLength(0);
    expect(last().body).toContain("I haven't changed anything");
  });

  it("someone else's change can't be tapped", async () => {
    await proposeLiveChange(USER, PHONE, "blender", { kind: "stock", stock: 5 });
    await handleShopTap("intruder", PHONE, last().ids![0]);
    expect(writes()).toHaveLength(0);
  });

  it("a price below Jumia's lowest is refused before anything", async () => {
    db.tables.jumia_connections = [{ user_id: USER, country: "GH" }];
    db.tables.jumia_price_minimums = [{ country: "GH", currency: "GHS", min_price: 8.81 }];
    await proposeLiveChange(USER, PHONE, "fridge", { kind: "price", price: 5 });
    expect(last().body).toContain("below the lowest price Jumia allows");
    expect(db.tables.jumia_product_changes ?? []).toHaveLength(0);
  });

  it("a product that isn't in the shop is said so", async () => {
    await proposeLiveChange(USER, PHONE, "washing machine", { kind: "stock", stock: 5 });
    expect(last().body).toBe('I couldn\'t find "washing machine" among your 5 Jumia products. Try its name as it shows on Jumia, or its SKU.');
  });

  it("needs the pack", async () => {
    off.add("shop_whatsapp");
    await proposeLiveChange(USER, PHONE, "fridge", { kind: "stock", stock: 5 });
    expect(last()).toMatchObject({ kind: "cta", body: "Your live products on WhatsApp come with the Pro pack." });
    expect(calls).toHaveLength(0);
  });

  it("taps are read only in their own shape", () => {
    expect(parseShopTap("lchg:11111111-0000-4000-8000-000000000001")).toEqual({ kind: "confirm", id: "11111111-0000-4000-8000-000000000001" });
    expect(parseShopTap("lpick:11111111-0000-4000-8000-000000000001:3")).toEqual({ kind: "pick", id: "11111111-0000-4000-8000-000000000001", index: 3 });
    expect(parseShopTap("change the fridge")).toBeNull();
  });
});

describe("answers", () => {
  it("stock of what they name, and what's out or low", async () => {
    await answerStock(USER, PHONE, "Hisense fridge", null);
    expect(last().body).toBe("📦 Stock on Jumia\n• Hisense 205L Double Door Fridge: 3 left");
    await answerStock(USER, PHONE, null, "out");
    expect(last().body).toContain("🚫 Out of stock on Jumia (1)\n• LG 250L Top Freezer Fridge: out of stock");
    await answerStock(USER, PHONE, null, "low");
    // The large T-shirt is off, so it isn't counted.
    expect(last().body).toContain("⚠️ Low on stock (1)\n• Hisense 205L Double Door Fridge: 3 left");
  });

  it("their products: an overview, the ones off, the ones rejected with the reason", async () => {
    await answerProducts(USER, PHONE, "all");
    expect(last().body).toBe([
      "🛍️ Your Jumia shop: 5 products", "• On: 4", "• Off: 1", "• Out of stock: 1", "• Waiting for Jumia's check: 0", "• Rejected: 1",
      "", "Ask me about any of them: stock, price, a sale, or turning one on or off.",
    ].join("\n"));
    await answerProducts(USER, PHONE, "rejected");
    expect(last().body).toContain("• Nasco Blender 1.5L: Poor image quality");
    await answerProducts(USER, PHONE, "inactive");
    expect(last().body).toContain("• Men's Cotton T-Shirt (L)");
  });

  it("one order by its number, item by item", async () => {
    orders = [{ id: "o1", number: 355926919, status: "Delivered", createdAt: "2026-10-01T10:00:00Z", totalAmountLocal: { currency: "GHS", value: 238 } }];
    orderItems = { o1: [{ id: "i1", status: "DELIVERED", trackingNumber: "DS-1", product: { name: "Nasco Blender" } }] };
    await answerOrderStatus(USER, PHONE, "355926919");
    expect(last().body).toBe("📦 Order #355926919: Delivered\nOrdered 1 Oct · GHS 238\n• Nasco Blender: Delivered (tracking DS-1)");
    await answerOrderStatus(USER, PHONE, "999999999");
    expect(last().body).toBe("I couldn't find order #999999999 in your Jumia orders from the last 3 months.");
  });

  it("orders and sales for a period, cancelled ones left out of the total", async () => {
    orders = [
      { id: "a", number: 1, status: "Delivered", totalAmountLocal: { currency: "GHS", value: 100 } },
      { id: "b", number: 2, status: "Pending", totalAmountLocal: { currency: "GHS", value: 50 } },
      { id: "c", number: 3, status: "Canceled", totalAmountLocal: { currency: "GHS", value: 70 } },
    ];
    await answerSales(USER, PHONE, "week");
    expect(last().body).toBe("📊 3 Jumia orders in the last 7 days · GHS 150\nPending 1 · Delivered 1 · Cancelled 1\n(The total leaves out cancelled orders.)");
    expect(calls.find((c) => c.path === "/orders")!.query.get("createdAfter")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("the week starts six days back in the seller's own timezone", () => {
    expect(periodStart("today", "Africa/Accra", new Date("2026-10-07T23:30:00Z"))).toBe("2026-10-07");
    expect(periodStart("today", "Africa/Nairobi", new Date("2026-10-07T23:30:00Z"))).toBe("2026-10-08");
    expect(periodStart("week", "Africa/Accra", new Date("2026-10-07T12:00:00Z"))).toBe("2026-10-01");
  });

  it("payouts: the last paid and the one still open", async () => {
    statements = [
      { statementNumber: "GH1-20260929", createdAt: "2026-09-29 03:00:00", updatedAt: "2026-10-02 09:00:00", paid: true, paymentReference: "PAY-77", payout: { amount: 1820.5, currency: "GHS" } },
      { statementNumber: "GH1-20261006", createdAt: "2026-10-06 03:00:00", paid: false, itemRevenue: 2400, feesTotal: 380, refunds: 0, payout: { amount: 2020, currency: "GHS" } },
    ];
    await answerPayouts(USER, PHONE);
    expect(last().body).toBe([
      "💰 Your Jumia payouts",
      "Last paid: *GHS 1,820.5*, 2 Oct (ref PAY-77) · statement GH1-20260929",
      "Not paid yet: *GHS 2,020* · statement GH1-20261006 from 6 Oct",
      "(sales GHS 2,400, fees GHS 380)",
    ].join("\n"));
    expect(calls.find((c) => c.path === "/payout-statement")!.query.get("currency")).toBe("LOCAL");
  });

  it("orders and sales need order_alerts; payouts need the shop pack", async () => {
    off.add("order_alerts");
    await answerSales(USER, PHONE, "today");
    expect(last().body).toBe("Your Jumia orders on WhatsApp come with the Pro pack.");
    off.add("shop_whatsapp");
    await answerPayouts(USER, PHONE);
    expect(last().body).toBe("Your Jumia payouts on WhatsApp come with the Pro pack.");
    expect(calls).toHaveLength(0);
  });

  it("pure helpers", () => {
    expect(statementsFrom({ statements: [{ statementNumber: "A", createdAt: "2026-01-01 00:00:00", paid: false, payout: { amount: 5, currency: "GHS" } }] })[0]).toMatchObject({ number: "A", amount: 5, paid: false });
    expect(summarizeOrders([{ status: "Delivered", totalAmountLocal: { currency: "NGN", value: 10 } }] as never)).toEqual({ orders: 1, value: 10, currency: "NGN", byStatus: { DELIVERED: 1 } });
  });
});

describe("low stock with a new order", () => {
  it("a line for each ordered product now low, read live", async () => {
    await syncCatalog(USER, { accessToken: "t", country: "GH" });
    stock[FRIDGE] = 1;
    const note = await lowStockNote(USER, "t", [{ items: [{ product: { sellerSku: "HIS-205" } }, { product: { sellerSku: "TEE-M" } }] }]);
    expect(note).toBe("⚠️ Low stock on Jumia:\n• Hisense 205L Double Door Fridge: 1 left\nTell me the new stock to update it, e.g. \"set its stock to 10\".");
    expect(await lowStockNote(USER, "t", [{ items: [{ product: { sellerSku: "TEE-M" } }] }])).toBeNull();
  });
});

describe("told without asking", () => {
  const seed = () => {
    db.tables.whatsapp_connections = [{ user_id: USER, phone_number: PHONE }];
    db.tables.jumia_connections = [{ user_id: USER, status: "active" }];
    db.tables.whatsapp_message_log = [{ phone_number: PHONE, direction: "inbound", created_at: "2026-10-07T09:00:00Z" }];
  };
  const at = (iso: string) => new Date(iso);
  const order = (id: string, number: number, status: string) => ({ id, number, status, totalAmountLocal: { currency: "GHS", value: 100 } });

  it("order updates: the first run learns what's there, then new ones are grouped, each once", async () => {
    seed();
    orders = [order("o1", 111, "Delivered")];
    await runShopNotices(at("2026-10-07T10:00:00Z"));
    expect(sent).toHaveLength(0);

    orders = [order("o1", 111, "Delivered"), order("o2", 222, "Delivered"), order("o3", 333, "Returned")];
    await runShopNotices(at("2026-10-07T10:10:00Z"));
    expect(last().body).toBe("📦 Jumia order updates\n\n*↩️ Returned*\n#333 · GHS 100\n\n*✅ Delivered*\n#222 · GHS 100");
    sent.length = 0;
    await runShopNotices(at("2026-10-07T12:30:00Z"));
    expect(sent).toHaveLength(0);
  });

  it("at most every two hours, but a cancellation at once; their own cancellation isn't told back", async () => {
    seed();
    orders = [];
    await runShopNotices(at("2026-10-07T10:00:00Z"));
    orders = [order("o1", 111, "Delivered")];
    await runShopNotices(at("2026-10-07T10:10:00Z"));
    sent.length = 0;

    orders = [order("o1", 111, "Delivered"), order("o2", 222, "Delivered")];
    await runShopNotices(at("2026-10-07T10:20:00Z"));
    expect(sent).toHaveLength(0);

    db.tables.shop_notices.push({ user_id: USER, kind: "order", ref: "o4:CANCELED" });
    orders.push(order("o3", 333, "Canceled"), order("o4", 444, "Canceled"));
    await runShopNotices(at("2026-10-07T10:30:00Z"));
    expect(last().body).toContain("*🚫 Cancelled (don't ship these)*\n#333 · GHS 100");
    expect(last().body).not.toContain("#444");
  });

  it("nothing outside WhatsApp's 24 hours, or at night", async () => {
    seed();
    orders = [];
    await runShopNotices(at("2026-10-07T10:00:00Z"));
    orders = [order("o1", 111, "Delivered")];
    await runShopNotices(at("2026-10-08T10:00:00Z"));
    expect(sent).toHaveLength(0);
    await runShopNotices(at("2026-10-07T23:00:00Z"));
    expect(sent).toHaveLength(0);
  });

  it("a payout paid since the last check, after the first check learns the old ones", async () => {
    seed();
    off.add("order_alerts");
    statements = [{ statementNumber: "GH1-0929", createdAt: "2026-09-29 03:00:00", paid: true, paymentReference: "PAY-77", payout: { amount: 1820, currency: "GHS" } }];
    await runShopNotices(at("2026-10-07T10:00:00Z"));
    expect(sent).toHaveLength(0);

    statements.push({ statementNumber: "GH1-1006", createdAt: "2026-10-06 03:00:00", paid: true, paymentReference: "PAY-91", payout: { amount: 2020, currency: "GHS" } });
    await runShopNotices(at("2026-10-07T12:00:00Z"));
    expect(sent).toHaveLength(0); // checked every 6 hours
    await runShopNotices(at("2026-10-07T16:01:00Z"));
    expect(last().body).toBe("💰 Jumia paid you *GHS 2,020* (ref PAY-91).\nStatement GH1-1006. Ask me \"my payouts\" for the details.");
  });

  it("a change Jumia refused is told; one it applied updates the local copy quietly", async () => {
    seed();
    await syncCatalog(USER, { accessToken: "t", country: "GH" });
    const old = new Date(Date.now() - 5 * 60_000).toISOString();
    db.tables.jumia_product_changes = [
      { id: "c1", user_id: USER, product_sid: FRIDGE, seller_sku: "HIS-205", name: "Hisense fridge", change: { kind: "stock", stock: 20 }, status: "sent", feed_id: "f1", created_at: old, updated_at: old },
    ];
    await runShopNotices(new Date());
    expect(db.tables.jumia_product_changes[0].status).toBe("done");
    expect(db.tables.jumia_products.find((p) => p.product_sid === FRIDGE)!.stock).toBe(20);

    feed = { status: "DONE", failed: 1, errors: ["Invalid price for business client jumia-gh"] };
    db.tables.jumia_product_changes.push({ id: "c2", user_id: USER, product_sid: FRIDGE, seller_sku: "HIS-205", name: "Hisense fridge", change: { kind: "price", price: 1 }, status: "sent", feed_id: "f2", created_at: old, updated_at: old });
    sent.length = 0;
    await runShopNotices(new Date());
    expect(sent.find((s) => s.body.startsWith("⚠️ Jumia didn't apply"))!.body).toBe("⚠️ Jumia didn't apply the change to *Hisense fridge* (price to GHS 1): Invalid price for business client jumia-gh");
  });

  it("the grouped text, cut at 15 per kind", () => {
    const many = Array.from({ length: 17 }, (_, i) => ({ id: `x${i}`, number: String(i), status: "Delivered" }));
    expect(orderUpdatesText(many as never).split("\n").at(-1)).toBe("+2 more");
  });
});

describe("what the assistant may hand over", () => {
  const msg = "set the stock of the hisense fridge to 20";
  it("a live change only with the product named and the value written", () => {
    expect(productBacked("Hisense fridge", msg)).toBe(true);
    expect(parseAction('{"type":"live_change","product":"Hisense fridge","stock":20}', msg, [])).toEqual({ type: "live_change", product: "Hisense fridge", change: { kind: "stock", stock: 20 } });
    expect(parseAction('{"type":"live_change","product":"Hisense fridge","stock":25}', msg, [])).toMatchObject({ type: "reply", text: expect.stringContaining("What should its stock be?") });
    expect(parseAction('{"type":"live_change","product":"Samsung TV","stock":20}', msg, [])).toMatchObject({ type: "reply", text: expect.stringContaining("Which product do you mean?") });
    expect(parseAction('{"type":"live_change","product":"blender","stock":0}', "the blender is sold out", [])).toEqual({ type: "live_change", product: "blender", change: { kind: "stock", stock: 0 } });
    expect(parseAction('{"type":"live_change","product":"blender","active":false}', "turn off the blender", [])).toEqual({ type: "live_change", product: "blender", change: { kind: "status", active: false } });
  });

  it("a sale needs its dates, written or left to us", () => {
    const now = new Date("2026-10-07T10:00:00Z");
    expect(parseAction('{"type":"live_change","product":"fridge","sale_price":4000}', "put the fridge on sale at 4000", [], {}, "GHS", { now }))
      .toMatchObject({ type: "reply", text: expect.stringContaining("A sale on Jumia needs its dates") });
    expect(parseAction('{"type":"live_change","product":"fridge","sale_price":4000}', "put the fridge on sale at 4000 from 10 Oct to 20 Oct", [], {}, "GHS", { now }))
      .toEqual({ type: "live_change", product: "fridge", change: { kind: "sale", sale: { price: 4000, start: "2026-10-10", end: "2026-10-20" } } });
    // "choose your own start and end date within this month" (live, 2026-10-07).
    expect(parseAction('{"type":"live_change","product":"boot","sale_price":100}', "sale price of the boot to 100 and choose your own start and end date within this month", [], {}, "GHS", { now }))
      .toEqual({ type: "live_change", product: "boot", change: { kind: "sale", sale: { price: 100, start: "2026-10-07", end: "2026-10-31" } } });
  });

  it("ending a sale or turning off only on the seller's own words", () => {
    // Live 2026-10-07: "Change the sales price of the Wellington boot to 100" came back as "end its sale".
    expect(parseAction('{"type":"live_change","product":"Wellington boot","sale":"end"}', "Change the sales price of the Wellington boot to 100", [])).toEqual({ type: "unclear" });
    expect(parseAction('{"type":"live_change","product":"boot","sale":"end"}', "end the sale on the boot", [])).toEqual({ type: "live_change", product: "boot", change: { kind: "sale", sale: null } });
    expect(parseAction('{"type":"live_change","product":"blender","active":false}', "what about the blender", [])).toEqual({ type: "unclear" });
    expect(parseAction('{"type":"live_change","product":"blender","active":true}', "turn the blender back on", [])).toEqual({ type: "live_change", product: "blender", change: { kind: "status", active: true } });
  });

  it("the product may come from the conversation, and is then marked so", () => {
    const context = "Bot: ✅ Sent to Jumia: *Wellington Boot (43)*, stock 4 → 30.";
    expect(parseAction('{"type":"live_change","product":"Wellington Boot","price":120}', "and make its price 120", [], {}, "GHS", { context }))
      .toEqual({ type: "live_change", product: "Wellington Boot", change: { kind: "price", price: 120 }, fromContext: true });
  });

  it("an order number only as written", () => {
    expect(parseAction('{"type":"order_status","number":"355926919"}', "where is order 355926919?", [])).toEqual({ type: "order_status", number: "355926919" });
    expect(parseAction('{"type":"order_status","number":"355926918"}', "where is order 355926919?", [])).toMatchObject({ type: "reply", text: expect.stringContaining("Which order?") });
  });

  it("stock, shop, sales and payouts", () => {
    expect(parseAction('{"type":"stock","product":null,"filter":"out"}', "what's out of stock", [])).toEqual({ type: "stock", product: null, filter: "out" });
    expect(parseAction('{"type":"shop","filter":"rejected"}', "which were rejected", [])).toEqual({ type: "shop", filter: "rejected" });
    expect(parseAction('{"type":"sales","period":"today"}', "sales today?", [])).toEqual({ type: "sales", period: "today", status: null });
    expect(parseAction('{"type":"sales","period":"yesterday","status":"cancelled"}', "check cancelled orders yesterday", [])).toEqual({ type: "sales", period: "yesterday", status: "CANCELED" });
    expect(parseAction('{"type":"listings","period":"today"}', "how many listings have I done today?", [])).toEqual({ type: "listings", period: "today" });
    expect(parseAction('{"type":"payouts"}', "when does jumia pay me", [])).toEqual({ type: "payouts" });
  });
});

describe("asked in the live test (2026-10-07)", () => {
  it("cancelled orders yesterday: the orders that moved there, one line each", async () => {
    orders = [{ id: "c1", number: 401, status: "Canceled", updatedAt: "2026-10-06T15:00:00Z", totalAmountLocal: { currency: "GHS", value: 90 } }];
    await answerSales(USER, PHONE, "yesterday", "CANCELED");
    const q = calls.find((c) => c.path === "/orders")!.query;
    expect(q.get("status")).toBe("CANCELED");
    expect(q.get("updatedAfter")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(last().body).toBe("📦 1 cancelled Jumia order yesterday\n• #401 · GHS 90 · 6 Oct\n\nAsk me about one by its number for the details.");
    orders = [];
    await answerSales(USER, PHONE, "today", "CANCELED");
    expect(last().body).toBe("No cancelled Jumia orders today.");
  });

  it("how many products they listed with PandaWorld today", async () => {
    const today = new Date().toISOString();
    db.tables.listings = [
      { id: "l1", user_id: USER, status: "pending_approval", created_at: today },
      { id: "l2", user_id: USER, status: "live", created_at: today },
      { id: "l3", user_id: USER, status: "draft", created_at: "2020-01-01T00:00:00Z" },
      { id: "l4", user_id: "someone-else", status: "live", created_at: today },
    ];
    await answerListings(USER, PHONE, "today");
    expect(last().body).toBe("🛍️ 2 products listed with PandaWorld today: 1 live on Jumia, 1 waiting for Jumia.");
  });
});

describe("round 3: several products, product info, fees (owner's second test, 2026-10-07)", () => {
  it("several products, one change: one question, one tap, one feed", async () => {
    await proposeLiveChange(USER, PHONE, ["Hisense fridge", "blender"], { kind: "stock", stock: 10 });
    expect(writes()).toHaveLength(0);
    const offer = last();
    expect(offer.kind).toBe("buttons");
    expect(offer.body).toBe([
      "Change these 2 products on Jumia?",
      "• Hisense 205L Double Door Fridge: stock 3 → 10",
      "• Nasco Blender 1.5L: stock 7 → 10",
      "",
      "One tap changes them all.",
    ].join("\n"));
    expect(offer.ids![0]).toMatch(/^lgrp:[0-9a-f-]{36}$/);
    expect(db.tables.jumia_product_changes).toHaveLength(2);

    await handleShopTap(USER, PHONE, offer.ids![0]);
    expect(writes()).toHaveLength(1);
    expect((writes()[0].body as { products: { sellerSku: string }[] }).products.map((p) => p.sellerSku)).toEqual(["HIS-205", "NAS-BL"]);
    expect(db.tables.jumia_product_changes.map((r) => [r.status, r.feed_id])).toEqual([["sent", "feed-0001"], ["sent", "feed-0001"]]);
    expect(last().body).toContain("✅ Sent to Jumia for 2 products (Hisense 205L Double Door Fridge, Nasco Blender 1.5L): stock to 10.");

    await handleShopTap(USER, PHONE, offer.ids![0]);
    expect(last().body).toBe("That change was already handled.");
    expect(writes()).toHaveLength(1);
  });

  it("No on a group changes nothing", async () => {
    await proposeLiveChange(USER, PHONE, ["Hisense fridge", "blender"], { kind: "status", active: false });
    await handleShopTap(USER, PHONE, last().ids![1]);
    expect(last().body).toBe("OK, nothing changed on Jumia.");
    expect(db.tables.jumia_product_changes.every((r) => r.status === "cancelled")).toBe(true);
    expect(writes()).toHaveLength(0);
  });

  it("a word that fits several products is said back, and nothing is offered", async () => {
    await proposeLiveChange(USER, PHONE, ["fridge", "blender", "kettle"], { kind: "stock", stock: 10 });
    expect(last().body).toContain("I haven't changed anything yet:");
    expect(last().body).toContain('"fridge" could be 2 products:');
    expect(last().body).toContain("– LG 250L Top Freezer Fridge (SKU LG-250)");
    expect(last().body).toContain('I couldn\'t find "kettle"');
    expect(db.tables.jumia_product_changes ?? []).toHaveLength(0);
  });

  it("a product's sizes go together; \"all\" takes every fit", () => {
    const products = productsFromCatalog({ products: catalog }, "GH");
    expect(groupTargets(products, ["t-shirt", "blender"]).targets.map((p) => p.sellerSku)).toEqual(["TEE-M", "TEE-L", "NAS-BL"]);
    expect(groupTargets(products, ["fridge"], { all: true }).targets.map((p) => p.sellerSku)).toEqual(["HIS-205", "LG-250"]);
  });

  it("the feed carries every product", async () => {
    const products = productsFromCatalog({ products: catalog }, "GH");
    await sendLiveChanges("t", products.slice(0, 2), { kind: "status", active: true }, { country: "GH", currency: "GHS" });
    expect((writes()[0].body as { products: unknown[] }).products).toHaveLength(2);
  });

  it("the worker reads one feed once, and tells only the products Jumia refused", async () => {
    db.tables.whatsapp_connections = [{ user_id: USER, phone_number: PHONE }];
    const old = new Date(Date.now() - 5 * 60_000).toISOString();
    const row = (id: string, sku: string, name: string) => ({
      id, user_id: USER, group_id: "g1", product_sid: id, seller_sku: sku, name, change: { kind: "stock", stock: 10 }, status: "sent",
      feed_id: "feed-0001", created_at: old, updated_at: old,
    });
    db.tables.jumia_product_changes = [row(FRIDGE, "HIS-205", "Hisense 205L Double Door Fridge"), row(BLENDER, "NAS-BL", "Nasco Blender 1.5L")];
    db.tables.jumia_products = [];
    feed = {
      status: "FINISHED", failed: 1, errors: [],
      raw: { feedItems: [{ status: "SUCCESS", sellerSKU: "HIS-205" }, { status: "FAILED", sellerSKU: "NAS-BL", errorMessage: "Stock can't be updated for a rejected product" }] },
    };
    expect(feedItemResults(feed.raw).get("NAS-BL")).toEqual({ failed: true, error: "Stock can't be updated for a rejected product" });
    await runShopNotices(new Date());
    expect(feedReads).toBe(1);
    expect(db.tables.jumia_product_changes.map((r) => r.status)).toEqual(["done", "failed"]);
    expect(sent.filter((m) => m.body.includes("didn't apply"))).toEqual([
      { kind: "text", body: "⚠️ Jumia didn't apply the change to *Nasco Blender 1.5L* (stock to 10): Stock can't be updated for a rejected product" },
    ]);
  });

  it("\"is the drone live?\": on or off, quality check, price, stock, read fresh", async () => {
    await answerProductInfo(USER, PHONE, "blender");
    expect(last().body).toBe([
      "⚪ *Nasco Blender 1.5L* · SKU NAS-BL",
      "• Status: on (shown on Jumia)",
      "• Quality check: rejected: Poor image quality",
      "• Price: GHS 4,500",
      "• Stock: 7 left",
    ].join("\n"));
    expect(calls.some((c) => c.path === "/catalog/products" && c.query.get("sellerSku") === "NAS-BL")).toBe(true);
    await answerProductInfo(USER, PHONE, "Hisense fridge");
    expect(last().body.startsWith("🟢 *Hisense 205L Double Door Fridge*")).toBe(true);
  });

  it("fees: commission by its category, the shipping contribution, what they receive", async () => {
    db.tables.jumia_categories = [{ code: 1004141, name: "Blenders", path: "Home & Office > Home & Kitchen > Kitchen & Dining > Small Appliances > Blenders" }];
    await answerFees(USER, PHONE, "Hisense fridge", 300);
    expect(last()).toMatchObject({ kind: "cta" });
    expect(last().body).toContain("🧮 *Hisense 205L Double Door Fridge* sold at GHS 300:");
    expect(last().body).toContain("• Jumia commission (Small Appliances, 12%): GHS 36");
    expect(last().body).toContain("• Shipping contribution when you ship it yourself: GHS 18");
    expect(last().body).toContain("• You receive about *GHS 246*");
    // At its own price when none is given.
    await answerFees(USER, PHONE, "Hisense fridge", null);
    expect(last().body).toContain("sold at GHS 4,500:");
  });

  it("fees need their pack, and a category the table has", async () => {
    db.tables.jumia_categories = [{ code: 1004141, name: "Hard Hats", path: "Industrial & Scientific > Hard Hats" }];
    await answerFees(USER, PHONE, "blender", null);
    expect(last().body).toContain("I couldn't match *Nasco Blender 1.5L*'s Jumia category (Hard Hats) to Jumia's fee table.");
    off.add("fee_calc_whatsapp");
    await answerFees(USER, PHONE, "blender", null);
    expect(last().body).toBe("Jumia's fees on WhatsApp come with the Pro pack.");
  });

  it("a Jumia category to the fee table's", () => {
    const gh = COUNTRY_FEES.GH;
    expect(feeCategoryForPath(gh, "Home & Office > Home & Kitchen > Kitchen & Dining > Small Appliances > Coffee, Tea & Espresso Appliances > Electric Kettles")?.name).toBe("Kettles");
    expect(feeCategoryForPath(gh, "Phones & Tablets > Tablets > Android Tablets")?.name).toBe("Tablets");
    expect(feeCategoryForPath(gh, "Fashion > Men's Fashion > Shoes > Athletic > Sport Sandals & Slides")?.name).toBe("Fashion");
    expect(feeCategoryForPath(gh, "Industrial & Scientific > Material Handling Products > Casters")).toBeNull();
  });

  it("several statuses, each read on its own", async () => {
    orders = [{ id: "o1", number: 355926919, status: "CANCELED", createdAt: "2026-10-06 10:00:00", totalAmountLocal: { value: "120", currency: "GHS" } }];
    await answerSales(USER, PHONE, "yesterday", ["READY_TO_SHIP", "CANCELED"]);
    const reads = calls.filter((c) => c.path === "/orders").map((c) => c.query.get("status"));
    expect(reads).toEqual(["READY_TO_SHIP", "CANCELED"]);
    expect(last().body).toContain("📦 1 ready to ship Jumia order yesterday");
    expect(last().body).toContain("📦 1 cancelled Jumia order yesterday");
  });

  it("the last 90 days", () => {
    expect(periodStart("quarter", "Africa/Accra", new Date("2026-10-07T10:00:00Z"))).toBe("2026-07-10");
  });
});
