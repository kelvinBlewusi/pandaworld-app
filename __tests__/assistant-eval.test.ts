/**
 * The assistant's test set and its runner (lib/evals/). The real AI is only
 * called on the server (/admin/assistant-tests); here the set is checked for
 * mistakes in the cases themselves, the comparison is checked, and a whole
 * run goes through with a stand-in AI.
 */

import { FakeDb } from "./helpers/fake-supabase";

let db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({ createServerClient: () => db }));
let answer: (prompt: string) => string = () => '{"type":"reply","text":"Hi! 👋","link":null}';
const prompts: string[] = [];
jest.mock("@/lib/ai/gemini-client", () => ({
  callGeminiBackend: async (_m: string, parts: { text?: string }[]) => {
    const p = parts.map((x) => x.text ?? "").join("\n");
    prompts.push(p);
    return { text: answer(p) };
  },
}));

import { ASSISTANT_CASES, type EvalCase } from "@/lib/evals/assistant-cases";
import { byArea, matchesShape, passes, queueRun, runCase, workOnRuns } from "@/lib/evals/assistant-eval";

const ACTIONS = new Set([
  "edit", "submit", "list", "restart", "review", "orders", "credits", "help", "reply", "live_change", "product_info", "fees", "stock", "shop",
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
});
