/**
 * The chat's commands (owner, 2026-10-07): the words, image polish (from
 * the note or "polish 2", 2 credits an image) and the shop health report
 * (2 credits).
 */

import { FakeDb } from "./helpers/fake-supabase";

let db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({ createServerClient: () => db }));
let billingOn = true;
jest.mock("@/lib/billing/mode", () => ({ isBillingEnabled: async () => billingOn }));
jest.mock("@/lib/auth/is-admin", () => ({ isAdmin: () => false }));

type Sent = { kind: string; to: string; body?: string; link?: string; rows?: { id: string }[] };
const sent: Sent[] = [];
jest.mock("@/lib/whatsapp/client", () => ({
  LIST_MAX_ROWS: 10,
  sendTextIfConfigured: async (to: string, body: string) => { sent.push({ kind: "text", to, body }); },
  sendCtaUrlIfConfigured: async (to: string, body: string) => { sent.push({ kind: "cta", to, body }); },
  sendImageIfConfigured: async (to: string, link: string, body?: string) => { sent.push({ kind: "image", to, link, body }); },
  sendListIfConfigured: async (to: string, body: string, _b: string, rows: { id: string }[]) => { sent.push({ kind: "list", to, body, rows }); },
  sendButtonsIfConfigured: async (to: string, body: string) => { sent.push({ kind: "buttons", to, body }); },
}));

let shots: { id: string; label: string; url?: string; error?: string }[] = [];
const generated: number[] = [];
jest.mock("@/lib/gemini-image", () => ({
  PRODUCT_SHOTS: [{ id: "main" }, { id: "angle" }, { id: "lifestyle" }, { id: "detail" }],
  isGeminiImageEnabled: () => true,
  generateProductShots: async (sources: unknown[]) => { generated.push(sources.length); return shots; },
}));
jest.mock("@/lib/extension/harvested-images", () => ({ resolveOneImage: async () => ({ base64: "AAAA", mimeType: "image/jpeg" }) }));
jest.mock("@/lib/jumia/push-listing", () => ({ chatAddressFor: async () => "233200000000" }));

import { parseGlobalCommand } from "@/lib/whatsapp/commands";
import { polishListing, polishOnRequest, polishQueue, queuePolish, POLISH_COST } from "@/lib/whatsapp/chat-polish";
import { healthEvidence, healthScore, plainReading, evidenceText } from "@/lib/whatsapp/shop-health";
import { MENU_ROWS, runChatCommand } from "@/lib/whatsapp/chat-commands";
import { notesAskForPolish, verifyNoteIntent } from "@/lib/whatsapp/note-intent";
import type { WhatsAppSession } from "@/lib/whatsapp/session";
import type { ShopProduct } from "@/lib/jumia/shop";

const PHONE = "233200000000";
const balance = () => Number(db.tables.extension_credits[0].balance);
const listing = (patch: Record<string, unknown> = {}) => ({
  id: "l1", user_id: "seller", whatsapp_seq: 2, whatsapp_batch_id: "b1", title: "Kettle", user_prompt: "polish the photos", status: "draft",
  images: ["https://cdn.test/a.jpg", "https://cdn.test/b.jpg"], original_images: null, chat_channel: null,
  polish_status: null, polish_requested_at: null, ...patch,
});

beforeEach(() => {
  db = new FakeDb();
  db.tables.extension_credits = [{ user_id: "seller", balance: 20 }];
  db.tables.extension_credit_transactions = [];
  db.tables.listings = [listing()];
  billingOn = true;
  sent.length = 0;
  generated.length = 0;
  shots = [
    { id: "main", label: "Main image", url: "https://cdn.test/main.png" },
    { id: "angle", label: "Angle", url: "https://cdn.test/angle.png" },
    { id: "lifestyle", label: "Lifestyle", error: "timed out" },
    { id: "detail", label: "Detail", url: "https://cdn.test/detail.png" },
  ];
});

describe("the words", () => {
  it("reads the chat's commands", () => {
    expect(parseGlobalCommand("menu")).toEqual({ type: "menu" });
    expect(parseGlobalCommand("/")).toEqual({ type: "menu" });
    expect(parseGlobalCommand("polish 2")).toEqual({ type: "polish", seq: 2 });
    expect(parseGlobalCommand("polish product 3 photos")).toEqual({ type: "polish", seq: 3 });
    expect(parseGlobalCommand("polish")).toEqual({ type: "polish", seq: null });
    expect(parseGlobalCommand("report")).toEqual({ type: "report" });
    expect(parseGlobalCommand("shop health check")).toEqual({ type: "report" });
    expect(parseGlobalCommand("credits")).toEqual({ type: "credits" });
    expect(parseGlobalCommand("sales week")).toEqual({ type: "shop_read", what: "sales_week" });
    expect(parseGlobalCommand("out of stock")).toEqual({ type: "shop_read", what: "out_of_stock" });
    expect(parseGlobalCommand("polished steel kettle")).toBeNull();
  });

  it("the WhatsApp menu is one list of at most 10 rows, each its command's words", async () => {
    expect(MENU_ROWS.length).toBeLessThanOrEqual(10);
    for (const r of MENU_ROWS) expect(parseGlobalCommand(r.id) ?? r.id).not.toBeNull();
    await runChatCommand({ type: "menu" }, "seller", PHONE, {} as WhatsAppSession);
    expect(sent[0].kind).toBe("list");
    expect(sent[0].body).toContain("*polish 2*");
  });
});

describe("polish from the seller's note", () => {
  it("a note that asks for it, in their own words, is read; one that doesn't isn't", () => {
    const asked = verifyNoteIntent({ polish_images: { value: true, quote: "polish the photos" } }, "300 cedis, polish the photos please");
    expect(asked.intent.polish_images).toEqual({ value: true, quote: "polish the photos" });
    const made = verifyNoteIntent({ polish_images: { value: true, quote: "polished steel" } }, "polished steel kettle, 300");
    expect(made.intent.polish_images).toBeUndefined();
    expect(notesAskForPolish("put it on a white background")).toBe(true);
    expect(notesAskForPolish("nice picture frame")).toBe(false);
  });

  it("is queued once, and polished by the worker: 2 credits an image that came back, new photos first", async () => {
    expect(await queuePolish("l1")).toBe(true);
    expect(await queuePolish("l1")).toBe(false);
    expect(await polishQueue(2)).toEqual(["l1"]);
    expect(await polishListing("l1")).toBe("done");
    const row = db.tables.listings[0];
    expect(row.polish_status).toBe("done");
    expect(row.images).toEqual(["https://cdn.test/main.png", "https://cdn.test/angle.png", "https://cdn.test/detail.png", "https://cdn.test/a.jpg", "https://cdn.test/b.jpg"]);
    expect(row.original_images).toEqual(["https://cdn.test/a.jpg", "https://cdn.test/b.jpg"]);
    expect(balance()).toBe(20 - 3 * 2);
    // On WhatsApp, the main photo with the caption (each photo is a paid message there).
    const images = sent.filter((m) => m.kind === "image");
    expect(images).toHaveLength(1);
    expect(images[0].body).toContain("Product 2: 3 polished photos (main image, angle, detail), 6 credits.");
    // Run again: nothing claimed, nothing charged.
    expect(await polishListing("l1")).toBe("busy");
    expect(balance()).toBe(14);
  });

  it("not enough credits: their own photos stay, nothing is made or charged", async () => {
    db.tables.extension_credits[0].balance = POLISH_COST - 1;
    await queuePolish("l1");
    expect(await polishListing("l1")).toBe("skipped");
    expect(generated).toHaveLength(0);
    expect(db.tables.listings[0].images).toEqual(["https://cdn.test/a.jpg", "https://cdn.test/b.jpg"]);
    expect(sent.pop()?.body).toContain(`makes 4 images at 2 credits each (8), and you have 7`);
  });

  it("nothing came back: nothing charged", async () => {
    shots = shots.map((s) => ({ id: s.id, label: s.label, error: "down" }));
    await queuePolish("l1");
    expect(await polishListing("l1")).toBe("failed");
    expect(balance()).toBe(20);
  });

  it("a product already with Jumia isn't polished", async () => {
    db.tables.listings = [listing({ status: "pending_approval" })];
    await queuePolish("l1");
    expect(await polishListing("l1")).toBe("skipped");
    expect(generated).toHaveLength(0);
  });
});

describe("polish 2", () => {
  const session = { batchId: "b1", lastSubmittedBatchId: null } as unknown as WhatsAppSession;

  it("polishes that product of the batch now, and can be asked again after a failure", async () => {
    db.tables.listings = [listing({ polish_status: "failed" })];
    await runChatCommand({ type: "polish", seq: 2 }, "seller", PHONE, session);
    expect(db.tables.listings[0].polish_status).toBe("done");
    expect(sent.some((m) => m.body?.startsWith("✨ Polishing Product 2's photos"))).toBe(true);
  });

  it("asks which product when the batch has several and no number was given", async () => {
    db.tables.listings = [listing(), listing({ id: "l2", whatsapp_seq: 1 })];
    await runChatCommand({ type: "polish", seq: null }, "seller", PHONE, session);
    expect(sent[0].body).toContain("Which product?");
    expect(generated).toHaveLength(0);
  });

  it("the only product needs no number", async () => {
    expect(await polishOnRequest("seller", PHONE, "l1")).toBe("done");
  });
});

describe("the shop health report", () => {
  const p = (patch: Partial<ShopProduct>): ShopProduct => ({
    sid: "s", setSid: null, sellerSku: "SKU", name: "Thing", variation: null, brand: null, categoryCode: null, createdAt: null,
    status: "ACTIVE", visible: true, qcStatus: "approved", qcReason: null, price: 100, salePrice: null, saleStart: null, saleEnd: null,
    currency: "GHS", imageUrl: null, stock: 10, ...patch,
  });
  const now = Date.parse("2026-10-07T12:00:00Z");
  const day = 86_400_000;

  it("counts the evidence from the catalog, orders and payouts", () => {
    const products = [
      p({ sellerSku: "A", name: "Kettle", stock: 2 }),
      p({ sellerSku: "B", name: "Blender", stock: 0 }),
      p({ sellerSku: "C", name: "Iron", status: "INACTIVE" }),
      p({ sellerSku: "D", name: "Fan", qcStatus: "rejected" }),
    ];
    const orders = [{ createdAt: new Date(now - 5 * day).toISOString() }, { createdAt: new Date(now - 40 * day).toISOString() }];
    const item = (sku: string, status: string, price: number) => ({ id: sku + status, status, paidPriceLocal: price, product: { sellerSku: sku, name: sku === "A" ? "Kettle" : "Blender" }, country: { currencyCode: "GHS" } });
    const items = [item("A", "delivered", 100), item("A", "delivered", 100), item("A", "returned", 100), item("B", "canceled", 50)];
    const payouts = [{ number: "1", paid: true, amount: 180, currency: "GHS", feesTotal: -20, itemRevenue: 200 } as never];
    const e = healthEvidence(products, orders, items as never, false, payouts, [{ status: "live" }, { status: "rejected" }], now);
    expect(e.catalog).toMatchObject({ total: 4, active: 3, inactive: 1, qcRejected: 1, outOfStock: 1, lowStock: 1 });
    expect(e.orders).toMatchObject({ orders: 2, last30: 1, previous60: 1, sold: 2, revenue: 200, returned: 1, cancelled: 1, returnRate: 25, cancelRate: 25 });
    expect(e.best[0]).toEqual({ name: "Kettle", sold: 2, revenue: 200 });
    expect(e.noSale.count).toBe(2); // Blender and Fan are on and sold nothing
    expect(e.runningOut).toEqual([]); // 2 left at 2 sold in 90 days: about 90 days
    const fast = healthEvidence([p({ sellerSku: "A", name: "Kettle", stock: 1 })], orders, Array.from({ length: 30 }, () => item("A", "delivered", 100)) as never, false, [], [], now);
    expect(fast.runningOut[0]).toEqual({ name: "Kettle", stock: 1, days: 3 });
    expect(e.payouts).toMatchObject({ paid: 1, paidTotal: 180, feeShare: 10 });
    expect(e.pandaworld).toEqual({ listed90: 2, live90: 1, rejected90: 1 });

    const { score } = healthScore(e);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(100);
    const text = evidenceText(e, score);
    expect(text).toContain(`🩺 *Shop health: ${score}/100*`);
    expect(text).toContain("Cancelled 25% · returned 25%");
    expect(plainReading(e)).toContain("Fix the 1 product Jumia's quality check rejected");
  });

  it("isn't read without the credits for it", async () => {
    db.tables.extension_credits[0].balance = 1;
    await runChatCommand({ type: "report" }, "seller", PHONE, {} as WhatsAppSession);
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain("The shop health report costs 2 credits, and you have 1.");
  });
});
