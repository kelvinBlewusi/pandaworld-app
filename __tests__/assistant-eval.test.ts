/**
 * The assistant's test set and its runner (lib/evals/). The real AI is only
 * called on the server (/admin/assistant-tests); here the set is checked for
 * mistakes in the cases themselves, the comparison is checked, and a whole
 * run goes through with a stand-in AI.
 */

import { FakeDb } from "./helpers/fake-supabase";

let db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({ createServerClient: () => db }));
let answer: (prompt: string) => string | Promise<string> = () => '{"type":"reply","text":"Hi! 👋","link":null}';
const prompts: string[] = [];
jest.mock("@/lib/ai/gemini-client", () => ({
  callGeminiBackend: async (_m: string, parts: { text?: string }[]) => {
    const p = parts.map((x) => x.text ?? "").join("\n");
    prompts.push(p);
    return { text: await answer(p) };
  },
}));

import { ASSISTANT_CASES, type EvalCase } from "@/lib/evals/assistant-cases";
import { byArea, matchesShape, passes, queueRun, routing, runCase, workOnRuns } from "@/lib/evals/assistant-eval";
import { contextText, frontDoor, namesInMessage, openQuestion } from "@/lib/assistant-v2/front-door";

const ACTIONS = new Set([
  "edit", "submit", "list", "restart", "review", "orders", "credits", "help", "reply", "live_change", "product_info", "product_text", "fees", "stock", "shop",
  "order_status", "sales", "listings", "payouts", "payout_detail", "report", "bulk", "content_change", "brand_check", "category_info", "shops",
  "warehouse_stock", "warehouse_order", "warehouse_shipped", "polish", "health_report", "research", "note", "unclear",
]);
const STAGES = new Set(["review", "sent", "idle", "starting", "collecting", "drafting"]);

beforeEach(() => { db = new FakeDb(); prompts.length = 0; });

describe("the test set", () => {
  it("has enough real messages, each case well-formed", () => {
    expect(ASSISTANT_CASES.length).toBeGreaterThanOrEqual(150);
    expect(ASSISTANT_CASES.filter((c) => c.src.startsWith("log ")).length).toBeGreaterThanOrEqual(120);
    const ids = ASSISTANT_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of ASSISTANT_CASES) {
      expect(STAGES.has(c.stage)).toBe(true);
      expect(c.msg.trim().length).toBeGreaterThan(0);
      expect(c.ok.length).toBeGreaterThan(0);
      for (const shape of c.ok) expect({ id: c.id, type: ACTIONS.has(shape.type) }).toEqual({ id: c.id, type: true });
      // An edit can only be right where there are drafts to edit.
      if (c.ok.every((s) => s.type === "edit")) expect({ id: c.id, drafts: (c.drafts ?? []).length > 0 }).toEqual({ id: c.id, drafts: true });
      // "Those" only means something after a list.
      if (c.ok.some((s) => s.scope === "listed")) expect({ id: c.id, listed: !!c.listed }).toEqual({ id: c.id, listed: true });
    }
  });

  it("covers every area", () => {
    expect(new Set(ASSISTANT_CASES.map((c) => c.area))).toEqual(new Set(["listing", "drafts", "live_changes", "shop_info", "orders", "money", "account_help", "chat"]));
  });
});

describe("comparing an action with what's expected", () => {
  it("type, nested fields, \"contains\" and sets", () => {
    const live = { type: "live_change", product: "foladable drone", change: { kind: "stock", stock: 10 } };
    expect(matchesShape(live, { type: "live_change", product: "~DRONE", "change.kind": "stock", "change.stock": 10 })).toBe(true);
    expect(matchesShape(live, { type: "live_change", "change.stock": 20 })).toBe(false);
    expect(matchesShape(live, { type: "list" })).toBe(false);
    const edit = { type: "edit", edits: [{ seqs: [1], changes: { variations: ["S", "M", "L"] }, ask: false }], dropped: [] };
    expect(matchesShape(edit, { type: "edit", "edits.0.changes.variations": ["L", "M", "S"], dropped: [] })).toBe(true);
    expect(matchesShape(edit, { type: "edit", "edits.0.changes.variations": ["L", "M"] })).toBe(false);
    const sales = { type: "sales", period: "yesterday", status: ["READY_TO_SHIP", "CANCELED"] };
    expect(matchesShape(sales, { type: "sales", status: ["CANCELED", "READY_TO_SHIP"] })).toBe(true);
    expect(matchesShape({ type: "sales", status: "CANCELED" }, { type: "sales", status: "CANCELED" })).toBe(true);
  });

  it("any acceptable answer passes", () => {
    const c = { ok: [{ type: "reply" }, { type: "help" }] } as unknown as EvalCase;
    expect(passes({ type: "help" }, c)).toBe(true);
    expect(passes({ type: "restart" }, c)).toBe(false);
  });
});

describe("running a case", () => {
  const byId = (id: string) => ASSISTANT_CASES.find((c) => c.id === id)!;

  it("uses the chat's own prompt with the case's conversation and drafts", async () => {
    const r = await runCase(byId("draft-price-is-product-3"), "gemini-2.5-flash-lite");
    expect(prompts[0]).toContain("You are PandaWorld's Jumia Listing Assistant");
    expect(prompts[0]).toContain('3. "White Maple Leaf Flower Earrings - Gold Tone"');
    expect(prompts[0]).toContain("Bot: ✅ Price set to GH₵150 for product 1");
    expect(prompts[0]).toContain('The seller\'s new message: "No the 150 is product 3 price"');
    expect(r).toMatchObject({ id: "draft-price-is-product-3", pass: false });
  });

  it("scores the deployed checks and the AI's choice alone separately", async () => {
    // The owner's drone message, read as a batch of 10: the AI alone fails, the word rule passes it.
    answer = () => '{"type":"list","count":10}';
    const r = await runCase(byId("live-change-drone-psc"), "m");
    expect(r).toMatchObject({ pass: true, bare: false });
    answer = () => '{"type":"live_change","product":"drone","stock":10}';
    expect(await runCase(byId("live-change-drone-psc"), "m")).toMatchObject({ pass: true, bare: true });
  });

  it("applies the same product-name check as the chat", async () => {
    answer = () => '{"type":"reply","text":"I\'m sorry, I can only look up products related to your shop.","link":null}';
    expect(await runCase(byId("shop-name-malta"), "m")).toMatchObject({ pass: true, bare: false });
  });

  it("a call that fails twice is an error, not a wrong answer", async () => {
    answer = () => { throw new Error("timeout"); };
    expect(await runCase(byId("chat-hi"), "m")).toMatchObject({ pass: false, error: "timeout" });
  });
});

describe("a run", () => {
  it("is queued, worked through in groups, saved, and scored by area", async () => {
    answer = () => '{"type":"reply","text":"Hi! 👋","link":null}';
    const id = await queueRun({ model: "gemini-2.5-flash-lite" });
    let r = await workOnRuns(10 * 60_000);
    expect(r).toEqual({ runId: id, done: ASSISTANT_CASES.length, total: ASSISTANT_CASES.length });
    const row = (db.tables.assistant_eval_runs as Record<string, unknown>[])[0] as { status: string; passed: number; results: { pass: boolean; area: string }[] };
    expect(row.status).toBe("done");
    expect(row.results).toHaveLength(ASSISTANT_CASES.length);
    // Every case a plain reply is right for passes (and a few the word rules turn into the right answer); the rest don't.
    const replyOk = ASSISTANT_CASES.filter((c) => c.ok.some((s) => s.type === "reply" && Object.keys(s).length === 1)).length;
    expect(row.passed).toBe(row.results.filter((x) => x.pass).length);
    expect(row.passed).toBeGreaterThanOrEqual(replyOk);
    expect(row.passed).toBeLessThan(ASSISTANT_CASES.length / 2);
    expect(byArea(row.results as never).find((a) => a.area === "chat")!.passed).toBeGreaterThan(10);
    // Nothing left to do.
    r = await workOnRuns(60_000);
    expect(r.runId).toBeNull();
  });

  it("a case the AI doesn't answer in 40 s is an error, and the worker stops in time", async () => {
    jest.useFakeTimers();
    try {
      answer = () => new Promise<string>(() => {});
      await queueRun({ model: "m" });
      const work = workOnRuns(100_000);
      await jest.advanceTimersByTimeAsync(100_000);
      const r = await work;
      expect(r.done).toBe(20);
      const row = (db.tables.assistant_eval_runs as Record<string, unknown>[])[0] as { status: string; errors: number; locked_until: unknown; results: { error?: string }[] };
      expect(row).toMatchObject({ status: "running", errors: 20, locked_until: null });
      expect(row.results[0].error).toBe("no answer within 40 s");
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("the front door prototype", () => {
  const byId = (id: string) => ASSISTANT_CASES.find((c) => c.id === id)!;
  const sortThenRead = (area: string, action: string) => (p: string) => (p.includes('Reply with JSON only: {"area"') ? `{"area":"${area}"}` : action);

  it("sorts the message first, then reads it with only that area's actions", async () => {
    answer = sortThenRead("live_products", '{"type":"live_change","product":"drone","stock":10}');
    const r = await runCase(byId("live-change-drone-psc"), "gemini-2.5-flash", { pipeline: "front_door", router: "gemini-2.5-flash-lite" });
    expect(r).toMatchObject({ pass: true, bare: true, asked: false, routed: "live_products" });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("This message is about: live products.");
    expect(prompts[1]).toContain('{"type":"live_change"');
    expect(prompts[1]).not.toContain('{"type":"list","count"');
  });

  it("no word rules: a misreading stays wrong", async () => {
    answer = sortThenRead("listing", '{"type":"list","count":10}');
    expect(await runCase(byId("live-change-drone-psc"), "m", { pipeline: "front_door" })).toMatchObject({ pass: false, asked: false, routed: "listing" });
  });

  it("a question back is right where any reply is", async () => {
    answer = sortThenRead("live_products", '{"type":"clarify","question":"Which products?","options":["The freezer","Others"]}');
    expect(await runCase(byId("live-stock-those"), "m", { pipeline: "front_door" })).toMatchObject({ pass: true, asked: true });
  });

  it("a question back is counted apart, not as right", async () => {
    answer = sortThenRead("live_products", '{"type":"clarify","question":"Change its stock or its price?","options":["Stock to 10","Price to 10"]}');
    const r = await runCase(byId("live-change-drone-psc"), "m", { pipeline: "front_door" });
    expect(r).toMatchObject({ pass: false, asked: true });
    expect(r.got).toContain("Change its stock or its price?");
  });

  it("a change with no drafts is read as a live product change", async () => {
    answer = sortThenRead("drafts", '{"type":"reply","text":"ok","link":null}');
    const r = await runCase(byId("live-change-drone-psc"), "m", { pipeline: "front_door" });
    expect(r.routed).toBe("live_products");
  });

  it("gives the AI the open question, the list just shown and the shop's matching names", () => {
    expect(openQuestion({ stage: "collecting", conversation: [], waitingFor: undefined })?.about).toContain("product being sent");
    expect(openQuestion({ stage: "idle", conversation: ["Bot: How many products are you listing today?"] })?.about).toContain("how many products");
    expect(openQuestion({ stage: "idle", conversation: ["Bot: Done ✅"] })).toBeNull();
    expect(namesInMessage("Pedestal fan", ["Pedestal Fan - 5-Blade Airflow, Metal Grille (Black)", "Foldable Drone"])).toEqual(["Pedestal Fan - 5-Blade Airflow, Metal Grille (Black)"]);
    const text = contextText({
      stage: "idle", message: "Pedestal fan", conversation: [], drafts: [], listed: { count: 10, what: "your 10 newest products" },
      seller: [], links: {}, currency: "GHS", web: true, shopNames: ["Pedestal Fan - 5-Blade Airflow, Metal Grille (Black)"],
    });
    expect(text).toContain("Products you last listed for them: 10 (your 10 newest products)");
    expect(text).toContain('Products in their Jumia shop the message names: "Pedestal Fan');
  });

  it("every area knows what PandaWorld can do, so a reply never invents it (owner's web chat, 2026-10-08)", async () => {
    answer = sortThenRead("drafts", '{"type":"reply","text":"ok","link":null}');
    await runCase(byId("draft-v-wig-price"), "m", { pipeline: "front_door" });
    expect(prompts[1]).toContain("This message is about: drafts or live products.");
    expect(prompts[1]).toContain("What PandaWorld can do (all true; nothing else is: there is no team doing things by hand):");
    expect(prompts[1]).toContain("rewritten by AI");
  });

  it("sees the products just listed with where each is, and the bot asking for something", () => {
    const c = byId("live-approved-ones");
    const text = contextText({
      stage: "idle", message: c.msg, conversation: c.ctx ?? [], drafts: [], listed: c.listed ?? null, seller: [], links: {}, currency: "GHS", web: true,
    });
    expect(text).toContain('4. "Quilted Car Cover - Waterproof, Dustproof, All-Weather Protection (Default)" · off · approved · stock 1');
    expect(openQuestion({ stage: "review", conversation: ["Bot: Okay, please provide the new description text for 'Crocheted Beanie Hat'."] })?.about).toContain("please provide the new description");
  });

  it("reads with a second area when the sorting names one, and takes the first of two answers", async () => {
    answer = (p) => (p.includes('Reply with JSON only: {"area"') ? '{"area":"listing","also":"live_products"}'
      : '[{"type":"sales","period":"yesterday","status":null},{"type":"sales","period":"today","status":null}]');
    const r = await frontDoor({
      stage: "idle", message: "change the description of the kettle", conversation: [], drafts: [], listed: null, seller: [], links: {}, currency: "GHS", web: true,
    }, { router: "a", reader: "b" });
    expect(prompts[1]).toContain("This message is about: listing or live products.");
    expect(prompts[1]).toContain('{"type":"content_change"');
    expect(r.action).toMatchObject({ type: "sales", period: "yesterday" });
  });

  it("when the reading call is slow, Flash-Lite reads it instead of leaving them waiting", async () => {
    jest.useFakeTimers();
    try {
      answer = (p) => (p.includes('Reply with JSON only: {"area"') ? '{"area":"orders"}'
        : prompts.length === 2 ? new Promise<string>(() => {}) : '{"type":"orders"}');
      const c = byId("chat-hi");
      const read = frontDoor({
        stage: c.stage, message: "orders", conversation: [], drafts: [], listed: null, seller: [], links: {}, currency: "GHS", web: true,
      }, { router: "gemini-2.5-flash-lite", reader: "gemini-2.5-flash" }, { feature: "assistant_eval" }, { routerMs: 10_000, readerMs: 25_000, fallbackMs: 12_000 });
      await jest.advanceTimersByTimeAsync(26_000);
      const r = await read;
      expect(r.action).toEqual({ type: "orders" });
      expect(r.raw).toContain("(read by gemini-2.5-flash-lite: gemini-2.5-flash took over 25 s)");
      expect(prompts).toHaveLength(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it("when the sorting model refuses, the reading model sorts (owner's WhatsApp, 2026-10-08: Vertex 404)", async () => {
    answer = (p) => {
      if (p.includes('Reply with JSON only: {"area"') && prompts.length === 1) throw new Error("Publisher model gemini-2.5-flash-lite was not found");
      return p.includes('Reply with JSON only: {"area"') ? '{"area":"orders"}' : '{"type":"orders"}';
    };
    const r = await frontDoor({
      stage: "idle", message: "orders", conversation: [], drafts: [], listed: null, seller: [], links: {}, currency: "GHS", web: true,
    }, { router: "gemini-2.5-flash-lite", reader: "gemini-2.5-flash" }, { feature: "assistant_eval" }, { routerMs: 10_000, readerMs: 25_000, fallbackMs: 12_000 });
    expect(r.action).toEqual({ type: "orders" });
    expect(prompts).toHaveLength(3);
  });

  it("on Gemini 3 (AI Studio), the backup on Vertex sorts and reads when it fails", async () => {
    // The first sorting call and the first reading call (both Gemini 3) fail.
    answer = (p) => {
      if (prompts.length === 1 || prompts.length === 3) throw new Error("AI Studio is down");
      return p.includes('Reply with JSON only: {"area"') ? '{"area":"orders"}' : '{"type":"orders"}';
    };
    const r = await frontDoor({
      stage: "idle", message: "orders", conversation: [], drafts: [], listed: null, seller: [], links: {}, currency: "GHS", web: true,
    }, { router: "gemini-3.1-flash-lite", reader: "gemini-3.1-flash-lite" }, { feature: "assistant_eval" }, { routerMs: 10_000, readerMs: 25_000, fallbackMs: 12_000 });
    // Sorting failed, the backup sorted; reading failed, the backup read.
    expect(prompts).toHaveLength(4);
    expect(r.action).toEqual({ type: "orders" });
    expect(r.raw).toContain("(read by gemini-2.5-flash-lite: AI Studio is down)");
  });

  it("a tapped answer is read in its question's area, the question's words as said (owner's WhatsApp, 2026-10-08)", async () => {
    const name = "Backless Bodysuit - Adjustable Straps, Design";
    answer = () => `{"type":"content_change","product":"Backless Thong Bodysuit","name":"${name}","rewrite":[]}`;
    const r = await frontDoor({
      stage: "review", message: "Yes", drafts: [], listed: null, seller: [], links: {}, currency: "GHS", web: false,
      conversation: ["Seller: The last submitted product", `Bot: Is the new name '${name}' for the Backless Thong Bodysuit?`],
      answered: { area: "live_products" },
    }, { router: "gemini-2.5-flash-lite", reader: "gemini-2.5-flash" });
    // Not sorted again: one call, in live products.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("This message is about: live products.");
    expect(r.action).toEqual({ type: "content_change", product: "Backless Thong Bodysuit", request: { name } });
  });

  it("a run is queued with its way and sorting model, and counts the questions back", async () => {
    answer = sortThenRead("chat", '{"type":"clarify","question":"What would you like?","options":["List","Orders"]}');
    const id = await queueRun({ model: "gemini-2.5-flash", pipeline: "front_door", router: "gemini-2.5-flash-lite" });
    await workOnRuns(10 * 60_000);
    const row = (db.tables.assistant_eval_runs as Record<string, unknown>[]).find((x) => x.id === id) as { pipeline: string; router_model: string; asked: number; passed: number; results: never[] };
    // A question back is right only where any reply would be.
    const replyOk = ASSISTANT_CASES.filter((c) => c.ok.some((s) => s.type === "reply" && Object.keys(s).length === 1)).length;
    expect(row).toMatchObject({ pipeline: "front_door", router_model: "gemini-2.5-flash-lite", asked: ASSISTANT_CASES.length, passed: replyOk });
    expect(routing(row.results).routed).toBe(ASSISTANT_CASES.length);
  });
});

