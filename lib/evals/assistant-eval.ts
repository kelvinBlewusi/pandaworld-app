/**
 * Runs the assistant's test set (lib/evals/assistant-cases.ts) against the
 * real AI (owner, 2026-10-08: "how do we make sure that the next solution we
 * offer for the problem does not conflict the past solution we gave").
 *
 * Each case goes through what production does with a message: the same
 * prompt (buildPrompt, with the case's stage, conversation, drafts and the
 * list just shown), the same model call, the same checks (parseAction), and
 * the same product-name check runAssistant makes. The action that comes out
 * is compared with the case's acceptable answers. Scored twice: as
 * deployed ("pass"), and with the AI's choice checked for safety only,
 * without parseAction's word rules ("bare"), to see what each rule adds.
 *
 * A run can instead put the cases through the step-2 prototype, "one front
 * door" (lib/assistant-v2/front-door.ts: route to an area, then read within
 * it, and ask back rather than guess), which nothing in the chat uses. Its
 * questions back are counted apart ("asked"): not wrong, but a tap more.
 *
 * Runs are rows in assistant_eval_runs, worked through by
 * app/api/worker/assistant-eval (pg_cron each minute while one is queued,
 * and nudged when one is queued from /admin/assistant-tests). Nothing a
 * seller sees changes, and no seller's credits or allowance are used: the
 * calls count as the "assistant_eval" feature.
 */

import { createServerClient } from "@/lib/supabase/server";
import { callGeminiBackend } from "@/lib/ai/gemini-client";
import { withAiUsageContext } from "@/lib/ai/usage";
import { appUrl } from "@/lib/whatsapp/app-url";
import {
  assistantLinks, assistantModel, buildPrompt, isProductName, parseAction, parseActionUnguarded,
  type AssistantAction, type ProductFacts,
} from "@/lib/whatsapp/assistant";
import { ASSISTANT_CASES, type EvalCase, type Shape } from "@/lib/evals/assistant-cases";
import { frontDoor } from "@/lib/assistant-v2/front-door";
import type { ListingRow } from "@/lib/supabase/types";

/** What the AI is told about the seller: the shape sellerFacts gives, for a Standard seller in Ghana. */
const SELLER = [
  "- Country: Ghana",
  "- Their Jumia shop: GEM MALL",
  "- WhatsApp: linked",
  "- Jumia: connected (GEM MALL)",
  "- Pack: Standard (the last one they bought)",
  "- The chat's shop features (products, orders, reports, payouts, fees): on",
  "- Changes to live Jumia products from the chat: on",
  "- Jumia QC rejection alerts and guided fixes: on",
  "- Shipping label PDFs on WhatsApp: on",
  "- Order alerts on WhatsApp (new orders, order updates, payouts): not on their pack (Pro and up)",
  "- Credits: 80 available, enough for about 40 listings",
];

/** Cases asked of the AI at once. */
const PARALLEL = 10;
/** A run is held by one worker for this long at a time. */
const LOCK_MS = 58_000;

/** "current": what the chat does today. "front_door": the step-2 prototype. */
export type Pipeline = "current" | "front_door";
export const PIPELINES: Pipeline[] = ["current", "front_door"];

export interface CaseResult {
  id: string;
  area: string;
  pass: boolean;
  /** Passed with the AI's choice checked for safety only (no word rules). */
  bare: boolean;
  /** Front door: it asked the seller a question back instead of acting. */
  asked?: boolean;
  /** Front door: the area its first call sent the message to. */
  routed?: string;
  got: string;
  raw: string;
  error?: string;
  ms: number;
}

// ─── Comparing an action with an expected shape ──────────────────────────────

function at(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur == null) return undefined;
    cur = Array.isArray(cur) && /^\d+$/.test(key) ? cur[Number(key)] : (cur as Record<string, unknown>)[key];
  }
  return cur;
}

const norm = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : typeof v === "number" ? String(v) : JSON.stringify(v));

function same(got: unknown, want: unknown): boolean {
  if (typeof want === "string" && want.startsWith("~")) {
    if (got == null) return false;
    const text = Array.isArray(got) ? got.join(" ") : typeof got === "object" ? JSON.stringify(got) : String(got);
    return text.toLowerCase().includes(want.slice(1).toLowerCase());
  }
  if (Array.isArray(want)) {
    const list = Array.isArray(got) ? got : got == null ? [] : [got];
    const a = new Set(list.map(norm));
    const b = new Set(want.map(norm));
    return a.size === b.size && Array.from(b).every((x) => a.has(x));
  }
  if (Array.isArray(got)) return got.length === 1 && same(got[0], want);
  if (typeof want === "number") return Number(got) === want;
  return got === want;
}

/** Whether the action is the shape: its type, and every field the shape names. Pure. */
export function matchesShape(action: unknown, shape: Shape): boolean {
  return Object.entries(shape).every(([path, want]) => same(at(action, path), want));
}

/** Whether the action is any of the case's acceptable answers. Pure. */
export const passes = (action: unknown, c: EvalCase) => c.ok.some((shape) => matchesShape(action, shape));

// ─── One case ────────────────────────────────────────────────────────────────

function facts(c: EvalCase): ProductFacts[] {
  return (c.drafts ?? []).map((d, i) => ({
    seq:        i + 1,
    listing:    { id: `draft-${i + 1}`, title: d.title, status: "draft", selling_price: d.price ?? null, quantity: null, category_path: null } as unknown as ListingRow,
    variations: d.variations ?? [],
    options:    d.options ?? [],
  }));
}

/** What the assistant makes of the case's message, as production would. */
export async function understand(c: EvalCase, model: string): Promise<{ action: AssistantAction; bare: AssistantAction; raw: string }> {
  const links = assistantLinks();
  const products = facts(c);
  const conversation = c.ctx ?? [];
  const prompt = buildPrompt(c.stage, c.msg, {
    products, currency: "GHS", seller: SELLER, links, conversation, web: c.web ?? true, waitingFor: c.waitingFor,
    listed: c.listed ?? null, listingCost: 2,
  });
  const { text } = await withAiUsageContext({ feature: "assistant_eval" }, () =>
    callGeminiBackend(model, [{ text: prompt }], model.startsWith("gemini-3") ? { preferBackend: "ai-studio" } : {}));
  const opts = { context: conversation.join("\n"), stage: c.stage, listed: !!c.listed };
  let action = parseAction(text, c.msg, products, links, "GHS", opts);
  // The product-name check runAssistant makes against their shop.
  if ((action.type === "reply" || action.type === "unclear") && c.stage !== "collecting" && c.stage !== "starting"
    && c.catalog && isProductName(c.msg, c.catalog)) {
    action = { type: "product_info", product: c.msg.trim().slice(0, 120) };
  }
  return { action, bare: parseActionUnguarded(text, c.msg, products, links, "GHS", opts), raw: text };
}

/** What the front door prototype makes of the case's message (no word rules, no product-name override). */
export async function understandFrontDoor(c: EvalCase, models: { router: string; reader: string }) {
  return frontDoor({
    stage: c.stage, message: c.msg, conversation: c.ctx ?? [], drafts: facts(c), listed: c.listed ?? null,
    waitingFor: c.waitingFor, seller: SELLER, links: assistantLinks(), currency: "GHS", web: c.web ?? true, shopNames: c.catalog,
  }, models);
}

const summary = (a: unknown) => JSON.stringify(a).slice(0, 400);

export async function runCase(c: EvalCase, model: string, opts: { pipeline?: Pipeline; router?: string | null } = {}): Promise<CaseResult> {
  const t0 = Date.now();
  let lastError = "";
  // One retry: a timeout isn't the assistant misunderstanding.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (opts.pipeline === "front_door") {
        const { area, action, raw } = await understandFrontDoor(c, { router: opts.router || model, reader: model });
        const asked = action.type === "clarify";
        const pass = !asked && passes(action, c);
        return { id: c.id, area: c.area, pass, bare: pass, asked, routed: area, got: summary(action), raw: raw.slice(0, 600), ms: Date.now() - t0 };
      }
      const { action, bare, raw } = await understand(c, model);
      return { id: c.id, area: c.area, pass: passes(action, c), bare: passes(bare, c), got: summary(action), raw: raw.slice(0, 400), ms: Date.now() - t0 };
    } catch (e) {
      lastError = (e as Error).message.slice(0, 200);
    }
  }
  return { id: c.id, area: c.area, pass: false, bare: false, got: "", raw: "", error: lastError, ms: Date.now() - t0 };
}

// ─── Runs ────────────────────────────────────────────────────────────────────

export interface EvalRun {
  id: string; created_at: string; status: string; model: string; note: string | null; total: number; done: number;
  passed: number; passed_bare: number; errors: number; results: CaseResult[]; finished_at: string | null;
  /** Older rows have none: the current pipeline. */
  pipeline?: Pipeline | null; router_model?: string | null; asked?: number | null;
}

/**
 * Queue a run of the whole set (the model in use unless one is named),
 * through the chat as it is or the front door prototype (whose first call
 * uses `router`, the same model unless named). Returns its id.
 */
export async function queueRun(opts: { model?: string; note?: string; pipeline?: Pipeline; router?: string } = {}): Promise<string> {
  const model = opts.model ?? (await assistantModel());
  const pipeline = opts.pipeline ?? "current";
  const { data, error } = await createServerClient()
    .from("assistant_eval_runs")
    .insert({
      model, note: opts.note ?? null, total: ASSISTANT_CASES.length, status: "queued", pipeline,
      router_model: pipeline === "front_door" ? opts.router ?? model : null,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`couldn't queue a run: ${error?.message ?? "no row"}`);
  return (data as { id: string }).id;
}

/** Start the worker now rather than at pg_cron's next minute. Never throws. */
export async function nudgeEvalWorker(): Promise<void> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return;
  try {
    await fetch(`${appUrl()}/api/worker/assistant-eval`, { method: "POST", headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(2_000) });
  } catch {
    // Timed out (it's working) or unreachable: pg_cron picks it up within the minute.
  }
}

const tally = (results: CaseResult[]) => ({
  done:        results.length,
  passed:      results.filter((r) => r.pass).length,
  passed_bare: results.filter((r) => r.bare).length,
  errors:      results.filter((r) => r.error).length,
  asked:       results.filter((r) => r.asked).length,
});

/**
 * Work on the oldest unfinished run until `budgetMs` is spent: claims it
 * (so two workers never run the same cases), asks PARALLEL cases at a
 * time, saves after each group, and marks it done once every case has a
 * result. Cases removed from the set since it was queued are skipped.
 */
export async function workOnRuns(budgetMs = 45_000): Promise<{ runId: string | null; done: number; total: number }> {
  const db = createServerClient();
  const deadline = Date.now() + budgetMs;
  const now = new Date().toISOString();
  const { data: open } = await db.from("assistant_eval_runs").select("id, locked_until")
    .in("status", ["queued", "running"]).order("created_at", { ascending: true }).limit(5);
  const free = ((open ?? []) as { id: string; locked_until: string | null }[]).find((r) => !r.locked_until || r.locked_until < now);
  if (!free) return { runId: null, done: 0, total: 0 };
  // Claimed only if no other worker took it since it was read.
  const claim = db.from("assistant_eval_runs")
    .update({ status: "running", locked_until: new Date(Date.now() + LOCK_MS).toISOString() })
    .eq("id", free.id);
  const { data: claimed } = await (free.locked_until ? claim.eq("locked_until", free.locked_until) : claim.is("locked_until", null)).select("*");
  const run = ((claimed ?? []) as EvalRun[])[0];
  if (!run) return { runId: null, done: 0, total: 0 };

  const results: CaseResult[] = Array.isArray(run.results) ? [...run.results] : [];
  const done = new Set(results.map((r) => r.id));
  const left = ASSISTANT_CASES.filter((c) => !done.has(c.id));
  while (left.length > 0 && Date.now() < deadline - 15_000) {
    const group = left.splice(0, PARALLEL);
    results.push(...(await Promise.all(group.map((c) => runCase(c, run.model, { pipeline: run.pipeline ?? "current", router: run.router_model })))));
    await db.from("assistant_eval_runs").update({
      ...tally(results), results, locked_until: new Date(Date.now() + LOCK_MS).toISOString(),
    }).eq("id", run.id);
  }
  const finished = left.length === 0;
  await db.from("assistant_eval_runs").update({
    ...tally(results), results, total: ASSISTANT_CASES.length, locked_until: null,
    ...(finished ? { status: "done", finished_at: new Date().toISOString() } : {}),
  }).eq("id", run.id);
  return { runId: run.id, done: results.length, total: ASSISTANT_CASES.length };
}

/** A run's results by area: cases, passed as deployed, passed on the AI's choice alone, asked back. Pure. */
export function byArea(results: CaseResult[]): { area: string; cases: number; passed: number; bare: number; asked: number }[] {
  const rows = new Map<string, { area: string; cases: number; passed: number; bare: number; asked: number }>();
  for (const r of results) {
    const row = rows.get(r.area) ?? { area: r.area, cases: 0, passed: 0, bare: 0, asked: 0 };
    row.cases++;
    if (r.pass) row.passed++;
    if (r.bare) row.bare++;
    if (r.asked) row.asked++;
    rows.set(r.area, row);
  }
  return Array.from(rows.values()).sort((a, b) => a.passed / a.cases - b.passed / b.cases);
}

const AREA_OF: Record<string, string> = { live_changes: "live_products" };

/** Front door runs: of the cases routed, how many went to the case's own area. Pure. */
export function routing(results: CaseResult[]): { routed: number; right: number } {
  const routed = results.filter((r) => r.routed);
  return { routed: routed.length, right: routed.filter((r) => r.routed === (AREA_OF[r.area] ?? r.area)).length };
}
