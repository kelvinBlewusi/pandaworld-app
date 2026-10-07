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

type Sent = { kind: string; to: string; body?: string; link?: string; links?: string[]; rows?: { id: string }[] };
const sent: Sent[] = [];
jest.mock("@/lib/whatsapp/client", () => ({
  LIST_MAX_ROWS: 10,
  sendTextIfConfigured: async (to: string, body: string) => { sent.push({ kind: "text", to, body }); },
  sendCtaUrlIfConfigured: async (to: string, body: string) => { sent.push({ kind: "cta", to, body }); },
  sendImageIfConfigured: async (to: string, link: string, body?: string) => { sent.push({ kind: "image", to, link, body }); },
  sendImagesIfConfigured: async (to: string, links: string[], body?: string) => { sent.push({ kind: "image", to, link: links[0], body, links }); },
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
import { endsWithDoneSignal } from "@/lib/whatsapp/draft";
import { helpFor, sendQueuedHelp } from "@/lib/whatsapp/help";
import { looksLikeBrokenClientId } from "@/lib/jumia/self-auth";
import { PALETTE, matchingCommands, slashCommand, slashToText, unfinishedFill } from "@/components/assistant/chat-commands";
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

describe("what the owner's web test showed (2026-10-07)", () => {
  it("reads the ways a seller asks for their credits", () => {
    for (const t of ["remaining credit", "Remaining credits", "credits left", "how many credits do i have", "check my credits", "my balance", "what's my balance"]) {
      expect(parseGlobalCommand(t)).toEqual({ type: "credits" });
    }
    expect(parseGlobalCommand("credits for product 2")).toBeNull();
  });

  it("a bare \"Change\" or \"edit\" asks what to change, never restarts", async () => {
    expect(parseGlobalCommand("Change")).toEqual({ type: "edit_help" });
    expect(parseGlobalCommand("edit on Jumia")).toEqual({ type: "edit_help" });
    expect(parseGlobalCommand("change the price of the gold medal to 500")).toBeNull();
    await runChatCommand({ type: "edit_help" }, "seller", PHONE, {} as WhatsAppSession);
    expect(sent[0].body).toContain("Say which product and what to change");
  });

  it("\"clear\": asked first on the web; the tap clears it; on WhatsApp, how to clear it on the phone", async () => {
    expect(parseGlobalCommand("clear my chat")).toEqual({ type: "clear", step: "ask" });
    expect(parseGlobalCommand("clear chat now")).toEqual({ type: "clear", step: "now" });
    expect(parseGlobalCommand("keep chat")).toEqual({ type: "clear", step: "keep" });
    const WEB = "web:seller";
    db.tables.whatsapp_sessions = [{ phone_number: WEB, user_id: "seller", state: "awaiting_confirmation", batch_id: "b1" }];
    await runChatCommand({ type: "clear", step: "ask" }, "seller", WEB, {} as WhatsAppSession);
    expect(sent.at(-1)).toMatchObject({ kind: "buttons" });
    expect(sent.at(-1)?.body).toContain("Clear this chat?");
    expect(db.tables.whatsapp_sessions[0].chat_cleared_at).toBeUndefined();
    await runChatCommand({ type: "clear", step: "now" }, "seller", WEB, {} as WhatsAppSession);
    expect(db.tables.whatsapp_sessions[0]).toMatchObject({ state: "awaiting_count", batch_id: null });
    expect(typeof db.tables.whatsapp_sessions[0].chat_cleared_at).toBe("string");
    sent.length = 0;
    await runChatCommand({ type: "clear", step: "ask" }, "seller", PHONE, {} as WhatsAppSession);
    expect(sent[0].body).toContain("WhatsApp keeps this chat on your phone");
  });

  it("\"dine\" alone is done; in a caption it's a word", () => {
    expect(endsWithDoneSignal("dine")).toBe(true);
    expect(endsWithDoneSignal("Dine.")).toBe(true);
    expect(endsWithDoneSignal("fine dine")).toBe(false);
    expect(endsWithDoneSignal("Price 40 done")).toBe(true);
  });

  it("\"Ghc 160\" is the price, not a sale price too", () => {
    const note = "Ghc 160\ndine";
    const read = verifyNoteIntent({
      selling_price: { value: 160, quote: "Ghc 160" },
      sale_price: { value: 160, quote: "Ghc 160" },
    }, note);
    expect(read.intent.selling_price?.value).toBe(160);
    expect(read.intent.sale_price).toBeUndefined();
    const sale = verifyNoteIntent({
      selling_price: { value: 200, quote: "200" },
      sale_price: { value: 160, quote: "sale 160" },
    }, "200, sale 160 till Friday");
    expect(sale.intent.sale_price?.value).toBe(160);
  });

  it("a Client ID cut short or with extra is neither half", () => {
    expect(looksLikeBrokenClientId("c9758cb3-8a9b-49b2-9ae5-6973aa3015c")).toBe(true);
    expect(looksLikeBrokenClientId("c9758cb3-8a9b-49b2-9ae5-6973aa3015cd")).toBe(false);
    expect(looksLikeBrokenClientId("BYQZm9Gdk16GiIuXW1K_SiwboupmDjsMj3vhSDzbous")).toBe(false);
  });

  it("the page's commands: /edit (or /change) is Edit live on Jumia, /clear asks first, no prices shown", () => {
    const edit = slashCommand("/change");
    expect(edit?.slash).toBe("edit");
    expect(edit?.title).toBe("Edit live on Jumia");
    expect(slashToText("/edit the price of the medal to 500")).toBe("Change the price of the medal to 500");
    expect(slashToText("/change stock of GEMMALL5 to 10")).toBe("Change stock of GEMMALL5 to 10");
    expect(unfinishedFill("Change")?.slash).toBe("edit");
    expect(unfinishedFill("polish")).toBeNull();
    expect(slashCommand("/clear")?.action).toBe("clear");
    expect(matchingCommands("/ed").map((c) => c.slash)).toEqual(["edit"]);
    expect(PALETTE.every((c) => !("credits" in c))).toBe(true);
  });
});

describe("help, for the seller's own pack (owner, 2026-10-07)", () => {
  it("free credits: what every plan has, and what bigger packs add", async () => {
    db.tables.extension_credits[0].balance = 9;
    const text = await helpFor("seller", PHONE);
    expect(text).toContain("on your free credits");
    expect(text).toContain("*polish 2*");
    expect(text).toContain("*Bigger packs add*");
    expect(text).toContain("Live product changes: Standard pack and up");
    expect(text).not.toContain("*On your pack*");
    expect(text).toContain("Credits: 9 available");
    expect(text).toContain("type *menu*");
  });

  it("Standard: live changes and QC are on, and named as such; the web says / and /clear", async () => {
    db.tables.extension_credit_transactions = [{ user_id: "seller", type: "purchase", amount: 210, created_at: "2026-10-01T00:00:00Z" }];
    const text = await helpFor("seller", "web:seller");
    expect(text).toContain("on your Standard pack");
    expect(text).toContain("*On your pack*");
    expect(text).toContain("set the stock of the blue kettle to 10");
    expect(text).toContain("Fee calculator in the extension: Pro pack and up");
    expect(text).toContain("type / or tap +");
    expect(text).toContain("/clear");
  });

  it("the outbox sends each named seller their help once, to their WhatsApp number", async () => {
    db.tables.app_settings = [{ key: "help_outbox", value: ["seller"] }];
    db.tables.whatsapp_connections = [{ user_id: "seller", phone_number: "+233206987692" }];
    expect(await sendQueuedHelp()).toEqual(["seller"]);
    expect(sent.at(-1)).toMatchObject({ kind: "buttons", to: "233206987692" });
    expect(sent.at(-1)?.body).toContain("Here's what you can do, on your free credits.");
    expect(db.tables.app_settings[0].value).toEqual([]);
    expect(await sendQueuedHelp()).toEqual([]);
  });

  it("polish on the web says nothing of the credits it took", async () => {
    await queuePolish("l1");
    db.tables.listings[0].chat_channel = "web";
    const push = jest.requireMock("@/lib/jumia/push-listing") as { chatAddressFor: () => Promise<string> };
    const before = push.chatAddressFor;
    push.chatAddressFor = async () => "web:seller";
    try {
      expect(await polishListing("l1")).toBe("done");
    } finally {
      push.chatAddressFor = before;
    }
    const album = sent.find((m) => m.kind === "image" && m.body);
    // On the web, every new photo in one message, an album.
    expect(album?.links).toEqual(["https://cdn.test/main.png", "https://cdn.test/angle.png", "https://cdn.test/detail.png"]);
    const caption = album?.body ?? "";
    expect(caption).toContain("3 polished photos (main image, angle, detail). They replace your own photos");
    expect(caption).not.toContain("credits");
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

  it("is queued once, and polished by the worker: 2 credits an image that came back, replacing the seller's photos", async () => {
    expect(await queuePolish("l1")).toBe(true);
    expect(await queuePolish("l1")).toBe(false);
    expect(await polishQueue(2)).toEqual(["l1"]);
    expect(await polishListing("l1")).toBe("done");
    const row = db.tables.listings[0];
    expect(row.polish_status).toBe("done");
    // The new ones replace the seller's (owner, 2026-10-07: "it must replace them entirely").
    expect(row.images).toEqual(["https://cdn.test/main.png", "https://cdn.test/angle.png", "https://cdn.test/detail.png"]);
    expect(row.original_images).toEqual(["https://cdn.test/a.jpg", "https://cdn.test/b.jpg"]);
    expect(balance()).toBe(20 - 3 * 2);
    // On WhatsApp, the main photo with the caption (each photo is a paid message there).
    const images = sent.filter((m) => m.kind === "image");
    expect(images).toHaveLength(1);
    expect(images[0].body).toContain("Product 2: 3 polished photos (main image, angle, detail), 6 credits. They replace your own photos");
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
