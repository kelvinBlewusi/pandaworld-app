/**
 * Agent mode (lib/assistant-v2/agent.ts): Gemini's function calling, with
 * a stand-in model. Each tool call becomes the chat's own action and goes
 * through the same checks as the front door's reading; lookups are answered
 * back before it acts; it may do up to three things a message asks for.
 */

import { FakeDb } from "./helpers/fake-supabase";

let db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({ createServerClient: () => db }));
jest.mock("@/lib/ai/gemini-client", () => ({
  callGeminiBackend: async () => { throw new Error("not in these tests"); },
  callGeminiWithTools: async () => { throw new Error("not in these tests"); },
}));

import {
  ACTION_TOOLS, AGENT_TOOLS, LOOKUP_TOOLS, actionJson, agentPrompt, agentRead, catalogLookups, countsText, lookupLine, type AgentCall,
} from "@/lib/assistant-v2/agent";
import type { FrontDoorInput } from "@/lib/assistant-v2/front-door";
import { assistantLinks } from "@/lib/whatsapp/assistant";
import { fromRow } from "@/lib/jumia/shop";
import type { GeminiTurn } from "@/lib/ai/gemini-client";

beforeEach(() => { db = new FakeDb(); });

const input = (message: string, patch: Partial<FrontDoorInput> = {}): FrontDoorInput => ({
  stage: "idle", message, conversation: [], drafts: [], listed: null, seller: ["- Country: Ghana"], links: assistantLinks(),
  currency: "GHS", web: true, ...patch,
});

type Step = { calls: { name: string; args: Record<string, unknown>; id?: string }[]; text?: string };

/** A stand-in model answering each turn in order; records what it was sent. */
function scripted(steps: Step[]) {
  const seen: { turns: GeminiTurn[]; onlyAct: boolean }[] = [];
  const call: AgentCall = async (turns, onlyAct) => {
    seen.push({ turns: JSON.parse(JSON.stringify(turns)) as GeminiTurn[], onlyAct });
    const step = steps.shift();
    if (!step) throw new Error("no turn scripted");
    return {
      calls: step.calls, text: step.text ?? "",
      turn: { role: "model", parts: step.calls.map((c) => ({ functionCall: { name: c.name, args: c.args }, thoughtSignature: "sig" })) },
    };
  };
  return { call, seen };
}

const noLookups = { findProducts: async () => [] as string[], shopCounts: async () => "" };

const KETTLE = fromRow({ product_sid: "p1", seller_sku: "KET-1", name: "Nasco Electric Kettle 1.7L", status: "ACTIVE", qc_status: "APPROVED", stock: 0, price: 250, currency: "GHS" });
const FAN = fromRow({ product_sid: "p2", seller_sku: "FAN-1", name: "Pedestal Fan - 5-Blade", status: "INACTIVE", qc_status: "REJECTED", stock: 4 });
const GONE = fromRow({ product_sid: "p3", seller_sku: "OLD-1", name: "Old Kettle", status: "DELETED" });

describe("the tools", () => {
  it("has every action once, with the lookups apart", () => {
    const names = AGENT_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(LOOKUP_TOOLS.map((t) => t.name)).toEqual(["find_products", "shop_counts"]);
    for (const t of ACTION_TOOLS) expect(t.parameters).toMatchObject({ type: "object" });
    expect(names).toEqual(expect.arrayContaining(["live_change", "bulk", "content_change", "fix_rejected", "add_size", "add_photos", "clarify", "reply", "cannot"]));
  });

  it("puts a call back in the chat's own action shape", () => {
    expect(actionJson("live_change", { product: "kettle", end_sale: true })).toEqual({ type: "live_change", product: "kettle", sale: "end" });
    expect(actionJson("live_change", { product: "kettle", stock: 10, end_sale: false })).toEqual({ type: "live_change", product: "kettle", stock: 10 });
    expect(actionJson("submit", { all: true })).toEqual({ type: "submit", products: "all" });
    expect(actionJson("submit", { products: [1, 3] })).toEqual({ type: "submit", products: [1, 3] });
    expect(actionJson("content_change", { product: "fan", details: [{ detail: "colour", value: "white" }, { detail: 3 }] }))
      .toEqual({ type: "content_change", product: "fan", details: { colour: "white" }, rewrite: [] });
    expect(actionJson("sales", { period: "week", status: ["delivered"] })).toEqual({ type: "sales", period: "week", status: "delivered" });
    expect(actionJson("sales", { period: "week", status: ["delivered", "returned"] })).toEqual({ type: "sales", period: "week", status: ["delivered", "returned"] });
    expect(actionJson("polish", {})).toEqual({ type: "polish", product: null });
  });

  it("tells the model where the seller is, what's possible and the rules", () => {
    const p = agentPrompt(input("restock the electric kettle to 10", { shopNames: ["Nasco Electric Kettle 1.7L"] }));
    expect(p).toContain("Where they are: Between batches");
    expect(p).toContain('Products in their Jumia shop the message names: "Nasco Electric Kettle 1.7L"');
    expect(p).toContain("Not possible from here");
    expect(p).toContain("at most 3");
    expect(p).toContain("ON or OFF, in capitals");
  });
});

describe("its lookups", () => {
  it("shows a product with only what the shop's copy knows", () => {
    expect(lookupLine(KETTLE)).toBe('"Nasco Electric Kettle 1.7L" · ON · approved · stock 0 · price GHS 250');
    expect(lookupLine(fromRow({ product_sid: "x", seller_sku: "X", name: "Wig" }))).toBe('"Wig"');
  });

  it("counts the shop as the overview does, deleted ones left out", () => {
    expect(countsText([KETTLE, FAN, GONE])).toBe("2 products · ON 1 · OFF 1 · out of stock 1 · waiting for Jumia's check 0 · rejected 1");
  });

  it("finds products the way the chat's own search does", async () => {
    const look = catalogLookups([KETTLE, FAN, GONE]);
    expect(await look.findProducts("the kettle")).toEqual([lookupLine(KETTLE)]);
    expect(await look.findProducts("blender")).toEqual([]);
  });
});

describe("reading a message", () => {
  it("looks a product up, answers the model, then acts", async () => {
    const { call, seen } = scripted([
      { calls: [{ name: "find_products", args: { words: "kettle" }, id: "c1" }] },
      { calls: [{ name: "live_change", args: { product: "Nasco Electric Kettle 1.7L", stock: 10 } }] },
    ]);
    const r = await agentRead(input("restock the kettle to 10"), call, catalogLookups([KETTLE]));
    expect(r.actions).toEqual([expect.objectContaining({ type: "live_change", product: "Nasco Electric Kettle 1.7L", change: { kind: "stock", stock: 10 } })]);
    expect(r.calls).toBe(2);
    // Its own turn goes back as it came (thought signatures included), then the answer.
    const second = seen[1].turns;
    expect(second[1]).toEqual({ role: "model", parts: [{ functionCall: { name: "find_products", args: { words: "kettle" } }, thoughtSignature: "sig" }] });
    expect(second[2]).toEqual({ role: "user", parts: [{ functionResponse: { id: "c1", name: "find_products", response: { result: [lookupLine(KETTLE)] } } }] });
    expect(r.raw).toContain("find_products");
  });

  it("says when nothing matches, and acts only on the last round after two lookups", async () => {
    const { call, seen } = scripted([
      { calls: [{ name: "find_products", args: { words: "blender" } }] },
      { calls: [{ name: "shop_counts", args: {} }] },
      { calls: [{ name: "reply", args: { text: "I couldn't find a blender in your shop." } }] },
    ]);
    const r = await agentRead(input("is my blender on?"), call, catalogLookups([KETTLE]));
    expect(seen.map((s) => s.onlyAct)).toEqual([false, false, true]);
    expect(seen[1].turns[2].parts[0]).toEqual({ functionResponse: { name: "find_products", response: { result: "No product matches those words." } } });
    expect(r.actions[0]).toMatchObject({ type: "reply" });
  });

  it("stops when it only looks up on the last round", async () => {
    const { call } = scripted([
      { calls: [{ name: "shop_counts", args: {} }] },
      { calls: [{ name: "shop_counts", args: {} }] },
      { calls: [{ name: "shop_counts", args: {} }] },
    ]);
    const r = await agentRead(input("how is my shop"), call, noLookups);
    expect(r.calls).toBe(3);
    expect(r.actions).toEqual([{ type: "unclear" }]);
  });

  it("does up to three things asked at once, in order", async () => {
    const { call } = scripted([{ calls: [
      { name: "live_change", args: { product: "kettle", stock: 10 } },
      { name: "orders", args: {} },
      { name: "credits", args: {} },
      { name: "help", args: {} },
    ] }]);
    const r = await agentRead(input("restock the kettle to 10, show me my orders, and my credits"), call, noLookups);
    expect(r.actions.map((a) => a.type)).toEqual(["live_change", "orders", "credits"]);
  });

  it("drops its own words beside actions, and the same action twice", async () => {
    const { call } = scripted([{ calls: [
      { name: "reply", args: { text: "Done! I've restocked it." } },
      { name: "orders", args: {} },
      { name: "orders", args: {} },
    ] }]);
    const r = await agentRead(input("show me my orders"), call, noLookups);
    expect(r.actions).toEqual([{ type: "orders" }]);
  });

  it("asks back with answers to tap", async () => {
    const { call } = scripted([{ calls: [{ name: "clarify", args: { question: "Which kettle?", options: ["Nasco 1.7L", "Binatone 2L", "Both", "Neither"] } }] }]);
    const r = await agentRead(input("restock the kettle to 10"), call, noLookups);
    expect(r.actions).toEqual([]);
    expect(r.clarify).toEqual({ type: "clarify", question: "Which kettle?", options: ["Nasco 1.7L", "Binatone 2L", "Both"] });
  });

  it("keeps the chat's checks: a value not in the message is never used", async () => {
    const { call } = scripted([{ calls: [{ name: "live_change", args: { product: "kettle", stock: 50 } }] }]);
    const r = await agentRead(input("restock the kettle to 10"), call, noLookups);
    expect(r.actions.some((a) => a.type === "live_change" && JSON.stringify(a).includes("50"))).toBe(false);
  });

  it("throws when the model is slow, so the front door reads it instead", async () => {
    const call: AgentCall = () => new Promise(() => {});
    await expect(agentRead(input("hello"), call, noLookups, { callMs: 30, totalMs: 5_000 })).rejects.toThrow(/took over/);
  });

  it("throws when the model fails", async () => {
    const call: AgentCall = async () => { throw new Error("404 model not found"); };
    await expect(agentRead(input("hello"), call, noLookups)).rejects.toThrow("404");
  });
});
