/**
 * Shop research (lib/whatsapp/shop-research.ts; owner, 2026-10-08: "let it be
 * able to make a number of Different API calls to the vendor shop and get
 * info and data and organize them to fit the sellers request"). Jumia's
 * answers follow the shapes in its spec (vendorcenter.jumia.com/api-docs).
 */

import { FakeDb } from "./helpers/fake-supabase";

let db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({ createServerClient: () => db }));
jest.mock("@/lib/jumia/oauth", () => ({ JUMIA_API_BASE: "https://vendor-api.jumia.com" }));
jest.mock("@/lib/jumia/api", () => ({
  COUNTRY_CURRENCY: { GH: "GHS" },
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
let aiAnswer: string | Error = "";
const aiPrompts: string[] = [];
jest.mock("@/lib/ai/gemini-client", () => ({
  callGeminiBackend: async (_m: string, parts: { text?: string }[]) => {
    aiPrompts.push(parts.map((p) => p.text ?? "").join("\n"));
    if (aiAnswer instanceof Error) throw aiAnswer;
    return { text: aiAnswer };
  },
}));

const sent: string[] = [];
const richSent: { blocks: unknown[] }[] = [];
jest.mock("@/lib/whatsapp/client", () => ({
  LIST_MAX_ROWS: 10,
  sendTextIfConfigured: async (_to: string, body: string) => { sent.push(body); },
  // An answer laid out for the page (lib/whatsapp/rich.ts): its text, as sent.
  sendRichIfConfigured: async (_to: string, body: string, rich: { blocks: unknown[] }) => { sent.push(body); richSent.push(rich); },
  sendButtonsIfConfigured: async (_to: string, body: string) => { sent.push(body); },
  sendListIfConfigured: async (_to: string, body: string) => { sent.push(body); },
  sendCtaUrlIfConfigured: async (_to: string, body: string) => { sent.push(body); },
  sendButtonsWithDocumentIfConfigured: async () => {},
  sendTemplateIfConfigured: async () => {},
}));

import {
  answerMore, answerResearch, dayText, groupProducts, numbersBacked, parseNeeds, productLine, sortGroups, type ResearchNeed,
} from "@/lib/whatsapp/shop-research";
import { _resetBillingModeCache } from "@/lib/billing/mode";
import type { ShopProduct } from "@/lib/jumia/shop";

const USER = "seller";
const PHONE = "web:seller";

/** A product set as GET /catalog/products returns it. */
const set = (id: string, name: string, createdAt: string, variations: { id: string; sku: string; variation?: string; price?: number; status?: string; qc?: string }[]) => ({
  id: `set-${id}`, name, createdAt, brand: { name: "Generic" }, category: { code: 1000 },
  images: [{ url: `https://img/${id}.jpg`, primary: true }],
  variations: variations.map((v) => ({
    id: v.id, sellerSku: v.sku, variation: v.variation ?? "...",
    globalPrice: { currency: "USD", value: 9 },
    businessClients: [{ code: "jumia-gh", sku: `JM-${v.sku}`, status: v.status ?? "ACTIVE", visible: true, qc: { status: v.qc ?? "APPROVED" },
      price: { localValue: v.price ?? 100, localCurrency: "GHS", salePrice: null } }],
  })),
});

let catalog: ReturnType<typeof set>[] = [];
let stock: Record<string, number> = {};
let orders: Record<string, unknown>[] = [];
let orderItems: Record<string, Record<string, unknown>[]> = {};
const calls: { method: string; path: string; query: URLSearchParams }[] = [];

beforeEach(() => {
  db = new FakeDb();
  sent.length = 0;
  calls.length = 0;
  aiPrompts.length = 0;
  aiAnswer = "";
  _resetBillingModeCache();
  catalog = [
    set("w", "Kinky Curly Wig", "2026-10-08T08:00:00Z", [{ id: "w1", sku: "WIG-1", price: 450 }]),
    set("b", "Baby Bodysuit", "2026-10-07T12:00:00Z", [
      { id: "b1", sku: "BOD-S", variation: "S", price: 130 }, { id: "b2", sku: "BOD-M", variation: "M", price: 130 }, { id: "b3", sku: "BOD-L", variation: "L", price: 150 },
    ]),
    set("e", "Gold Tone Earrings", "2026-09-01T09:00:00Z", [{ id: "e1", sku: "EAR-1", price: 60, status: "INACTIVE", qc: "REJECTED" }]),
  ];
  stock = { w1: 4, b1: 2, b2: 0, b3: 5, e1: 10 };
  orders = [];
  orderItems = {};
  global.fetch = jest.fn(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ method: init?.method ?? "GET", path: url.pathname, query: url.searchParams });
    let out: unknown = {};
    if (url.pathname === "/catalog/products") {
      const size = Number(url.searchParams.get("size") ?? 100);
      const sorted = url.searchParams.get("latestFirst") === "true" ? catalog : [...catalog].reverse();
      out = { products: sorted.slice(0, size), isLastPage: true };
    } else if (url.pathname === "/catalog/stock") {
      out = { products: Object.entries(stock).map(([id, n]) => ({ id, globalStock: n })), isLastPage: true };
    } else if (url.pathname === "/orders") out = { orders, nextToken: null, isLastPage: true };
    else if (url.pathname === "/orders/items") out = url.searchParams.getAll("orderId").map((id) => ({ orderId: id, items: orderItems[id] ?? [] }));
    else if (url.pathname === "/payout-statement") out = { statements: [] };
    return new Response(JSON.stringify(out), { status: 200 });
  }) as unknown as typeof fetch;
});

const newest = (limit = 10): ResearchNeed => ({ source: "products", sort: "newest", filter: "all", words: null, limit, since: null });
const reads = () => calls.filter((c) => c.method !== "GET");

describe("reading the newest products", () => {
  it("asks Jumia for the newest, with their stock, and nothing is changed", async () => {
    aiAnswer = "*Your 3 newest products*\n• Kinky Curly Wig · GHS 450 · 4 in stock · added 8 Oct\n• Baby Bodysuit · GHS 130 to GHS 150 · 7 in stock · added 7 Oct\n• Gold Tone Earrings · GHS 60 · OFF, rejected · added 1 Sept";
    const outcome = await answerResearch(USER, PHONE, "the full list of the last 10products uploaded on my shop", [newest(10)]);
    const page = calls.find((c) => c.path === "/catalog/products")!;
    expect(page.query.get("latestFirst")).toBe("true");
    expect(page.query.get("size")).toBe("40");
    expect(calls.some((c) => c.path === "/catalog/stock")).toBe(true);
    expect(reads()).toHaveLength(0);
    expect(outcome).toBe("research products: answered");
    expect(sent[sent.length - 1]).toBe(`${aiAnswer}\n\n_Read from Jumia just now._`);
    // The AI wrote it from the data, which it was given in full.
    expect(aiPrompts[0]).toContain('The seller asked: "the full list of the last 10products uploaded on my shop"');
    expect(aiPrompts[0]).toContain("• Baby Bodysuit (3 variations: S, M, L) · GHS 130 to GHS 150 · 7 in stock · ON, approved · added 7 Oct · SKU BOD-S");
    expect(aiPrompts[0]).toContain("• Gold Tone Earrings · GHS 60 · 10 in stock · OFF, rejected · added 1 Sept · SKU EAR-1");
  });

  it("remembers the products it listed, so \"those\" and \"the last 10\" mean them", async () => {
    db.tables.whatsapp_sessions = [{ phone_number: PHONE, user_id: USER, state: "awaiting_count" }];
    aiAnswer = new Error("down");
    await answerResearch(USER, PHONE, "my 2 newest products", [newest(2)]);
    const listed = (db.tables.whatsapp_sessions[0] as { last_listed: { sids: string[]; what: string } }).last_listed;
    expect(listed.sids).toEqual(["w1", "b1", "b2", "b3"]);
    expect(listed.what).toBe("The 2 newest products in the Jumia shop, newest first");
  });

  it("sends the data itself when the AI's answer has a figure that isn't in it", async () => {
    aiAnswer = "Your newest product is the Kinky Curly Wig at GHS 499, with 40 in stock.";
    const outcome = await answerResearch(USER, PHONE, "my newest products", [newest(2)]);
    expect(outcome).toBe("research products: data sent");
    const msg = sent[sent.length - 1];
    expect(msg).toContain("*The 2 newest products in the Jumia shop, newest first*");
    expect(msg).toContain("• Kinky Curly Wig · GHS 450 · 4 in stock · ON, approved · added 8 Oct · SKU WIG-1");
    expect(msg).not.toContain("499");
  });

  it("shows as many products as asked, whatever Jumia's page counts", async () => {
    aiAnswer = new Error("down");
    await answerResearch(USER, PHONE, "my 2 newest products", [newest(2)]);
    expect(calls.find((c) => c.path === "/catalog/products")!.query.get("size")).toBe("8");
    const msg = sent[sent.length - 1];
    expect(msg).toContain("Kinky Curly Wig");
    expect(msg).toContain("Baby Bodysuit");
    expect(msg).not.toContain("Gold Tone Earrings");
  });

  it("sends the data itself when the AI can't be reached", async () => {
    aiAnswer = new Error("timeout");
    await answerResearch(USER, PHONE, "my newest products", [newest(1)]);
    expect(sent[sent.length - 1]).toContain("• Kinky Curly Wig · GHS 450");
    expect(sent[sent.length - 1]).not.toContain("Bodysuit");
  });
});

describe("several reads in one answer", () => {
  it("products by price from the shop's copy, and orders with their items", async () => {
    orders = [
      { id: "o1", number: "355926919", status: "Delivered", totalItems: 2, packedItems: 2, hasItemsFulfilledByJumia: false, createdAt: "2026-10-07 10:00:00", totalAmountLocal: { currency: "GHS", value: 580 } },
      { id: "o2", number: "355926920", status: "Canceled", totalItems: 1, packedItems: 0, hasItemsFulfilledByJumia: false, createdAt: "2026-10-08 07:00:00", totalAmountLocal: { currency: "GHS", value: 130 } },
    ];
    orderItems = {
      o1: [{ id: "i1", status: "DELIVERED", product: { name: "Kinky Curly Wig", sellerSku: "WIG-1" } }, { id: "i2", status: "DELIVERED", product: { name: "Baby Bodysuit", sellerSku: "BOD-S" } }],
      o2: [{ id: "i3", status: "CANCELED", product: { name: "Baby Bodysuit", sellerSku: "BOD-M" } }],
    };
    aiAnswer = "Nothing useful";   // too short to use: the data goes out
    await answerResearch(USER, PHONE, "my priciest products and this week's orders with what was in them", [
      { source: "products", sort: "price_high", filter: "active", words: null, limit: 5, since: null },
      { source: "orders", period: "week", status: null, limit: 15 },
    ]);
    // Two reads: the seller is told it's looking.
    expect(sent[0]).toBe("🔎 Looking through your Jumia shop…");
    const msg = sent[sent.length - 1];
    expect(msg).toContain("*Products ON, highest price first: all 2 (the shop has 3 in all)*\n• Kinky Curly Wig · GHS 450");
    expect(msg).toContain("*Orders in the last 7 days: 2 (the newest 2 below)*");
    expect(msg).toContain("By status: Delivered 1, Cancelled 1");
    expect(msg).toContain("Value of those not cancelled: GHS 580");
    expect(msg).toContain("• #355926919 · 7 Oct · Delivered · GHS 580 · Kinky Curly Wig, Baby Bodysuit");
    expect(reads()).toHaveLength(0);
  });

  it("products matching the seller's words, least stock first", async () => {
    aiAnswer = new Error("down");
    await answerResearch(USER, PHONE, "stock of the bodysuit", [{ source: "products", sort: "stock_low", filter: "all", words: "bodysuit", limit: 10, since: null }]);
    expect(sent[sent.length - 1]).toContain("*Products matching \"bodysuit\", least stock first: all 1 (the shop has 3 in all)*");
  });
});

describe("the pieces", () => {
  const row = (p: Partial<ShopProduct>): ShopProduct => ({
    sid: "s", setSid: null, sellerSku: "SKU", name: "Thing", variation: null, brand: null, categoryCode: null, createdAt: null, status: "ACTIVE",
    visible: true, qcStatus: "APPROVED", qcReason: null, price: 10, salePrice: null, saleStart: null, saleEnd: null, currency: "GHS", imageUrl: null,
    stock: 1, ...p,
  });

  it("puts a product's variations together, and leaves out deleted ones", () => {
    const groups = groupProducts([
      row({ sid: "a", setSid: "A", variation: "S", price: 10, stock: 1 }),
      row({ sid: "b", setSid: "A", variation: "M", price: 12, stock: 0, salePrice: 9, saleEnd: "2099-01-01" }),
      row({ sid: "c", setSid: "C", status: "DELETED" }),
    ], "2026-10-08");
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ variations: ["S", "M"], price: 10, maxPrice: 12, salePrice: 9, stock: 1 });
    const line = productLine(groups[0], (n) => `GHS ${n}`, "UTC");
    expect(line).toBe("• Thing (2 variations: S, M) · GHS 10 to GHS 12 (on sale at GHS 9) · 1 in stock · ON, approved · SKU SKU");
  });

  it("sorts with unknown values last", () => {
    const g = groupProducts([
      row({ sid: "a", name: "A", stock: null }), row({ sid: "b", name: "B", stock: 5 }), row({ sid: "c", name: "C", stock: 0 }),
    ], "2026-10-08");
    expect(sortGroups(g, "stock_low").map((x) => x.name)).toEqual(["C", "B", "A"]);
    expect(sortGroups(g, "stock_high").map((x) => x.name)).toEqual(["B", "C", "A"]);
  });

  it("dates as the seller reads them", () => {
    const now = new Date("2026-10-08T12:00:00Z");
    expect(dayText("2026-10-07 23:30:00", "Africa/Accra", now)).toBe("7 Oct");
    expect(dayText("2025-12-24T10:00:00Z", "Africa/Accra", now)).toBe("24 Dec 2025");
    expect(dayText(null, "UTC", now)).toBe("");
  });

  it("checks every figure in the answer is in the data or the question", () => {
    const data = "• Wig · GHS 1,450 · 4 in stock · added 8 Oct · SKU WIG-2026";
    expect(numbersBacked("The wig is GHS 1450 with 4 left (8 Oct).", data, "my newest")).toBe(true);
    expect(numbersBacked("Your top 3: the wig at GHS 1,450.00", data, "my newest")).toBe(true);
    expect(numbersBacked("The wig is GHS 1,500", data, "my newest")).toBe(false);
    expect(numbersBacked("You have 40 wigs", data, "do I have 40 wigs")).toBe(true);
    expect(numbersBacked(`The wig, added 8 Oct ${new Date().getUTCFullYear()}`, data, "my newest")).toBe(true);
  });

  it("reads the AI's needs: known sources, their own words, at most four", () => {
    const check = { backed: (w: string) => w === "wigs", asStatus: (v: unknown) => (v === "cancelled" ? "CANCELED" : null) };
    expect(parseNeeds([
      { source: "catalog", sort: "cheapest", words: "wigs", limit: 0 },
      { source: "orders", status: "cancelled", period: "ever" },
      { source: "sales", period: "today" },
      { source: "listings" },
      { source: "payouts" },
    ], check)).toEqual([
      { source: "products", sort: "newest", filter: "all", words: "wigs", limit: 10, since: null },
      { source: "orders", period: "quarter", status: "CANCELED", limit: 15 },
      { source: "sales_summary", period: "today" },
      { source: "pandaworld_listings", period: "month" },
    ]);
    expect(parseNeeds("not a list", check)).toEqual([]);
  });
});


describe("a long list, 30 at a time (owner's web chat, 2026-10-08: \"give me the stock for all the 278 on products\")", () => {
  beforeEach(() => {
    catalog = Array.from({ length: 35 }, (_, i) => set(`k${i}`, `Kettle number ${i + 1}`, `2026-09-${String((i % 28) + 1).padStart(2, "0")}T08:00:00Z`, [{ id: `k${i}`, sku: `KET-${i + 1}`, price: 100 + i }]));
    stock = Object.fromEntries(catalog.map((_, i) => [`k${i}`, i + 1]));
    db.tables.whatsapp_sessions = [{ phone_number: PHONE, user_id: USER, state: "awaiting_count" }];
    aiAnswer = new Error("down");
  });
  const onByStock = (limit = 30): ResearchNeed => ({ source: "products", sort: "stock_low", filter: "active", words: null, limit, since: null });

  it("says how many there are and that \"more\" shows the next, then shows them", async () => {
    expect(await answerResearch(USER, PHONE, "give me the stock for all my on products", [onByStock()])).toBe("research products: data sent (more to show)");
    expect(sent.at(-1)).toContain("That's 30 of 35. Say *more* for the next 30.");
    expect(sent.at(-1)).toContain("• Kettle number 30 ·");
    expect(sent.at(-1)).not.toContain("• Kettle number 31 ·");
    const listed = (db.tables.whatsapp_sessions[0] as { last_listed: { next: { need: { offset: number }; request: string } } }).last_listed;
    expect(listed.next).toMatchObject({ need: { offset: 30 }, request: "give me the stock for all my on products" });

    expect(await answerMore(USER, PHONE, listed as never, "more")).toBe(true);
    expect(sent.at(-1)).toContain("31 to 35 of 35");
    expect(sent.at(-1)).toContain("• Kettle number 35 ·");
    expect(sent.at(-1)).not.toContain("Say *more*");
    // Nothing more after the last page, and "more" with nothing listed is the AI's.
    const after = (db.tables.whatsapp_sessions[0] as { last_listed: { next?: unknown } }).last_listed;
    expect(after.next).toBeUndefined();
    expect(await answerMore(USER, PHONE, after as never, "more")).toBe(false);
  });

  it("a short list asked for doesn't offer more", async () => {
    expect(await answerResearch(USER, PHONE, "my 3 lowest in stock", [onByStock(3)])).toBe("research products: data sent");
    expect(sent.at(-1)).not.toContain("Say *more*");
  });
});
