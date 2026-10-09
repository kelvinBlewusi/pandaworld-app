import { revalidatePath } from "next/cache";
import { CAPABILITIES, type CapabilityArea, type CapabilityStatus } from "@/lib/jumia/capabilities";
import { CHECK_NAMES, latestChecks, runAndReport } from "@/lib/jumia/api-checks";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ─── /admin/jumia-api ────────────────────────────────────────────────────────
//
// What sellers can ask of their Jumia shop through PandaWorld, and what they
// can't (lib/jumia/capabilities.ts), with the latest daily check of every
// read request against the owner's shop (lib/jumia/api-checks.ts). Owner,
// 2026-10-09: "the system understands what is capable and doable and what is
// not and reports on it accordingly".

async function runNow() {
  "use server";
  await runAndReport();
  revalidatePath("/admin/jumia-api");
}

const AREAS: Record<CapabilityArea, string> = {
  connect: "Shop and account", listing: "Listing new products", products: "Reading their products", live: "Changing live products",
  orders: "Orders", money: "Money", warehouse: "Jumia's warehouse",
};
const STATUS: Record<CapabilityStatus, { label: string; cls: string }> = {
  chat:          { label: "In the chat", cls: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  whatsapp:      { label: "WhatsApp only", cls: "bg-sky-50 text-sky-700 ring-sky-200" },
  not_built:     { label: "Not built yet", cls: "bg-amber-50 text-amber-700 ring-amber-200" },
  vendor_center: { label: "Vendor Center only", cls: "bg-zinc-100 text-zinc-700 ring-zinc-200" },
  impossible:    { label: "Not possible", cls: "bg-rose-50 text-rose-700 ring-rose-200" },
};
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Accra" });

export default async function JumiaApiPage() {
  const { runAt, results } = await latestChecks();
  const byCheck = new Map(results.map((r) => [r.check, r]));
  const failed = results.filter((r) => !r.ok);
  const counts = CAPABILITIES.reduce((m, c) => m.set(c.status, (m.get(c.status) ?? 0) + 1), new Map<CapabilityStatus, number>());

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-lg font-bold">Jumia API</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-500">
          Everything a seller can ask of their Jumia shop, the requests behind it, and what isn&apos;t possible. The assistant answers
          what isn&apos;t possible with the text below. Every read request is checked against your shop each morning; a failure is sent to you on WhatsApp.
        </p>
        <p className="mt-2 text-xs text-zinc-500">
          {(Object.keys(STATUS) as CapabilityStatus[]).map((s) => `${STATUS[s].label}: ${counts.get(s) ?? 0}`).join(" · ")}
        </p>
      </div>

      <section className="rounded-xl border border-zinc-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Daily check</h2>
            <p className="text-xs text-zinc-500">
              {runAt ? `Last run ${when(runAt)}: ${results.length - failed.length} of ${results.length} worked${failed.length ? `, ${failed.length} failed` : ""}.` : "Not run yet."}
            </p>
          </div>
          <form action={runNow}>
            <button type="submit" className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-700">Run the checks now</button>
          </form>
        </div>
        {results.length > 0 && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
                <tr><th className="py-1 pr-4">Request</th><th className="py-1 pr-4">Result</th><th className="py-1 pr-4">Time</th><th className="py-1">What it found</th></tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.check} className="border-t border-zinc-100">
                    <td className="py-1.5 pr-4 font-mono text-xs">{CHECK_NAMES[r.check] ?? r.check}</td>
                    <td className="py-1.5 pr-4">{r.skipped ? "– skipped" : r.ok ? "✅" : "❌"}</td>
                    <td className="py-1.5 pr-4 text-zinc-500">{r.skipped ? "" : `${(r.ms / 1000).toFixed(1)} s`}</td>
                    <td className="py-1.5 text-zinc-600">{r.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {(Object.keys(AREAS) as CapabilityArea[]).map((area) => (
        <section key={area}>
          <h2 className="mb-2 text-sm font-semibold">{AREAS[area]}</h2>
          <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 bg-white">
            {CAPABILITIES.filter((c) => c.area === area).map((c) => {
              const checks = (c.checks ?? []).map((id) => byCheck.get(id)).filter((x): x is NonNullable<typeof x> => !!x);
              const health = checks.length === 0 ? null : checks.some((x) => !x.ok) ? "❌" : "✅";
              return (
                <div key={c.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{c.what}</span>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] ring-1 ring-inset ${STATUS[c.status].cls}`}>{STATUS[c.status].label}</span>
                      {health && <span className="text-xs" title="Its requests in the last daily check">{health}</span>}
                    </div>
                    {c.requests.length > 0 && <p className="mt-0.5 font-mono text-[11px] text-zinc-500">{c.requests.join(" · ")}</p>}
                    {c.needs && <p className="mt-0.5 text-xs text-zinc-500">Needs: {c.needs.join(", ")}</p>}
                    {c.answer && <p className="mt-1 text-xs text-zinc-700">The assistant says: &ldquo;{c.answer}&rdquo;</p>}
                  </div>
                  <span className="shrink-0 font-mono text-[11px] text-zinc-400">{c.id}</span>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
