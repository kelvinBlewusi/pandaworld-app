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

const sent: { kind: string; body: string; rows?: string[]; button?: string }[] = [];
jest.mock("@/lib/whatsapp/client", () => ({
  sendTextIfConfigured:    async (_to: string, body: string) => { sent.push({ kind: "text", body }); },
  sendButtonsIfConfigured: async (_to: string, body: string, b: { id: string }[]) => { sent.push({ kind: "buttons", body, rows: b.map((x) => x.id) }); },
  sendCtaUrlIfConfigured:  async (_to: string, body: string, button: string) => { sent.push({ kind: "cta", body, button }); },
  sendListIfConfigured:    async (_to: string, body: string, _b: string, r: { id: string }[]) => { sent.push({ kind: "list", body, rows: r.map((x) => x.id) }); },
}));

const orderCalls: string[] = [];
jest.mock("@/lib/whatsapp/orders", () => ({
  handleOrderMessage: async (_u: string, _p: string, text: string) => { orderCalls.push(text); return true; },
}));

const aiReplies: string[] = [];
let aiCalls = 0;
jest.mock("@/lib/ai/gemini-client", () => ({
  callGeminiBackend: async (model: string) => {
    aiCalls++;
    const text = aiReplies.shift();
    if (text == null) throw new Error("no AI reply scripted");
    return { text, model, backend: "vertex" };
  },
}));

const SIZES = ["S", "M", "L", "XL", "XXL"];
jest.mock("@/lib/jumia/categories", () => ({
  getCategoryAttributes: async (code: number) =>
    code === 100 ? [{ name: "variation", label: "Size", type: "enum", allowed_values: SIZES, is_variant: true }] : [],
}));

import {
  assistantEnabled, messageNumbers, parseAction, plainQuickEdit, runAssistant, verifyChanges, type ProductFacts,
} from "@/lib/whatsapp/assistant";
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

  it("drops the whole variation list rather than quietly losing one of them", () => {
    const r = verifyChanges({ variations: ["Huge", "Large"] }, "make it Large", { options: [], variations: [] });
    expect(r).toEqual({ changes: {}, dropped: ["variations"] });
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
    expect(sent).toEqual([{ kind: "cta", body: "You have 9 credits: enough for about 4 WhatsApp listings. A listing costs 2 credits when it goes live on Jumia.", button: "Buy credits" }]);
  });

  it("shows the orders", async () => {
    aiReplies.push('{"type":"orders"}');
    expect(await runAssistant("seller", "233", session(), "any new orders for me?", "idle")).toBe("handled");
    expect(orderCalls).toEqual(["orders"]);
  });

  it("answers from what the bot does", async () => {
    aiReplies.push('{"type":"answer","text":"A WhatsApp listing costs 2 credits, charged only when it goes live."}');
    expect(await runAssistant("seller", "233", session(), "how much does a listing cost", "idle")).toBe("handled");
    expect(sent[0]).toEqual({ kind: "text", body: "A WhatsApp listing costs 2 credits, charged only when it goes live." });
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

  it("leaves small talk to the usual reply", async () => {
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
