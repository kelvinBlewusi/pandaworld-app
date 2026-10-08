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
  proposeBulkChange: async (...a: unknown[]) => { shopCalls.push(["proposeBulkChange", ...a.slice(2)]); return "bulk"; },
  proposeContentChange: async (...a: unknown[]) => { shopCalls.push(["proposeContentChange", ...a.slice(2)]); return "content"; },
  MAX_GROUP: 20,
  BULK_MAX: 200,
}));

const SIZES = ["S", "M", "L", "XL", "XXL"];
jest.mock("@/lib/jumia/categories", () => ({
  getCategoryAttributes: async (code: number) =>
    code === 100 ? [{ name: "variation", label: "Size", type: "enum", allowed_values: SIZES, is_variant: true }] : [],
}));

import {
  answerLiveValue, assistantEnabled, assistantFor, assistantLinks, cleanReply, countBacked, fitsDraft, isStateQuestion, looksLikeQuestion, messageNumbers,
  changeToAsked, draftNumberIn, isProductName, namesAProduct, recentConversation, saidIsValues, saleWindow, splitProducts, parseAction, plainQuickEdit, runAssistant, verifyChanges, type ProductFacts,
} from "@/lib/whatsapp/assistant";
import { assistantGate } from "@/lib/whatsapp/assistant-limits";
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

  // The owner's web chat, 2026-10-07, answering "What variation(s) do you have?".
  const BODYSUIT_MSG = "Price: 130gh \nSizes: Large, Medium, Small.\nColors: cream, black and brown";

  it("takes only the sizes the seller named, never the category's whole list", () => {
    const options = ["S", "M", "L", "XS", "XXL", "XS AB", "S-M", "L/XL", "ONE SIZE FITS ALL", "EU XS", "UK 4"];
    // The AI sent every option back; only the three named stay.
    expect(verifyChanges({ variations: options }, BODYSUIT_MSG, { options, variations: [] }).changes).toEqual({ variations: ["S", "M", "L"] });
    // "it's" isn't an "S".
    expect(verifyChanges({ variations: ["S"] }, "it's lovely", { options, variations: [] }).changes).toEqual({});
    expect(verifyChanges({ variations: ["L"] }, "change the variation to 'L'", { options, variations: [] }).changes).toEqual({ variations: ["L"] });
  });

  // Owner, 2026-10-07: "what if it was a different word with its
  // interpretation in the variation list acceptable for that category".
  it("takes the AI's reading of the seller's words as one of the category's options, checked both ways", () => {
    const options = ["XS", "S", "M", "L", "XL", "ONE SIZE FITS ALL", "EU 40", "EU 42", "UK 10", "3-4 Years", "1L", "Black and White"];
    const known = { options, variations: [] };
    const pairs = (...p: [string, string][]) => ({ variations: p.map(([said, option]) => ({ said, option })) });
    expect(verifyChanges(pairs(["free size", "ONE SIZE FITS ALL"]), "it's free size", known).changes).toEqual({ variations: ["ONE SIZE FITS ALL"] });
    expect(verifyChanges(pairs(["size 42", "EU 42"], ["size 40", "EU 40"]), "she has size 40 and size 42", known).changes).toEqual({ variations: ["EU 42", "EU 40"] });
    expect(verifyChanges(pairs(["ages 3 to 4", "3-4 Years"]), "for ages 3 to 4", known).changes).toEqual({ variations: ["3-4 Years"] });
    expect(verifyChanges(pairs(["one litre", "1L"]), "one litre bottle", known).changes).toEqual({ variations: ["1L"] });
    expect(verifyChanges(pairs(["black & white", "Black and White"]), "black & white", known).changes).toEqual({ variations: ["Black and White"] });
    // An option that isn't on the list, or words the seller didn't write, aren't taken.
    expect(verifyChanges(pairs(["free size", "Free Size"]), "it's free size", known)).toEqual({ changes: {}, dropped: ["variations"] });
    expect(verifyChanges(pairs(["extra small", "XS"]), "make it large", known)).toEqual({ changes: {}, dropped: ["variations"] });
    // One phrase read as the whole list: none of it.
    expect(verifyChanges(pairs(...options.map((o): [string, string] => ["sizes", o])), "sizes please", known)).toEqual({ changes: {}, dropped: ["variations"] });
    // One phrase listing three is three; a range can be several.
    expect(verifyChanges(pairs(["Large, Medium, Small", "L"], ["Large, Medium, Small", "M"], ["Large, Medium, Small", "S"]), "Sizes: Large, Medium, Small", known).changes)
      .toEqual({ variations: ["L", "M", "S"] });
    expect(verifyChanges(pairs(["S to XL", "S"], ["S to XL", "M"], ["S to XL", "L"], ["S to XL", "XL"]), "S to XL", known).changes)
      .toEqual({ variations: ["S", "M", "L", "XL"] });
  });

  // Owner's web chat, 2026-10-08: "my message count so far" came back as
  // the draft's own sizes again, and the bot applied them.
  it("an edit needs something from this message: the product's current values alone are no change", () => {
    const BODY = product(1, "3-Piece Thong Bodysuit", { options: SIZES, variations: ["L", "M", "S"] });
    const raw = '{"type":"edit","edits":[{"products":[1],"said":null,"changes":{"variations":[{"said":"L","option":"L"},{"said":"M","option":"M"},{"said":"S","option":"S"}],"color":"cream, black and brown"},"ask":false}]}';
    expect(parseAction(raw, "my message count so far", [BODY], assistantLinks())).toEqual({ type: "unclear" });
    // Adding to them still keeps them.
    expect(verifyChanges({ variations: ["L", "M", "S", "XL"] }, "add XL too", { options: SIZES, variations: ["L", "M", "S"] }).changes)
      .toEqual({ variations: ["L", "M", "S", "XL"] });
  });

  // Same chat: "No the 150 is product 3 price" went to the live products on Jumia.
  it("a draft named by its number in the sentence is that draft", () => {
    const drafts = [product(1, "Thong Bodysuit"), product(2, "Vintage Radio Eau de Parfum"), product(3, "White Maple Leaf Flower Earrings")];
    expect(draftNumberIn("the 150 is product 3 price", drafts)).toBe(3);
    expect(draftNumberIn("#2", drafts)).toBe(2);
    expect(draftNumberIn("product 9", drafts)).toBeNull();
    const raw = '{"type":"edit","edits":[{"products":[3],"said":"the 150 is product 3 price","changes":{"price":150},"ask":false}]}';
    expect(parseAction(raw, "No the 150 is product 3 price", drafts, assistantLinks())).toEqual({
      type: "edit", edits: [{ seqs: [3], changes: { price: 150 }, ask: false }], dropped: [],
    });
  });

  it("keeps the seller's own colour words when the AI renames them", () => {
    expect(verifyChanges({ color: "Beige, Black, Brown" }, BODYSUIT_MSG, { options: [], variations: [] }))
      .toEqual({ changes: { color: "cream, black and brown" }, dropped: [] });
    expect(verifyChanges({ color: "Beige" }, "make it nicer", { options: [], variations: [] }).dropped).toEqual(["colour"]);
  });

  it("a sentence isn't a field to change", () => {
    expect(verifyChanges({ other: "Don't list tbis again pls" }, "Don't list tbis again pls", { options: [], variations: [] }).changes).toEqual({});
    expect(verifyChanges({ other: "material" }, "change the material", { options: [], variations: [] }).changes).toEqual({ other: "material" });
  });

  it("the new values given as the product's name don't make it another product", () => {
    expect(saidIsValues("Large, Medium, Small.", { variations: ["Large", "Medium", "Small"], color: "cream, black and brown" })).toBe(true);
    expect(saidIsValues("gold medal", { price: 25 })).toBe(false);
    const BODYSUIT = product(1, "3-Piece Thong Bodysuit - Seamless, Tummy Control, Adjustable Straps", { options: SIZES });
    const first = '{"type":"edit","edits":[{"products":[1],"said":"Large, Medium, Small.","changes":{"variations":["Large","Medium","Small"],"color":"cream, black and brown"},"ask":false}]}';
    expect(parseAction(first, BODYSUIT_MSG, [BODYSUIT], assistantLinks())).toEqual({
      type: "edit", edits: [{ seqs: [1], changes: { variations: ["Large", "Medium", "Small"], color: "cream, black and brown" }, ask: false }], dropped: [],
    });
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
    // A count the message doesn't give is still a wish to list: offered like "restart" (2026-10-08).
    expect(parseAction('{"type":"list","count":4}', "a few shirts", [])).toEqual({ type: "restart" });
    expect(parseAction('{"type":"list","count":1}', "let's list new products", [])).toEqual({ type: "restart" });
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
  // Owner, 2026-10-07: "AI for all sellers".
  it("every seller, on WhatsApp and the web, unless the kill switch is off", async () => {
    expect(await assistantEnabled("admin")).toBe(true);
    expect(await assistantEnabled("seller")).toBe(true);
    expect(await assistantFor("seller", "233200000000")).toBe(true);
    expect(await assistantFor("seller", "web:seller")).toBe(true);
    db.tables.app_settings = [{ key: "assistant_enabled", value: false }];
    expect(await assistantFor("seller", "233200000000")).toBe(false);
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

  // Owner, 2026-10-07: "let the chat know our site very well ... connect WhatsApp, use extension, regenerate key".
  it("knows the website, page by page, and how each thing is done, with the page to send", async () => {
    aiReplies.push('{"type":"reply","text":"1. Open your Extension Dashboard.\\n2. Tap *Regenerate key*.","link":"dashboard"}');
    await runAssistant("seller", "233", session(), "how do I regenerate my api key", "idle");
    const prompt = aiPrompts[0];
    expect(prompt).toContain("The website (pandaworld's dashboard, after signing in");
    expect(prompt).toContain("- Link WhatsApp [guide_link_whatsapp]: Settings → WhatsApp → \"Connect WhatsApp\"");
    expect(prompt).toContain("- Connect Jumia [guide_connect]");
    expect(prompt).toContain("- Use the Chrome extension [guide_extension]");
    expect(prompt).toContain("- Regenerate the API key");
    expect(prompt).toContain("+233548534323");
    for (const key of ["assistant", "calculator_app", "connect_jumia", "guide_link_whatsapp", "community", "settings", "dashboard"]) {
      expect(prompt).toContain(`- ${key}: `);
    }
    expect(prompt).toContain("How to do something on PandaWorld, or where to find it");
    expect(sent[0]).toMatchObject({ kind: "cta", body: "1. Open your Extension Dashboard.\n2. Tap *Regenerate key*." });
  });

  it("is told what PandaWorld does, and what this seller's pack and credits give them", async () => {
    db.tables.extension_credits = [{ user_id: "seller", balance: 9 }];
    db.tables.jumia_connections = [{ user_id: "seller", country: "GH" }];
    aiReplies.push('{"type":"reply","text":"Hi! I can list your products on Jumia, edit your drafts and tell you your credits. What would you like to do for your Jumia shop?","link":null}');

    expect(await runAssistant("seller", "233", session(), "hello", "idle")).toBe("handled");

    const prompt = aiPrompts[0];
    expect(prompt).toContain("- List products on Jumia from WhatsApp");
    expect(prompt).toContain("pack them, mark them ready to ship, or cancel, here or on WhatsApp");
    expect(prompt).toContain("Shipping label PDFs only on WhatsApp (Standard pack and up). Pro and up also: alerts for new Jumia orders on WhatsApp");
    expect(prompt).toContain("- Chatting is free on every pack.");
    expect(prompt).toContain("- Changes to live Jumia products from the chat: not on their pack (Standard and up)");
    expect(prompt).toContain("up to 200 products");
    expect(prompt).toContain("- Country: Ghana");
    expect(prompt).toContain("- Pack: none bought yet, on their free sign-up credits");
    // Every plan since 2026-10-07: the chat's features; labels and alerts keep their packs.
    expect(prompt).toContain("- The chat's shop features (products, orders, reports, payouts, fees): on");
    expect(prompt).toContain("- Jumia QC rejection alerts and guided fixes: not on their pack (Standard and up)");
    expect(prompt).toContain("- Shipping label PDFs on WhatsApp: not on their pack (Standard and up)");
    expect(prompt).toContain("- Order alerts on WhatsApp (new orders, order updates, payouts): not on their pack (Pro and up)");
    expect(prompt).toContain("a shipping label 0.5 credits (the same label again is free)");
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
    expect(aiPrompts[0]).toContain("- Shipping label PDFs on WhatsApp: on");
    expect(aiPrompts[0]).toContain("- Order alerts on WhatsApp (new orders, order updates, payouts): on");
    expect(aiPrompts[0]).toContain("- Changes to live Jumia products from the chat: on");
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

  it("writes the model's markdown the WhatsApp way: one asterisk for bold, no headings", () => {
    const links = assistantLinks();
    expect(cleanReply("## Your shop\nI can show **orders** and **sales**.", links)).toBe("Your shop\nI can show *orders* and *sales*.");
  });

  it("asks for choices as bullets, never numbered, and sends vague insight to the free overview", async () => {
    aiReplies.push('{"type":"reply","text":"Hi!","link":null}');
    await runAssistant("seller", "233", session(), "what can you do?", "idle");
    const prompt = aiPrompts.at(-1)!;
    expect(prompt).toContain("never numbered");
    expect(prompt).toContain("Insight, stats, analytics or how their shop is performing");
    expect(prompt).not.toContain("a short numbered list");
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
    expect(aiPrompts[0]).toContain("- Their live Jumia products, found by name");
    expect(aiPrompts[0]).toContain("- The chat's shop features (products, orders, reports, payouts, fees): on");
    expect(aiPrompts[0]).toContain('{"type":"live_change"');
  });

  it("everyone", async () => {
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
    expect(await runAssistant("seller", "233", session, "is it ok if the price is 200?", "starting")).toBe("step");
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

  it("the whole shop at once by live_change is asked as a rule, not attempted", () => {
    expect(parseAction('{"type":"live_change","product":null,"active":false}', "off all products", []))
      .toMatchObject({ type: "reply", text: expect.stringContaining("Say it as a rule") });
    expect(parseAction('{"type":"live_change","product":"other products","active":false}', "off all other products apart from the ones i asked you turn on", []))
      .toMatchObject({ type: "reply", text: expect.stringContaining("I'll show you the list before anything changes") });
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
    expect(aiPrompts[0]).toContain("- The chat's shop features (products, orders, reports, payouts, fees): on");
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

describe("no daily limit per seller (owner, 2026-10-07: \"remove daily limit\")", () => {
  const session = () => ({ phoneNumber: "233", userId: "seller", state: "awaiting_count", batchId: null, lastSubmittedBatchId: null }) as WhatsAppSession;
  const turns = (n: number, userId = "seller") => {
    db.tables.whatsapp_assistant_log = Array.from({ length: n }, (_, i) => ({
      id: i + 1, user_id: userId, stage: "idle", message: "hi", raw: "{}", outcome: "replied", created_at: new Date().toISOString(),
    }));
  };

  it("a seller with hundreds of turns today still has it", async () => {
    turns(500);
    expect(await assistantGate("seller")).toEqual({ ok: true });
  });

  it("the global ceiling rests it for everyone but admins, with no AI call", async () => {
    db.tables.app_settings = [{ key: "assistant_daily_limit", value: 3 }];
    turns(3, "someone-else");
    expect(await assistantGate("seller")).toEqual({ ok: false, reason: "ceiling" });
    expect(await assistantGate("admin")).toEqual({ ok: true });
    expect(await runAssistant("seller", "233", session(), "what else", "idle")).toBe("limited");
    expect(sent).toEqual([]);
    expect(aiCalls).toBe(0);
  });

  it("the kill switch turns it off, admins included", async () => {
    db.tables.app_settings = [{ key: "assistant_enabled", value: false }];
    expect(await assistantEnabled("admin")).toBe(false);
    db.tables.app_settings = [];
    expect(await assistantEnabled("admin")).toBe(true);
  });

});

describe("more of the Jumia API (owner, 2026-10-07: \"do all\")", () => {
  const NOW = new Date("2026-10-07T10:00:00Z"); // a Wednesday
  const parse = (json: string, msg: string) => parseAction(json, msg, [], {}, "GHS", { now: NOW });

  it("on/off counts go to the overview, whatever the AI picked", () => {
    expect(parse('{"type":"product_info","product":"Vintage Radio"}', "How many of my products are on")).toEqual({ type: "shop", filter: "all" });
    expect(parse('{"type":"reply","text":"I can\'t tell","link":null}', "How many of my products live on JUMIA is on and off")).toEqual({ type: "shop", filter: "all" });
    expect(parse('{"type":"listings","period":"today"}', "how many listings have I done today")).toEqual({ type: "listings", period: "today" });
  });

  it("rules for many products: the scope and every number from the message", () => {
    expect(parse('{"type":"bulk","scope":"all","price_pct":5}', "raise all my prices by 5%"))
      .toEqual({ type: "bulk", scope: "all", words: null, change: { kind: "price_pct", pct: 5 } });
    expect(parse('{"type":"bulk","scope":"all","price_pct":10}', "reduce all prices by 10%"))
      .toEqual({ type: "bulk", scope: "all", words: null, change: { kind: "price_pct", pct: -10 } });
    expect(parse('{"type":"bulk","scope":"matching","words":"perfumes","sale_pct":10}', "10% off all perfumes this weekend"))
      .toEqual({ type: "bulk", scope: "matching", words: "perfumes", change: { kind: "sale_pct", pct: 10, start: "2026-10-10", end: "2026-10-11" } });
    expect(parse('{"type":"bulk","scope":"out_of_stock","active":false}', "turn off everything that's out of stock"))
      .toEqual({ type: "bulk", scope: "out_of_stock", words: null, change: { kind: "status", active: false } });
    expect(parse('{"type":"bulk","scope":"all","sale":"end"}', "end the sale on all products"))
      .toEqual({ type: "bulk", scope: "all", words: null, change: { kind: "sale", sale: null } });
  });

  it("a rule the message doesn't back isn't carried out", () => {
    // No "all" or percentage: not a rule.
    expect(parse('{"type":"bulk","scope":"all","price_pct":5}', "raise the kettle price")).toEqual({ type: "unclear" });
    // A percentage that isn't in the message.
    expect(parse('{"type":"bulk","scope":"all","price_pct":5}', "raise all my prices a bit")).toMatchObject({ type: "reply", text: expect.stringContaining("By what percentage") });
    // A sale with no dates is asked for them.
    expect(parse('{"type":"bulk","scope":"all","sale_pct":10}', "10% off everything")).toMatchObject({ type: "reply", text: expect.stringContaining("needs its dates") });
    // "out of stock" the AI made up becomes all only when the message says the whole shop.
    expect(parse('{"type":"bulk","scope":"out_of_stock","active":true}', "turn on all products")).toMatchObject({ type: "bulk", scope: "all" });
    // Otherwise it's asked, never widened on a guess.
    expect(parse('{"type":"bulk","scope":"out_of_stock","stock":10}', "set all back to 10")).toMatchObject({ type: "reply", text: expect.stringContaining("Every product in your shop, or only the ones out of stock?") });
    // Products it can't name from the message.
    expect(parse('{"type":"bulk","scope":"matching","words":"shoes","price_pct":5}', "raise all prices by 5%")).toMatchObject({ type: "reply" });
  });

  it("content: copied from the message, or a rewrite they asked for", () => {
    expect(parse('{"type":"content_change","product":"blender","name":"Silver Crest 3 in 1 Blender 1.5L","rewrite":[]}', "change the blender's name to Silver Crest 3 in 1 Blender 1.5L"))
      .toEqual({ type: "content_change", product: "blender", request: { name: "Silver Crest 3 in 1 Blender 1.5L" } });
    expect(parse('{"type":"content_change","product":"wellington boot","rewrite":["description"]}', "rewrite the description of the wellington boot"))
      .toEqual({ type: "content_change", product: "wellington boot", request: { rewrite: ["description"], instructions: "rewrite the description of the wellington boot" } });
    // A name it made up is left out, and with nothing left it asks.
    expect(parse('{"type":"content_change","product":"blender","name":"Best Blender Ever","rewrite":[]}', "change the blender's name"))
      .toMatchObject({ type: "reply", text: expect.stringContaining("What should I change on it?") });
  });

  it("reports, payouts in detail, brands, categories, shops and the warehouse", () => {
    expect(parse('{"type":"report","kind":"best_sellers","period":"month"}', "my best sellers")).toEqual({ type: "report", kind: "best_sellers", period: "month" });
    expect(parse('{"type":"report","kind":"top"}', "top")).toEqual({ type: "unclear" });
    expect(parse('{"type":"payout_detail","mode":"breakdown","statement":"GH11-20261005"}', "fees on statement GH11-20261005"))
      .toEqual({ type: "payout_detail", mode: "breakdown", statement: "GH11-20261005" });
    expect(parse('{"type":"payout_detail","mode":"breakdown","statement":"X99"}', "fees on my last statement"))
      .toEqual({ type: "payout_detail", mode: "breakdown", statement: null });
    expect(parse('{"type":"brand_check","brand":"Lattafa","product":null}', "is Lattafa a brand on jumia?")).toEqual({ type: "brand_check", brand: "Lattafa", product: null });
    expect(parse('{"type":"category_info","product":"perfume"}', "what does jumia need to list a perfume")).toEqual({ type: "category_info", product: "perfume" });
    expect(parse('{"type":"shops"}', "which shops do I have")).toEqual({ type: "shops" });
    expect(parse('{"type":"warehouse_order","items":[{"product":"kettle","quantity":50}]}', "send 50 of the kettle to jumia warehouse on 20 Oct"))
      .toEqual({ type: "warehouse_order", items: [{ product: "kettle", quantity: 50 }], date: "2026-10-20" });
    expect(parse('{"type":"warehouse_order","items":[{"product":"kettle","quantity":60}]}', "send 50 of the kettle to jumia warehouse"))
      .toMatchObject({ type: "reply" });
    expect(parse('{"type":"warehouse_shipped","po":"123AB","tracking":"DHL998877","carrier":null}', "PO 123AB shipped, tracking DHL998877"))
      .toEqual({ type: "warehouse_shipped", po: "123AB", tracking: "DHL998877", carrier: null });
    expect(parse('{"type":"warehouse_shipped","po":"123AB","tracking":"XYZ"}', "PO 123AB shipped")).toMatchObject({ type: "reply" });
  });
});

describe("the chat's billed commands, understood (owner, 2026-10-07)", () => {
  it("polish and the shop health report are actions", () => {
    expect(parseAction('{"type":"polish","product":2}', "can you polish the photos of product 2", [])).toEqual({ type: "polish", seq: 2 });
    // A number the seller didn't write isn't taken.
    expect(parseAction('{"type":"polish","product":3}', "polish my photos", [])).toEqual({ type: "polish", seq: null });
    expect(parseAction('{"type":"health_report"}', "how is my shop doing?", [])).toEqual({ type: "health_report" });
  });

  it("the prompt lists them with their prices, and the commands", async () => {
    aiReplies.push('{"type":"reply","text":"Hi!","link":null}');
    await runAssistant("seller", "233", { phoneNumber: "233", userId: "seller", state: "awaiting_count", batchId: null, lastSubmittedBatchId: null } as never, "hi", "idle");
    expect(aiPrompts[0]).toContain('{"type":"polish","product":<the product number from the message> or null}');
    expect(aiPrompts[0]).toContain("2 credits each");
    expect(aiPrompts[0]).toContain('{"type":"health_report"}');
    expect(aiPrompts[0]).toContain("Only polish, the report and confirmed changes to live products cost credits");
  });
});

// The owner's web chat, 2026-10-07: the bot asked "What variation(s) do you
// have?" for a drafted bodysuit, and the answer carried the price, the sizes
// and the colours. It was refused once ("isn't one of the drafts here") and
// then set all 54 of the category's sizes.
describe("one message with a draft's price, sizes and colours", () => {
  const MSG = "Price: 130gh \nSizes: Large, Medium, Small.\nColors: cream, black and brown";
  const asked = { listingId: "l1", field: "__variation" };
  const session = () =>
    ({ phoneNumber: "233", userId: "seller", state: "awaiting_confirmation", batchId: "b1", lastSubmittedBatchId: null, awaitingValueFor: asked }) as unknown as WhatsAppSession;

  beforeEach(() => {
    db.tables.listings = [{
      id: "l1", user_id: "seller", whatsapp_batch_id: "b1", whatsapp_seq: 1, status: "draft", category_code: 100,
      title: "3-Piece Thong Bodysuit - Seamless, Tummy Control, Adjustable Straps", selling_price: 130, color: "Beige, Black, Brown",
    }];
    db.tables.variants = [];
    db.tables.whatsapp_sessions = [{ phone_number: "233", user_id: "seller", state: "awaiting_confirmation", awaiting_value_for: asked }];
  });

  it("sets the sizes it names and the colours in the seller's words, and closes the size question", async () => {
    aiReplies.push('{"type":"edit","edits":[{"products":[1],"said":"Large, Medium, Small.","changes":{"variations":["Large","Medium","Small"],"color":"cream, black and brown"},"ask":false}]}');
    expect(await runAssistant("seller", "233", session(), MSG, "review")).toBe("handled");
    expect((db.tables.variants as { variation: string }[]).map((v) => v.variation)).toEqual(["L", "M", "S"]);
    expect(db.tables.listings[0].color).toBe("cream, black and brown");
    expect(db.tables.whatsapp_sessions[0].awaiting_value_for).toBeNull();
    expect(sent.at(-1)!.body).not.toContain("isn't one of the drafts");
  });

  it("saves the options the AI matched the seller's words to", async () => {
    aiReplies.push('{"type":"edit","edits":[{"products":[1],"said":null,"changes":{"variations":[{"said":"Large","option":"L"},{"said":"Medium","option":"M"},{"said":"Small","option":"S"}]},"ask":false}]}');
    await runAssistant("seller", "233", session(), MSG, "review");
    expect((db.tables.variants as { variation: string }[]).map((v) => v.variation)).toEqual(["L", "M", "S"]);
    expect(db.tables.whatsapp_sessions[0].awaiting_value_for).toBeNull();
  });

  it("the AI's copy of every option still sets only the three", async () => {
    aiReplies.push('{"type":"edit","edits":[{"products":[1],"said":"3-Piece Thong Bodysuit","changes":{"variations":["S","M","L","XL","XXL"],"color":"Beige, Black, Brown"},"ask":false}]}');
    await runAssistant("seller", "233", session(), MSG, "review");
    expect((db.tables.variants as { variation: string }[]).map((v) => v.variation)).toEqual(["S", "M", "L"]);
    expect(db.tables.listings[0].color).toBe("cream, black and brown");
  });
});

// Owner, 2026-10-08: "let it be able to make a number of Different API calls
// to the vendor shop and get info and data and organize them to fit the
// sellers request". The reads themselves are in shop-research.test.ts.
describe("research: several reads of the shop, answered together", () => {
  const links = assistantLinks();
  const newest = (limit: number) => ({
    type: "research", needs: [{ source: "products", sort: "newest", filter: "all", words: null, limit, since: null }],
  });

  it("\"the last 10 products uploaded\" is their newest products, never a batch of 10", () => {
    // The owner's web chat: read as listing 10 products, then answered "I can't".
    const msg = "the full list of the last 10products uploaded on my shop";
    expect(parseAction('{"type":"list","count":10}', msg, [], links)).toEqual(newest(10));
    expect(parseAction('{"type":"restart"}', msg, [], links)).toEqual(newest(10));
    expect(parseAction('{"type":"reply","text":"I can\'t list your products here.","link":null}', msg, [], links)).toEqual(newest(10));
    // And as the hello menu.
    expect(parseAction('{"type":"reply","text":"Hi there! Here is what I can do","link":null}', "show me my latest products", [], links)).toEqual(newest(10));
    expect(parseAction('{"type":"reply","text":"x","link":null}', "thanks", [], links)).toEqual({ type: "reply", text: "x", link: null });
    expect(parseAction("nonsense", "what are the 5 items I added recently", [], links)).toEqual(newest(5));
  });

  it("listing new products now stays listing", () => {
    expect(parseAction('{"type":"list","count":5}', "I want to list 5 new products", [], links)).toEqual({ type: "list", count: 5 });
    expect(parseAction('{"type":"list","count":3}', "let's list my last 3 products", [], links)).toEqual({ type: "list", count: 3 });
  });

  it("keeps known reads only, at most four, with the seller's own words", () => {
    const raw = JSON.stringify({ type: "research", needs: [
      { source: "products", sort: "price_high", filter: "on_sale", words: "perfumes", limit: 99 },
      { source: "products", sort: "newest", words: "gold medals" },
      { source: "orders", period: "week", status: "cancelled", limit: 5 },
      { source: "orders", period: "week", status: "cancelled", limit: 5 },
      { source: "secrets" },
      { source: "payouts" },
      { source: "product_sales", period: "fortnight" },
      { source: "pandaworld_listings", period: "today" },
    ] });
    expect(parseAction(raw, "my priciest perfumes on sale, cancelled orders this week, payouts and sales", [], links)).toEqual({
      type: "research", needs: [
        { source: "products", sort: "price_high", filter: "on_sale", words: "perfumes", limit: 30, since: null },
        // "gold medals" isn't in the message: not searched for.
        { source: "products", sort: "newest", filter: "all", words: null, limit: 10, since: null },
        { source: "orders", period: "week", status: "CANCELED", limit: 5 },
        { source: "payouts" },
      ],
    });
    expect(parseAction('{"type":"research","needs":[{"source":"secrets"}]}', "anything", [], links)).toEqual({ type: "unclear" });
  });

  it("a product's name on its own is that product, from the bot's list or not", async () => {
    const names = ["Malta Guinness Soft Drink - 330ml Bottles, Pack of 6 (6 Bottles)", "Water Wave Lace Front Wig - 13x4, 20 Inch"];
    expect(isProductName("Malta Guinness Soft Drink - 330ml Bottles, Pack of 6", names)).toBe(true);
    expect(isProductName("Water Wave Lace Front Wig", names)).toBe(true);
    expect(isProductName("Malta Guinness Soft Drink - 330ml Bottles, Pack of 6…", names)).toBe(true);
    expect(isProductName("is the Water Wave Lace Front Wig live?", names)).toBe(false);
    expect(isProductName("Lace Wig", names)).toBe(false);
    expect(isProductName("Water Wave Lace Front Wig Bundle", names)).toBe(false);
    expect(isProductName("hi there friend", names)).toBe(false);

    db.tables.jumia_products = [{ user_id: "seller", product_sid: "x", seller_sku: "MALTA-6", name: names[0] }];
    aiReplies.push('{"type":"reply","text":"I\'m sorry, I can only look up products related to your shop.","link":null}');
    shopCalls.length = 0;
    await runAssistant("seller", "233", { phoneNumber: "233", userId: "seller", state: "awaiting_count", batchId: null, lastSubmittedBatchId: null } as never, "Malta Guinness Soft Drink - 330ml Bottles, Pack of 6", "idle");
    expect(shopCalls).toEqual([["answerProductInfo", "Malta Guinness Soft Drink - 330ml Bottles, Pack of 6"]]);
  });

  it("is in the prompt, with the owner's question as its example", async () => {
    aiReplies.push('{"type":"reply","text":"Hi!","link":null}');
    await runAssistant("seller", "233", { phoneNumber: "233", userId: "seller", state: "awaiting_count", batchId: null, lastSubmittedBatchId: null } as never, "hello", "idle");
    const prompt = aiPrompts[aiPrompts.length - 1];
    expect(prompt).toContain('{"type":"research","needs":[');
    expect(prompt).toContain('"the full list of the last 10 products uploaded on my shop" → {"type":"research"');
  });
});

// The owner's web chat, 2026-10-08 (09:34 to 10:04): after the bot asked
// how many products they're listing, product changes were read as counts.
describe("a change to a product is never a count", () => {
  const links = assistantLinks();
  const stock = (product: string, n: number) => ({ type: "live_change", product, change: { kind: "stock", stock: n } });

  it("reads which product, which field and the value", () => {
    expect(changeToAsked("restock the foladable drone to. 10")).toEqual({ target: "foladable drone", field: "stock", value: 10, many: false, restock: true });
    expect(changeToAsked("Change drone to 10 psc")).toMatchObject({ target: "drone", field: "stock", value: 10 });
    expect(changeToAsked("Change Foldable Drone with HD Camera to 10")).toMatchObject({ target: "Foldable Drone with HD Camera", field: null, value: 10 });
    expect(changeToAsked("set the price of the kettle to GHS 120")).toMatchObject({ target: "kettle", field: "price", value: 120 });
    expect(changeToAsked("change the stock of the lat 10 to 20")).toMatchObject({ target: "lat 10", field: "stock", value: 20, many: true });
    expect(changeToAsked("restock all back to 10")).toMatchObject({ target: "all", field: "stock", value: 10, many: true, restock: true });
    expect(changeToAsked("change the price to 10")).toBeNull();
    expect(changeToAsked("set it to 10")).toBeNull();
    expect(changeToAsked("I want to list 10 products")).toBeNull();
  });

  it("the owner's messages, whatever the AI made of them", () => {
    expect(parseAction('{"type":"restart"}', "restock the foladable drone to. 10", [], links)).toEqual(stock("foladable drone", 10));
    expect(parseAction('{"type":"list","count":3}', "Change drone to 10 psc", [], links)).toEqual(stock("drone", 10));
    expect(parseAction('{"type":"list","count":3}', "Change Foldable Drone with HD Camera to 10pcs", [], links)).toEqual(stock("Foldable Drone with HD Camera", 10));
    // "to 10" alone could be its stock or its price: asked, never a form for 10 products.
    const r = parseAction('{"type":"list","count":10}', "Change Foldable Drone with HD Camera to 10", [], links);
    expect(r).toMatchObject({ type: "reply" });
    expect((r as { text: string }).text).toContain("The *stock* or the *price* of the Foldable Drone with HD Camera?");
    // A draft's own name is still the draft's edit, left to the AI's reading.
    expect(parseAction('{"type":"unclear"}', "change the cotton t-shirt to 10", [SHIRT], links)).toEqual({ type: "unclear" });
  });

  it("\"those\" and \"the last 10\" are the products the bot just listed, never the whole shop", () => {
    const listed = (n: number) => ({ type: "bulk", scope: "listed", words: null, change: { kind: "stock", stock: n } });
    const garbage = '{"type":"edit","edits":[{"products":[2],"said":null,"changes":{"color":"black,blue,grey"},"ask":false}]}';
    expect(parseAction(garbage, "restock all back to 10", [SHIRT], links, "GHS", { listed: true })).toEqual(listed(10));
    expect(parseAction(garbage, "change the stock of the lat 10 to 20", [SHIRT], links, "GHS", { listed: true })).toEqual(listed(20));
    // The AI's own "listed" for "restock all": still only those.
    expect(parseAction('{"type":"bulk","scope":"listed","words":null,"stock":10}', "restock all back to 10", [], links, "GHS", { listed: true })).toEqual(listed(10));
    // Nothing listed lately: restocking all is what's out of stock; "the last 10" asks which.
    expect(parseAction(garbage, "restock all back to 10", [SHIRT], links)).toEqual({ type: "bulk", scope: "out_of_stock", words: null, change: { kind: "stock", stock: 10 } });
    expect(parseAction(garbage, "change the stock of the lat 10 to 20", [SHIRT], links)).toMatchObject({ type: "reply", text: expect.stringContaining("Which products?") });
    expect(parseAction('{"type":"bulk","scope":"listed","words":null,"stock":10}', "set those to 10 pcs", [], links)).toMatchObject({ type: "reply", text: expect.stringContaining("Which products?") });
  });

  it("carries a change to the listed products out on exactly those", async () => {
    aiReplies.push('{"type":"bulk","scope":"listed","words":null,"stock":20}');
    shopCalls.length = 0;
    const at = new Date().toISOString();
    await runAssistant("seller", "233", {
      phoneNumber: "233", userId: "seller", state: "awaiting_count", batchId: null, lastSubmittedBatchId: null,
      lastListed: { sids: ["s1", "s2"], what: "The 10 newest products", at },
    } as never, "change the stock of the last 10 to 20", "idle");
    expect(shopCalls).toEqual([["proposeBulkChange", "listed", null, { kind: "stock", stock: 20 }, ["s1", "s2"]]]);
    expect(aiPrompts[aiPrompts.length - 1]).toContain('You just listed 2 of their Jumia products for them (The 10 newest products).');
  });

  it("only listing words start or stop a batch", () => {
    expect(parseAction('{"type":"list","count":3}', "Let's enter Shop assistant mode", [], links)).toEqual({ type: "help" });
    expect(parseAction('{"type":"list","count":3}', "let's enter listing mode", [], links)).toEqual({ type: "restart" });
    expect(parseAction('{"type":"restart"}', "Stop listing", [], links)).toEqual({ type: "restart" });
  });

  it("no colour warning when the message doesn't mention colour", () => {
    const raw = '{"type":"edit","edits":[{"products":[2],"said":null,"changes":{"variations":[{"said":"Large","option":"L"},{"said":"Medium","option":"M"}],"color":"Navy Blue"},"ask":false}]}';
    expect(parseAction(raw, "Large and Medium", [SHIRT], links)).toEqual({ type: "edit", edits: [{ seqs: [2], changes: { variations: ["L", "M"] }, ask: false }], dropped: [] });
    expect(parseAction(raw, "Large and Medium, colour navy", [SHIRT], links)).toMatchObject({ dropped: ["colour"] });
  });
});
