import { revalidatePath } from "next/cache";
import { createServerClient } from "@/lib/supabase/server";
import { ASSISTANT_CASES } from "@/lib/evals/assistant-cases";
import { byArea, nudgeEvalWorker, queueRun, routing, type EvalRun } from "@/lib/evals/assistant-eval";

export const dynamic = "force-dynamic";

// ─── /admin/assistant-tests ──────────────────────────────────────────────────
//
// The assistant's test set (lib/evals/assistant-cases.ts) run against the
// real AI: the score of each run, the latest by area, and every case it got
// wrong with what it should have done. A change to the assistant ships only
// if no case that passed before fails (owner, 2026-10-08).
//
// "Front door" runs put the same cases through the step-2 prototype
// (lib/assistant-v2/front-door.ts), which nothing in the chat uses, to
// compare it with the chat as it is. Its questions back ("asked") are
// counted apart from right and wrong.
//
// "Agent" runs put them through agent mode (lib/assistant-v2/agent.ts,
// function calling, the pilot): right when every action it takes is one of
// the case's answers; "any action right" when at least one is.

const MODELS = ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-3.1-flash-lite"];

async function runTests(form: FormData) {
  "use server";
  const model = String(form.get("model") ?? "");
  const way = String(form.get("pipeline") ?? "");
  const [pipeline, router] = way.startsWith("front_door") ? ["front_door" as const, way.split(":")[1] || undefined]
    : way === "agent" ? ["agent" as const, undefined] : ["current" as const, undefined];
  await queueRun({
    model: MODELS.includes(model) ? model : undefined, pipeline,
    router: router && MODELS.includes(router) ? router : undefined, note: "from the admin page",
  });
  await nudgeEvalWorker();
  revalidatePath("/admin/assistant-tests");
}

const pct = (n: number, of: number) => (of > 0 ? `${Math.round((n / of) * 100)}%` : "–");
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Accra" });

export default async function AssistantTestsPage({ searchParams }: { searchParams: Promise<{ run?: string }> }) {
  const { run: picked } = await searchParams;
  const { data } = await createServerClient().from("assistant_eval_runs").select("*").order("created_at", { ascending: false }).limit(12);
  const runs = (data ?? []) as EvalRun[];
  const latest = runs.find((r) => r.id === picked) ?? runs.find((r) => r.status === "done") ?? runs[0];
  const cases = new Map(ASSISTANT_CASES.map((c) => [c.id, c]));
  const failures = (latest?.results ?? []).filter((r) => !r.pass);
  const scored = (r: EvalRun) => r.done - r.errors;
  // Both ask back; neither has word rules to go without.
  const frontDoor = (r: EvalRun) => r.pipeline === "front_door" || r.pipeline === "agent";
  const agent = (r: EvalRun) => r.pipeline === "agent";
  const way = (r: EvalRun) => (agent(r) ? "Agent" : frontDoor(r) ? `Front door${r.router_model && r.router_model !== r.model ? ` (sorts with ${r.router_model})` : ""}` : "Current");
  const avgMs = (r: EvalRun) => {
    const timed = (r.results ?? []).filter((x) => !x.error);
    return timed.length ? `${(timed.reduce((n, x) => n + x.ms, 0) / timed.length / 1000).toFixed(1)} s` : "–";
  };
  const route = latest && frontDoor(latest) && !agent(latest) ? routing(latest.results) : null;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-lg font-bold">Assistant tests</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-500">
          {ASSISTANT_CASES.length} real messages sellers sent (and rewordings of them), each with the answers that would be right, run against the live AI with the same prompt and checks as the chat.
          &quot;Without word rules&quot; is the AI&apos;s choice checked for safety only. A change ships only if no case that passed before fails.
        </p>
        <form action={runTests} className="mt-4 flex flex-wrap items-center gap-2">
          <select name="model" defaultValue="" className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm">
            <option value="">The model in use</option>
            {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <select name="pipeline" defaultValue="current" className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm">
            <option value="current">The chat as it is</option>
            <option value="front_door">Front door</option>
            {MODELS.map((m) => <option key={m} value={`front_door:${m}`}>Front door, sorting with {m}</option>)}
            <option value="agent">Agent (function calling, pilot)</option>
          </select>
          <button type="submit" className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-700">Run the test set</button>
          <span className="text-xs text-zinc-500">About 3 minutes. Refresh to see it fill in.</span>
        </form>
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr><th className="px-4 py-2">When</th><th className="px-4 py-2">Way</th><th className="px-4 py-2">Model</th><th className="px-4 py-2">Status</th><th className="px-4 py-2">Score</th><th className="px-4 py-2">Without word rules / any action right</th><th className="px-4 py-2">Asked back</th><th className="px-4 py-2">Time each</th><th className="px-4 py-2">Errors</th></tr>
          </thead>
          <tbody>
            {runs.length === 0 && <tr><td colSpan={9} className="px-4 py-6 text-center text-zinc-500">No runs yet. Run the test set to get the first score.</td></tr>}
            {runs.map((r) => (
              <tr key={r.id} className="border-t border-zinc-100">
                <td className="px-4 py-2 whitespace-nowrap"><a href={`?run=${r.id}`} className={r.id === latest?.id ? "font-semibold underline" : "underline decoration-zinc-300 hover:decoration-zinc-900"}>{when(r.created_at)}</a></td>
                <td className="px-4 py-2 whitespace-nowrap">{way(r)}</td>
                <td className="px-4 py-2 font-mono text-xs">{r.model}</td>
                <td className="px-4 py-2">{r.status === "done" ? "Done" : r.status === "running" ? `Running ${r.done}/${r.total}` : r.status === "queued" ? "Queued" : r.status}</td>
                <td className="px-4 py-2 font-semibold tabular-nums">{r.passed}/{scored(r)} · {pct(r.passed, scored(r))}</td>
                <td className="px-4 py-2 tabular-nums text-zinc-600">{frontDoor(r) && !agent(r) ? "–" : `${r.passed_bare}/${scored(r)} · ${pct(r.passed_bare, scored(r))}`}</td>
                <td className="px-4 py-2 tabular-nums text-zinc-600">{frontDoor(r) ? `${r.asked ?? 0} · ${pct(r.asked ?? 0, scored(r))}` : "–"}</td>
                <td className="px-4 py-2 tabular-nums text-zinc-600">{avgMs(r)}</td>
                <td className="px-4 py-2 tabular-nums text-zinc-600">{r.errors}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {latest && latest.results.length > 0 && (
        <>
          <div>
            <h2 className="font-semibold">By area <span className="font-normal text-zinc-500">· {way(latest)} run of {when(latest.created_at)}</span></h2>
            {route && <p className="mt-1 text-xs text-zinc-500">Its first call sent {route.right} of {route.routed} messages to their own area ({pct(route.right, route.routed)}).</p>}
            <div className="mt-3 overflow-x-auto rounded-xl border border-zinc-200 bg-white">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
                  <tr><th className="px-4 py-2">Area</th><th className="px-4 py-2">Cases</th><th className="px-4 py-2">Passed</th><th className="px-4 py-2">{frontDoor(latest) ? "Asked back" : "Without word rules"}</th></tr>
                </thead>
                <tbody>
                  {byArea(latest.results).map((a) => (
                    <tr key={a.area} className="border-t border-zinc-100">
                      <td className="px-4 py-2">{a.area.replace(/_/g, " ")}</td>
                      <td className="px-4 py-2 tabular-nums">{a.cases}</td>
                      <td className="px-4 py-2 font-semibold tabular-nums">{a.passed} · {pct(a.passed, a.cases)}</td>
                      <td className="px-4 py-2 tabular-nums text-zinc-600">{frontDoor(latest) ? `${a.asked} · ${pct(a.asked, a.cases)}` : `${a.bare} · ${pct(a.bare, a.cases)}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <h2 className="font-semibold">{frontDoor(latest) ? `Not right first time (${failures.length}, of which ${latest.results.filter((r) => r.asked).length} asked back)` : `Got wrong (${failures.length})`}</h2>
            <div className="mt-3 space-y-2">
              {failures.map((r) => {
                const c = cases.get(r.id);
                return (
                  <div key={r.id} className="rounded-xl border border-zinc-200 bg-white p-4 text-sm">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="font-medium text-zinc-900">&ldquo;{c?.msg ?? r.id}&rdquo;</p>
                      <p className="font-mono text-xs text-zinc-500">{r.id} · {c?.stage} · {c?.src}</p>
                    </div>
                    {c?.ctx && c.ctx.length > 0 && <p className="mt-1 text-xs text-zinc-500">After: {c.ctx[c.ctx.length - 1].slice(0, 160)}</p>}
                    <p className="mt-2 text-xs"><span className="font-semibold text-emerald-700">Should be:</span> <span className="font-mono">{c?.ok.map((s) => JSON.stringify(s)).join("  or  ")}</span></p>
                    <p className="mt-1 text-xs"><span className={`font-semibold ${r.asked ? "text-amber-700" : "text-red-700"}`}>{r.asked ? "Asked:" : "Got:"}</span> <span className="font-mono">{r.error ? `error: ${r.error}` : r.got}</span></p>
                    {r.routed && <p className="mt-1 text-xs text-zinc-500">Sorted to: {r.routed.replace(/_/g, " ")}</p>}
                    {c?.note && <p className="mt-1 text-xs text-zinc-500">{c.note}</p>}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
