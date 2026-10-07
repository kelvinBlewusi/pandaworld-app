/**
 * The WhatsApp assistant (lib/whatsapp/assistant.ts): the AI only picks an
 * action, and our code checks every part of it before anything changes.
 * The review step's flows run end to end in whatsapp-intake-flow.test.ts
 * ("the assistant, on the pilot's accounts"); this covers the checks
 * themselves and the steps between batches.
 */

import { FakeDb } from "./helpers/fake-supabase";

let db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({ createServerClient: () => db }));
jest.mock("@/lib/auth/is-admin", () => ({ isAdmin: (id: string) => id === "admin" }));
let billingOn = true;
jest.mock("@/lib/billing/mode", () => ({ isBillingEnabled: async () => billingOn }));

const sent: { kind: string; body: string; rows?: string[]; button?: string; url?: string }[] = [];
jest.mock("@/lib/whatsapp/client", () => ({
  sendTextIfConfigured:    async (_to: string, body: string) => { sent.push({ kind: "text", body }); },
  sendButtonsIfConfigured: async (_to: string, body: string, b: { id: string }[]) => { sent.push({ kind: "buttons", body, rows: b.map((x) => x.id) }); },
  sendCtaUrlIfConfigured:  async (_to: string, body: string, button: string, url: string) => { sent.push({ kind: "cta", body, button, url }); },
  sendListIfConfigured:    async (_to: string, body: string, _b: string, r: { id: string }[]) => { sent.push({ kind: "list", body, rows: r.map((x) => x.id) }); },
}));

const orderCalls: string[] = [];
jest.mock("@/lib/whatsapp/orders", () => ({
  handleOrderMessage: async (_u: string, _p: string, text: string) => { orderCalls.push(text); return true; },
}));

const aiReplies: string[] = [];
const aiPrompts: string[] = [];
let aiCalls = 0;
jest.mock("@/lib/ai/gemini-client", () => ({
  callGeminiBackend: async (model: string, parts: { text?: string }[]) => {
    aiCalls++;
    aiPrompts.push(parts.map((p) => p.text ?? "").join("\n"));
    const text = aiReplies.shift();
    if (text == null) throw new Error("no AI reply scripted");
    return { text, model, backend: "vertex" };
  },
}));

const shopCalls: unknown[][] = [];
jest.mock("@/lib/whatsapp/shop", () => ({
  proposeLiveChange: async (...a: unknown[]) => { shopCalls.push(["proposeLiveChange", ...a.slice(2)]); return "offered"; },
  answerStock:       async (...a: unknown[]) => { shopCalls.push(["answerStock", ...a.slice(2)]); return "stock"; },
  answerProducts:    async (...a: unknown[]) => { shopCalls.push(["answerProducts", ...a.slice(2)]); return "overview"; },
  answerOrderStatus: async (...a: unknown[]) => { shopCalls.push(["answerOrderStatus", ...a.slice(2)]); return "order"; },
  answerSales:       async (...a: unknown[]) => { shopCalls.push(["answerSales", ...a.slice(2)]); return "sales"; },
  answerPayouts:     async (...a: unknown[]) => { shopCalls.push(["answerPayouts", ...a.slice(2)]); return "payouts"; },
  answerProductInfo: async (...a: unknown[]) => { shopCalls.push(["answerProductInfo", ...a.slice(2)]); return "info"; },
  answerFees:        async (...a: unknown[]) => { shopCalls.push(["answerFees", ...a.slice(2)]); return "fees"; },
  MAX_GROUP: 20,
}));

const SIZES = ["S", "M", "L", "XL", "XXL"];
jest.mock("@/lib/jumia/categories", () => ({
  getCategoryAttributes: async (code: number) =>
    code === 100 ? [{ name: "variation", label: "Size", type: "enum", allowed_values: SIZES, is_variant: true }] : [],
}));

import {
  answerLiveValue, assistantEnabled, assistantLinks, cleanReply, countBacked, fitsDraft, isStateQuestion, looksLikeQuestion, messageNumbers,
  namesAProduct, recentConversation, saleWindow, splitProducts, parseAction, plainQuickEdit, runAssistant, verifyChanges, type ProductFacts,
} from "@/lib/whatsapp/assistant";
import { ALLOWANCE_TOLD, DAILY_ALLOWANCE, assistantGate, dailyAllowance, dayStart } from "@/lib/whatsapp/assistant-limits";
import { parseVariations } from "@/lib/whatsapp/variation-question";
import type { ListingRow } from "@/lib/supabase/types";
import type { WhatsAppSession } from "@/lib/whatsapp/session";

const product = (seq: number, title: string, extra: Partial<ProductFacts> = {}): ProductFacts => ({
  seq, listing: { id: `l${seq}`, title, status: "draft" } as ListingRow, variations: [], options: [], ...extra,
});
const FRIDGE = product(1, "Hisense 205L Double Door Fridge");
const SHIRT  = product(2, "Men's Cotton T-Shirt", { variations: ["M"], options: SIZES });

beforeEach(() => {
  db = new FakeDb();
  billingOn = true;
  sent.length = 0;
  orderCalls.length = 0;
  aiReplies.length = 0;
  aiPrompts.length = 0;
  shopCalls.length = 0;
  aiCalls = 0;
});

describe("what the message backs up", () => {
  it("reads the numbers a seller writes", () => {
    expect(messageNumbers("quantity 20")).toEqual([20]);
    expect(messageNumbers("make it 1,500 cedis")).toEqual([1500]);
    expect(messageNumbers("2.5k")).toEqual([2.5, 2500]);
    expect(messageNumbers("no numbers")).toEqual([]);
  });

  it("keeps a price or quantity only when the message says it", () => {
    expect(verifyChanges({ price: 1500, quantity: 20 }, "price 1,500 and 20 pieces", { options: [], variations: [] }))
      .toEqual({ changes: { price: 1500, quantity: 20 }, dropped: [] });
    expect(verifyChanges({ price: 999 }, "make it cheaper", { options: [], variations: [] }))
      .toEqual({ changes: {}, dropped: ["price"] });
    expect(verifyChanges({ quantity: 2.5 }, "quantity 2.5", { options: [], variations: [] }).dropped).toEqual(["quantity"]);
  });

  it("keeps a name, brand or colour only when it's written in the message", () => {
    const msg = "rename it to Hisense 205L Double Door Refrigerator and the colour is silver";
    expect(verifyChanges({ title: "Hisense 205L Double Door Refrigerator", color: "Silver" }, msg, { options: [], variations: [] }))
      .toEqual({ changes: { title: "Hisense 205L Double Door Refrigerator", color: "Silver" }, dropped: [] });
    expect(verifyChanges({ brand: "Samsung" }, msg, { options: [], variations: [] }).dropped).toEqual(["brand"]);
  });

  it("takes a variation the seller wrote, one of the category's options, or one the product has", () => {
    const known = { options: SIZES, variations: ["M"] };
    expect(verifyChanges({ variations: ["Large"] }, "change the variation to Large", known).changes).toEqual({ variations: ["Large"] });
    expect(verifyChanges({ variations: ["L"] }, "change the variation to Large", known).changes).toEqual({ variations: ["L"] });
    expect(verifyChanges({ variations: ["M", "XL"] }, "add XL too", known).changes).toEqual({ variations: ["M", "XL"] });
  });

  it("keeps the variations the message backs, and leaves out one the AI made up", () => {
    expect(verifyChanges({ variations: ["Huge", "Large"] }, "make it Large", { options: [], variations: [] }))
      .toEqual({ changes: { variations: ["Large"] }, dropped: [] });
    // "Can you add Blue variant to the wig" (live, 2026-10-07): the current one and the new one.
    expect(verifyChanges({ variations: ["24 Inch", "Blue"] }, "Can you add Blue variant to the wig product you drafted?", { options: [], variations: ["24 Inch"] }))
      .toEqual({ changes: { variations: ["24 Inch", "Blue"] }, dropped: [] });
    expect(verifyChanges({ variations: ["Huge"] }, "make it Large", { options: [], variations: [] })).toEqual({ changes: {}, dropped: ["variations"] });
  });

  it("a size's name becomes the category's own spelling of it, both ways", () => {
    expect(parseVariations(SIZES, "Large")).toEqual({ ok: true, values: ["L"] });
    expect(parseVariations(SIZES, "medium and extra large")).toEqual({ ok: true, values: ["M", "XL"] });
    expect(parseVariations(SIZES, "2XL")).toEqual({ ok: true, values: ["XXL"] });
    expect(parseVariations(["Small", "Medium", "Large", "Extra Large"], "S, XL")).toEqual({ ok: true, values: ["Small", "Extra Large"] });
    expect(parseVariations(SIZES, "Huge")).toEqual({ ok: false, unknown: ["Huge"] });
  });
});

describe("reading the AI's reply", () => {
  const products = [FRIDGE, SHIRT];

  it("an edit of the product named", () => {
    expect(parseAction('{"type":"edit","edits":[{"products":[1],"changes":{"quantity":20},"ask":false}]}', "fridge quantity 20", products))
      .toEqual({ type: "edit", edits: [{ seqs: [1], changes: { quantity: 20 }, ask: false }], dropped: [] });
  });

  it("asks which when no product is named in a batch of several", () => {
    expect(parseAction('{"type":"edit","edits":[{"products":[],"changes":{"quantity":20}}]}', "quantity 20", products))
      .toEqual({ type: "edit", edits: [{ seqs: [1, 2], changes: { quantity: 20 }, ask: true }], dropped: [] });
  });

  it("with one product, it is that one", () => {
    expect(parseAction('{"type":"edit","edits":[{"products":[],"changes":{"quantity":20},"ask":true}]}', "quantity 20", [FRIDGE]))
      .toEqual({ type: "edit", edits: [{ seqs: [1], changes: { quantity: 20 }, ask: false }], dropped: [] });
  });

  it("ignores product numbers that aren't in the batch", () => {
    expect(parseAction('{"type":"submit","products":[2,7]}', "submit the shirt", products)).toEqual({ type: "submit", seqs: [2] });
    expect(parseAction('{"type":"submit","products":[7]}', "submit 7", products)).toEqual({ type: "unclear" });
  });

  it("anything malformed is unclear", () => {
    expect(parseAction("I think they want to submit", "x", products)).toEqual({ type: "unclear" });
    expect(parseAction('{"type":"delete_everything"}', "x", products)).toEqual({ type: "unclear" });
    expect(parseAction('{"type":"answer","text":""}', "x", products)).toEqual({ type: "unclear" });
    expect(parseAction('{"type":"edit","edits":[{"products":[1],"changes":{}}]}', "x", products)).toEqual({ type: "unclear" });
  });

  it("reads JSON wrapped in a code fence", () => {
    expect(parseAction('```json\n{"type":"orders"}\n```', "my orders?", products)).toEqual({ type: "orders" });
  });
});

describe("a count of products to list", () => {
  it("must be in the message, as digits or a word, or add up from it", () => {
    expect(countBacked(5, "I want to list 5 products")).toBe(true);
    expect(countBacked(5, "can I list five things")).toBe(true);
    expect(countBacked(3, "2 shirts and a fridge")).toBe(true);
    expect(countBacked(4, "two shoes and two bags")).toBe(true);
    expect(countBacked(1, "I want to list a fridge")).toBe(true);
    expect(countBacked(3, "I want to list a few things")).toBe(false);
    expect(countBacked(6, "I want to list 5 products")).toBe(false);
  });

  it("is read from the AI only when the message backs it", () => {
    expect(parseAction('{"type":"list","count":3}', "2 shirts and a fridge please", [])).toEqual({ type: "list", count: 3 });
    expect(parseAction('{"type":"list","count":4}', "a few shirts", [])).toEqual({ type: "unclear" });
    expect(parseAction('{"type":"list","count":0}', "0 products", [])).toEqual({ type: "unclear" });
  });
});

describe("when the usual edit is enough", () => {
  it("a price, stock or sale on its own", () => {
    expect(plainQuickEdit("price 150", true)).toBe(true);
    expect(plainQuickEdit("price 150 and quantity 20", true)).toBe(true);
  });
  it("not when something else is named, or nothing was found", () => {
    expect(plainQuickEdit("price 150 and size Large", true)).toBe(false);
    expect(plainQuickEdit("change the colour to red", false)).toBe(false);
    expect(plainQuickEdit("price 150 for all of them", true)).toBe(false);
  });
});

describe("who has it", () => {
  it("admins, and the user ids in app_settings assistant_users", async () => {
    expect(await assistantEnabled("admin")).toBe(true);
    expect(await assistantEnabled("seller")).toBe(false);
    db.tables.app_settings = [{ key: "assistant_users", value: ["seller"] }];
    expect(await assistantEnabled("seller")).toBe(true);
    expect(await assistantEnabled("other")).toBe(false);
  });
});

describe("between batches", () => {
  const session = (patch: Partial<WhatsAppSession> = {}) =>
    ({ phoneNumber: "233", userId: "seller", state: "awaiting_count", batchId: null, lastSubmittedBatchId: null, ...patch }) as WhatsAppSession;

  it("answers a question about credits", async () => {
    db.tables.extension_credits = [{ user_id: "seller", balance: 9 }];
    aiReplies.push('{"type":"credits"}');
    expect(await runAssistant("seller", "233", session(), "how many credits do i have left", "idle")).toBe("handled");
    expect(sent).toEqual([{ kind: "cta", body: "You have 9 credits: enough for about 4 WhatsApp listings. A listing costs 2 credits when it goes live on Jumia.", button: "Buy credits", url: "https://pandaworld.gh/extension/dashboard" }]);
  });

  it("shows the orders", async () => {
    aiReplies.push('{"type":"orders"}');
    expect(await runAssistant("seller", "233", session(), "any new orders for me?", "idle")).toBe("handled");
    expect(orderCalls).toEqual(["orders"]);
  });

  it("answers from what the bot does, in its own words", async () => {
    aiReplies.push('{"type":"reply","text":"A WhatsApp listing costs 2 credits, charged only when it goes live.","link":null}');
    expect(await runAssistant("seller", "233", session(), "how much does a listing cost", "idle")).toBe("handled");
    expect(sent[0]).toEqual({ kind: "text", body: "A WhatsApp listing costs 2 credits, charged only when it goes live." });
  });

  it("hands a count back so the batch starts the usual way", async () => {
    aiReplies.push('{"type":"list","count":3}');
    expect(await runAssistant("seller", "233", session(), "I'd like to list 2 shirts and a fridge", "idle")).toEqual({ list: 3 });
    expect(sent).toEqual([]);
    expect(db.tables.whatsapp_assistant_log[0]).toMatchObject({ outcome: "list 3" });
  });

  it("offers to start listing", async () => {
    aiReplies.push('{"type":"restart"}');
    await runAssistant("seller", "233", session(), "i want to list some shoes", "idle");
    expect(sent[0]).toMatchObject({ kind: "buttons", rows: ["1", "2", "3"] });
  });

  it("leaves a change to products already with Jumia to the usual reply", async () => {
    db.tables.listings = [{ id: "l1", user_id: "seller", whatsapp_batch_id: "b1", whatsapp_seq: 1, title: "Hisense Fridge", status: "pending_approval" }];
    aiReplies.push('{"type":"edit","edits":[{"products":[1],"changes":{"quantity":20}}]}');
    expect(await runAssistant("seller", "233", session({ lastSubmittedBatchId: "b1" }), "quantity 20 for the fridge", "sent")).toBe("default");
    expect(sent).toEqual([]);
    expect(db.tables.listings[0].quantity).toBeUndefined();
  });

  it("leaves a reply it can't read to the usual one", async () => {
    aiReplies.push('{"type":"unclear"}');
    expect(await runAssistant("seller", "233", session(), "good morning", "idle")).toBe("default");
    expect(db.tables.whatsapp_assistant_log[0]).toMatchObject({ stage: "idle", message: "good morning", outcome: "default" });
  });

  it("doesn't ask the AI about a button id from an older message", async () => {
    expect(await runAssistant("seller", "233", session(), "apick:2", "idle")).toBe("default");
    expect(aiCalls).toBe(0);
  });

  it("says when the AI couldn't be reached", async () => {
    expect(await runAssistant("seller", "233", session(), "what can you do", "idle")).toBe("failed");
    expect(sent).toEqual([]);
  });
});

describe("its own replies (owner, 2026-10-06)", () => {
  const session = (patch: Partial<WhatsAppSession> = {}) =>
    ({ phoneNumber: "233", userId: "seller", state: "awaiting_count", batchId: null, lastSubmittedBatchId: null, ...patch }) as WhatsAppSession;

  it("is told what PandaWorld does, and what this seller's pack and credits give them", async () => {
    db.tables.extension_credits = [{ user_id: "seller", balance: 9 }];
    db.tables.jumia_connections = [{ user_id: "seller", country: "GH" }];
    aiReplies.push('{"type":"reply","text":"Hi! I can list your products on Jumia, edit your drafts and tell you your credits. What would you like to do for your Jumia shop?","link":null}');

    expect(await runAssistant("seller", "233", session(), "hello", "idle")).toBe("handled");

    const prompt = aiPrompts[0];
    expect(prompt).toContain("- List products on Jumia from WhatsApp");
    expect(prompt).toContain("- Orders on WhatsApp (Pro pack and up)");
    expect(prompt).toContain("- Country: Ghana");
    expect(prompt).toContain("- No pack bought yet: on their free sign-up credits.");
    expect(prompt).toContain("- Orders and shipping labels on WhatsApp: not on their pack (Pro and up)");
    expect(prompt).toContain("- Credits: 9 available, enough for about 4 WhatsApp listings");
    expect(prompt).toContain("- home: PandaWorld's home page");
    expect(prompt).toContain("- country: selling on Jumia in their country");
    expect(prompt).toContain("Reply in the language the seller wrote in.");
    expect(sent).toEqual([{ kind: "text", body: "Hi! I can list your products on Jumia, edit your drafts and tell you your credits. What would you like to do for your Jumia shop?" }]);
  });

  it("knows the pack bought last", async () => {
    db.tables.extension_credit_transactions = [{ user_id: "seller", type: "purchase", amount: 440, created_at: "2026-10-01T00:00:00Z" }];
    db.tables.extension_credits = [{ user_id: "seller", balance: 400 }];
    aiReplies.push('{"type":"reply","text":"Hello!","link":null}');
    await runAssistant("seller", "233", session(), "hi", "idle");
    expect(aiPrompts[0]).toContain("- Pack: Pro (the last one they bought)");
    expect(aiPrompts[0]).toContain("- Orders and shipping labels on WhatsApp: on");
  });

  it("an account that isn't charged has everything on", async () => {
    aiReplies.push('{"type":"reply","text":"Hello!","link":null}');
    await runAssistant("admin", "233", session({ userId: "admin" }), "hi", "idle");
    expect(aiPrompts[0]).toContain("- Not charged credits: every feature is on for them.");
  });

  it("sends a page it's asked for as a button", async () => {
    aiReplies.push('{"type":"reply","text":"Here\'s our home page 🐼","link":"home"}');
    await runAssistant("seller", "233", session(), "send me the link to your home page", "idle");
    expect(sent).toEqual([{ kind: "cta", body: "Here's our home page 🐼", button: "Home page", url: "https://pandaworld.gh/" }]);
  });

  it("removes a web address it made up, and keeps ours", () => {
    const links = assistantLinks();
    expect(cleanReply("See https://jumia-fees.example.com/ghana or https://pandaworld.gh/pricing.", links))
      .toBe("See or https://pandaworld.gh/pricing.");
    expect(parseAction('{"type":"reply","text":"Try www.madeup.com","link":"nope"}', "link?", [], links))
      .toEqual({ type: "reply", text: "Try", link: null });
    expect(parseAction('{"type":"reply","text":"","link":"faq"}', "faq?", [], links))
      .toEqual({ type: "reply", text: "Here's the faq:", link: "faq" });
  });

  it("keeps the review step's buttons under a reply there", async () => {
    db.tables.listings = [{ id: "l1", user_id: "seller", whatsapp_batch_id: "b1", whatsapp_seq: 1, title: "Hisense 205L Fridge", status: "draft" }];
    aiReplies.push('{"type":"reply","text":"Sorry, I can\'t book deliveries. I can change your fridge\'s price, quantity or size, or submit it.","link":null}');
    await runAssistant("seller", "233", session({ state: "awaiting_confirmation", batchId: "b1" }), "book me a delivery truck", "review");
    expect(sent).toEqual([{ kind: "buttons", body: "Sorry, I can't book deliveries. I can change your fridge's price, quantity or size, or submit it.", rows: ["submit all", "review"] }]);
  });
});

describe("the live shop, through the assistant (owner, 2026-10-07)", () => {
  const session = () => ({ phoneNumber: "233", userId: "seller", state: "awaiting_count", batchId: null, lastSubmittedBatchId: null }) as WhatsAppSession;

  it("hands a live change, and each question, to the shop module", async () => {
    aiReplies.push('{"type":"live_change","product":"Hisense fridge","stock":20}');
    expect(await runAssistant("seller", "233", session(), "set the Hisense fridge stock to 20", "idle")).toBe("handled");
    aiReplies.push('{"type":"order_status","number":"355926919"}');
    await runAssistant("seller", "233", session(), "where is order 355926919", "idle");
    aiReplies.push('{"type":"sales","period":"today"}');
    await runAssistant("seller", "233", session(), "how did I do today", "idle");
    aiReplies.push('{"type":"payouts"}');
    await runAssistant("seller", "233", session(), "has jumia paid me", "idle");
    expect(shopCalls).toEqual([
      ["proposeLiveChange", "Hisense fridge", { kind: "stock", stock: 20 }, { preferSid: null }],
      ["answerOrderStatus", "355926919"],
      ["answerSales", "today", null],
      ["answerPayouts"],
    ]);
    expect(db.tables.whatsapp_assistant_log[0]).toMatchObject({ outcome: "offered" });
  });

  it("is told what the live shop can do, and whether the seller's pack has it", async () => {
    aiReplies.push('{"type":"reply","text":"Hi!","link":null}');
    await runAssistant("seller", "233", session(), "hi", "idle");
    expect(aiPrompts[0]).toContain("- Their live Jumia products (Pro pack and up)");
    expect(aiPrompts[0]).toContain("- Live products, stock and payouts on WhatsApp: not on their pack (Pro and up)");
    expect(aiPrompts[0]).toContain('{"type":"live_change"');
  });

  it("everyone, when assistant_users is [\"*\"]", async () => {
    db.tables.app_settings = [{ key: "assistant_users", value: ["*"] }];
    expect(await assistantEnabled("anyone")).toBe(true);
  });
});

describe("what the owner's live test showed (2026-10-07)", () => {
  const EARRINGS = product(1, "Asymmetrical Irregular Statement Earrings - Shell Inlay, Gold Tone");
  const WIG = product(2, "Kinky Curly Wig - 24 Inch Length, Full Lace");

  it("a draft is only changed when the seller's words name it", () => {
    expect(fitsDraft("gold medal", EARRINGS.listing.title)).toBe(false);
    expect(fitsDraft("the wigs", WIG.listing.title)).toBe(true);
    expect(fitsDraft("the second one", WIG.listing.title)).toBe(true);
  });

  it("\"set the gold medal to 25\" in review is a live product, not the gold-tone earrings draft", () => {
    expect(parseAction(
      '{"type":"edit","edits":[{"products":[1],"said":"gold medal","changes":{"price":25},"ask":false}]}',
      "Set the gold medal to 25", [EARRINGS, WIG],
    )).toEqual({ type: "live_change", product: "gold medal", change: { kind: "price", price: 25 } });
    expect(parseAction(
      '{"type":"edit","edits":[{"products":[2],"said":"wigs","changes":{"price":10},"ask":false}]}',
      "Change the wigs price to Ghs10", [EARRINGS, WIG],
    )).toEqual({ type: "edit", edits: [{ seqs: [2], changes: { price: 10 }, ask: false }], dropped: [] });
  });

  it("the sale window a seller leaves to us", () => {
    const now = new Date("2026-10-07T10:00:00Z");
    expect(saleWindow("sale 80 from 20 Oct to 30 Oct", now)).toEqual({ start: "2026-10-20", end: "2026-10-30" });
    expect(saleWindow("choose your own start and end date within this month", now)).toEqual({ start: "2026-10-07", end: "2026-10-31" });
    expect(saleWindow("just for this week", now)).toEqual({ start: "2026-10-07", end: "2026-10-13" });
    expect(saleWindow("make it 100", now)).toBeNull();
  });

  it("a question to the bot, not a product's notes", () => {
    for (const t of ["Has JUMIA payed me ?", "I won't list again", "You remember which one I last used?", "cancel"]) expect(looksLikeQuestion(t)).toBe(true);
    for (const t of ["Price 200, sizes M and L", "Brand new, black", "150"]) expect(looksLikeQuestion(t)).toBe(false);
  });

  it("reads the recent conversation, oldest first, without the message being answered", async () => {
    db.tables.whatsapp_message_log = [
      { phone_number: "233", direction: "outbound", message_type: "button", body_text: "⚠️ 30 is more than I can draft in one go — the most is 20 at a time.", created_at: "2026-10-07T01:29:10Z" },
      { phone_number: "233", direction: "inbound", message_type: "text", body_text: "I would like to list like 30 products", created_at: "2026-10-07T01:28:56Z" },
      { phone_number: "233", direction: "inbound", message_type: "interactive", body_text: "lpick:565dc00b-32d4-4737-a553-d08991fc0508:2", created_at: "2026-10-07T01:29:20Z" },
      { phone_number: "233", direction: "inbound", message_type: "text", body_text: "Let's do five then", created_at: "2026-10-07T01:29:38Z" },
    ];
    expect(await recentConversation("233", "Let's do five then")).toEqual([
      "Seller: I would like to list like 30 products",
      "Bot: ⚠️ 30 is more than I can draft in one go — the most is 20 at a time.",
      "Seller: [tapped a button]",
    ]);
  });

  it("the prompt carries the conversation, the rules and the examples", async () => {
    db.tables.whatsapp_message_log = [
      { phone_number: "233", direction: "outbound", message_type: "text", body_text: "the most is 20 at a time", created_at: "2026-10-07T01:29:10Z" },
    ];
    aiReplies.push('{"type":"list","count":5}');
    const session = { phoneNumber: "233", userId: "seller", state: "awaiting_count", batchId: null, lastSubmittedBatchId: "b0" } as WhatsAppSession;
    expect(await runAssistant("seller", "233", session, "Let's do five then", "sent")).toEqual({ list: 5 });
    expect(aiPrompts[0]).toContain("Recent conversation (oldest first; \"Bot\" is you):\nBot: the most is 20 at a time");
    expect(aiPrompts[0]).toContain("Never reply that you can or will check or do something: do it with the action.");
    expect(aiPrompts[0]).toContain('"has jumia paid me?" or "shop statement" → {"type":"payouts"}');
    expect(db.tables.whatsapp_assistant_log[0]).toMatchObject({ raw: '{"type":"list","count":5}' });
  });

  it("the model can be switched in app_settings, to known ones only", async () => {
    const { assistantModel } = await import("@/lib/whatsapp/assistant");
    expect(await assistantModel()).toBe("gemini-2.5-flash-lite");
    db.tables.app_settings = [{ key: "assistant_model", value: "gemini-2.5-flash" }];
    expect(await assistantModel()).toBe("gemini-2.5-flash");
    db.tables.app_settings = [{ key: "assistant_model", value: "some-other-model" }];
    expect(await assistantModel()).toBe("gemini-2.5-flash-lite");
  });

  it("starting a batch: a note stays a note; a question is answered with where they are", async () => {
    const session = { phoneNumber: "233", userId: "seller", state: "awaiting_photos", batchId: "b1", batchSize: 2, batchSeq: 1, lastSubmittedBatchId: null } as WhatsAppSession;
    aiReplies.push('{"type":"note"}');
    expect(await runAssistant("seller", "233", session, "is it ok if the price is 200?", "starting")).toBe("default");
    expect(sent).toEqual([]);
    aiReplies.push('{"type":"payouts"}');
    expect(await runAssistant("seller", "233", session, "Has JUMIA payed me ?", "starting")).toBe("handled");
    expect(shopCalls).toEqual([["answerPayouts"]]);
    expect(sent.at(-1)!.body).toBe("📸 I'm still ready for product 1 of 2: send its photos when you're ready, or say *restart* to stop.");
    // A reply carries it in the same message.
    sent.length = 0;
    aiReplies.push('{"type":"reply","text":"Fashion > Shoes fits boots.","link":null}');
    await runAssistant("seller", "233", session, "what category should we use?", "starting");
    expect(sent).toEqual([{ kind: "text", body: "Fashion > Shoes fits boots.\n\n📸 I'm still ready for product 1 of 2: send its photos when you're ready, or say *restart* to stop." }]);
  });
});

describe("what the owner's second test showed (2026-10-07, round 3)", () => {
  const ctx = (lines: string[]) => lines.join("\n");
  const idle = () => ({ phoneNumber: "233", userId: "seller", state: "awaiting_count", batchId: null, lastSubmittedBatchId: null }) as WhatsAppSession;

  it("several products, one change: one action for all of them", () => {
    expect(parseAction('{"type":"live_change","products":["Mounted freezer","blender","chainsaw"],"stock":10}',
      "change the stock of the Mounted freezer and the blender and the chainsaw on my shop to 10", []))
      .toEqual({ type: "live_change", product: "Mounted freezer", others: ["blender", "chainsaw"], change: { kind: "stock", stock: 10 } });
    // A product the AI added that the seller never named is left out.
    expect(parseAction('{"type":"live_change","products":["freezer","kettle"],"stock":10}', "set the freezer to 10", []))
      .toEqual({ type: "live_change", product: "freezer", change: { kind: "stock", stock: 10 } });
    // "All the hard hats": every product it fits.
    expect(parseAction('{"type":"live_change","product":"hard hats","stock":0,"all":true}', "set all the hard hats to 0", []))
      .toEqual({ type: "live_change", product: "hard hats", change: { kind: "stock", stock: 0 }, all: true });
  });

  it("the value from the seller's own last message, when this one only names the products", () => {
    const context = ctx(["Seller: update the stock of those products to 10 each", "Bot: Which products do you mean?"]);
    expect(parseAction('{"type":"live_change","product":"Mounted freezer - 65 Ltrs","stock":10}', "okay the Mounted freezer and the blender and the chainsaw", [], {}, "GHS", { context }))
      .toEqual({ type: "live_change", product: "Mounted freezer - 65 Ltrs", change: { kind: "stock", stock: 10 } });
    // Not a number the bot said.
    expect(parseAction('{"type":"live_change","product":"freezer","stock":43}', "okay the freezer", [], {}, "GHS", { context: "Bot: the boot has 43 left" }))
      .toMatchObject({ type: "reply", awaiting: { field: "stock", products: ["freezer"] } });
  });

  it("an edit with no drafts around is a change to their Jumia products", () => {
    expect(parseAction('{"type":"edit","edits":[{"products":[1,2,3],"said":"Mounted freezer and the blender and the chainsaw","changes":{"quantity":10},"ask":false}]}',
      "i meant the stock of the Mounted freezer and the blender and the chainsaw should be made 10", []))
      .toEqual({ type: "live_change", product: "Mounted freezer", others: ["the blender", "the chainsaw"], change: { kind: "stock", stock: 10 } });
    expect(splitProducts("Salt and Pepper Grinder")).toEqual(["Salt and Pepper Grinder"]);
    expect(splitProducts("the kettle, the drill and the boot")).toEqual(["the kettle", "the drill", "the boot"]);
  });

  it("\"is the drone live?\" is a question, never a change", () => {
    expect(parseAction('{"type":"live_change","product":"drone","active":true}', "is the drone live?", [])).toEqual({ type: "product_info", product: "drone" });
    expect(parseAction('{"type":"live_change","product":"drones","active":true}', "is the dron active", [])).toEqual({ type: "product_info", product: "drones" });
    expect(parseAction('{"type":"product_info","product":"drone"}', "is the drone live?", [])).toEqual({ type: "product_info", product: "drone" });
    expect(isStateQuestion("can you turn on the drone?")).toBe(false);
    expect(isStateQuestion("the drone is on?")).toBe(true);
  });

  it("\"tun on\" and other ways of saying on; not \"on sale\"", () => {
    const on = (msg: string) => parseAction('{"type":"live_change","product":"drone","active":true}', msg, []);
    for (const msg of ["also tun on the drone", "turn the drone back on", "activate the drone", "make the drone live again"]) {
      expect(on(msg)).toEqual({ type: "live_change", product: "drone", change: { kind: "status", active: true } });
    }
    expect(on("put the drone on sale")).toEqual({ type: "unclear" });
  });

  it("the whole shop at once is explained, not attempted", () => {
    expect(parseAction('{"type":"live_change","product":null,"active":false}', "off all products", []))
      .toMatchObject({ type: "reply", text: expect.stringContaining("I can't change every product in your shop at once") });
    expect(parseAction('{"type":"live_change","product":"other products","active":false}', "off all other products apart from the ones i asked you turn on", []))
      .toMatchObject({ type: "reply", text: expect.stringContaining("Jumia Vendor Center has bulk tools") });
    expect(parseAction('{"type":"live_change","product":"those products","stock":10}', "update the stock of those products to 10 each", []))
      .toMatchObject({ type: "reply", text: expect.stringContaining("Which products do you mean?") });
    expect(namesAProduct("the other ones")).toBe(false);
    expect(namesAProduct("the blender")).toBe(true);
  });

  it("several statuses, and as far back as Jumia goes", () => {
    expect(parseAction('{"type":"sales","period":"yesterday","status":["ready_to_ship","cancelled"]}', "check for ready to ship and cancelled order yesterday", []))
      .toEqual({ type: "sales", period: "yesterday", status: ["READY_TO_SHIP", "CANCELED"] });
    expect(parseAction('{"type":"sales","period":"all","status":"delivered"}', "any delivered orders past time?", []))
      .toEqual({ type: "sales", period: "quarter", status: "DELIVERED" });
    expect(parseAction('{"type":"sales","period":"quarter","status":null}', "how much has my shop made in 90days", []))
      .toEqual({ type: "sales", period: "quarter", status: null });
    expect(parseAction('{"type":"sales","period":"month","status":"returns"}', "returns", []))
      .toEqual({ type: "sales", period: "month", status: "RETURNED" });
  });

  it("fees: for a product they name, at a price from their message only", () => {
    expect(parseAction('{"type":"fees","product":"creatine","price":null}', "my creatine product how much will i recieve if it is sold?", []))
      .toEqual({ type: "fees", product: "creatine", price: null });
    expect(parseAction('{"type":"fees","product":"boot","price":120}', "what does jumia charge if I sell the boot at 120", []))
      .toEqual({ type: "fees", product: "boot", price: 120 });
    expect(parseAction('{"type":"fees","product":"boot","price":99}', "what does jumia charge for the boot", []))
      .toEqual({ type: "fees", product: "boot", price: null });
    // The AI's own name for it, seen live.
    expect(parseAction('{"type":"calculator","product":"creatine"}', "how much will I get for the creatine", [])).toEqual({ type: "fees", product: "creatine", price: null });
  });

  it("the prompt says: no promises, questions are product_info, the new examples", async () => {
    aiReplies.push('{"type":"reply","text":"Hi!","link":null}');
    await runAssistant("seller", "233", idle(), "hi there", "idle");
    expect(aiPrompts[0]).toContain("Never promise anything for later");
    expect(aiPrompts[0]).toContain('"did I have orders today?" → {"type":"sales","period":"today","status":null}');
    expect(aiPrompts[0]).toContain('{"type":"product_info"');
    expect(aiPrompts[0]).toContain('{"type":"fees"');
    expect(aiPrompts[0]).toContain("- Jumia fees on WhatsApp: not on their pack (Pro and up)");
  });

  it("a bare number answers \"What should its stock be?\"", async () => {
    db.tables.whatsapp_sessions = [{ phone_number: "233", user_id: "seller", state: "awaiting_count" }];
    aiReplies.push('{"type":"live_change","product":"freezer","stock":7}');
    await runAssistant("seller", "233", idle(), "and the freezer", "idle");
    expect(sent.at(-1)!.body).toBe('What should its stock be? Send the number, e.g. "10".');
    const asked = db.tables.whatsapp_sessions[0].assistant_pending as Record<string, unknown>;
    expect(asked).toMatchObject({ kind: "live_value", field: "stock", products: ["freezer"] });

    const withAsk = { ...idle(), assistantPending: asked } as unknown as WhatsAppSession;
    expect(await answerLiveValue("seller", "233", withAsk, "10")).toBe(true);
    expect(shopCalls.at(-1)).toEqual(["proposeLiveChange", "freezer", { kind: "stock", stock: 10 }, { preferSid: null }]);
    expect(db.tables.whatsapp_sessions[0].assistant_pending).toBeNull();
    // Anything else drops the question.
    expect(await answerLiveValue("seller", "233", withAsk, "what about the kettle")).toBe(false);
    // A stale one is no longer an answer.
    const stale = { ...withAsk, assistantPending: { ...asked, at: "2026-01-01T00:00:00Z" } } as unknown as WhatsAppSession;
    expect(await answerLiveValue("seller", "233", stale, "10")).toBe(false);
  });

  it("hands several products and \"all\" to the shop module", async () => {
    aiReplies.push('{"type":"live_change","products":["freezer","blender"],"stock":10}');
    await runAssistant("seller", "233", idle(), "set the freezer and the blender to 10", "idle");
    aiReplies.push('{"type":"product_info","product":"drone"}');
    await runAssistant("seller", "233", idle(), "is the drone live?", "idle");
    aiReplies.push('{"type":"fees","product":"creatine","price":null}');
    await runAssistant("seller", "233", idle(), "how much do I get when the creatine sells", "idle");
    expect(shopCalls).toEqual([
      ["proposeLiveChange", ["freezer", "blender"], { kind: "stock", stock: 10 }, { preferSid: null }],
      ["answerProductInfo", "drone"],
      ["answerFees", "creatine", null, undefined],
    ]);
  });
});

describe("the assistant's daily allowance (owner, 2026-10-07)", () => {
  const session = () => ({ phoneNumber: "233", userId: "seller", state: "awaiting_count", batchId: null, lastSubmittedBatchId: null }) as WhatsAppSession;
  const turns = (n: number, userId = "seller") => {
    db.tables.whatsapp_assistant_log = Array.from({ length: n }, (_, i) => ({
      id: i + 1, user_id: userId, stage: "idle", message: "hi", raw: "{}", outcome: "replied", created_at: new Date().toISOString(),
    }));
  };

  it("by pack, smaller where WhatsApp costs more; none for admins or when billing is off", async () => {
    expect(await dailyAllowance("seller")).toBe(DAILY_ALLOWANCE.none);
    db.tables.extension_credit_transactions = [{ user_id: "seller", type: "purchase", amount: 440, created_at: "2026-10-01T00:00:00Z" }];
    expect(await dailyAllowance("seller")).toBe(DAILY_ALLOWANCE.pro);
    db.tables.jumia_connections = [{ user_id: "seller", country: "NG" }];
    expect(await dailyAllowance("seller")).toBe(DAILY_ALLOWANCE.pro / 2);
    expect(await dailyAllowance("admin")).toBeNull();
    billingOn = false;
    expect(await dailyAllowance("seller")).toBeNull();
  });

  it("past it: told once, then the fixed flow, with no AI call", async () => {
    turns(DAILY_ALLOWANCE.none);
    expect(await runAssistant("seller", "233", session(), "what can you do", "idle")).toBe("handled");
    expect(sent[0].body).toContain(`You've used today's ${DAILY_ALLOWANCE.none} chat replies on your pack`);
    expect(db.tables.whatsapp_assistant_log.at(-1)).toMatchObject({ outcome: ALLOWANCE_TOLD });
    sent.length = 0;
    expect(await runAssistant("seller", "233", session(), "what else", "idle")).toBe("failed");
    expect(sent).toEqual([]);
    expect(aiCalls).toBe(0);
  });

  it("yesterday's turns don't count", async () => {
    turns(DAILY_ALLOWANCE.none);
    for (const r of db.tables.whatsapp_assistant_log) r.created_at = "2026-01-01T10:00:00Z";
    expect(await assistantGate("seller")).toEqual({ ok: true });
  });

  it("the global ceiling rests it for everyone but admins", async () => {
    db.tables.app_settings = [{ key: "assistant_daily_limit", value: 3 }];
    turns(3, "someone-else");
    expect(await assistantGate("seller")).toEqual({ ok: false, reason: "ceiling" });
    expect(await assistantGate("admin")).toEqual({ ok: true });
  });

  it("the kill switch turns it off, admins included", async () => {
    db.tables.app_settings = [{ key: "assistant_enabled", value: false }];
    expect(await assistantEnabled("admin")).toBe(false);
    db.tables.app_settings = [];
    expect(await assistantEnabled("admin")).toBe(true);
  });

  it("a day starts at the seller's own midnight", () => {
    const now = new Date("2026-10-07T23:30:00Z");
    expect(dayStart("Africa/Accra", now)).toBe("2026-10-07T00:00:00.000Z");
    expect(dayStart("Africa/Lagos", now)).toBe("2026-10-07T23:00:00.000Z");
    expect(dayStart("Africa/Nairobi", new Date("2026-10-07T10:00:00Z"))).toBe("2026-10-06T21:00:00.000Z");
  });
});
