import { createServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface ErrorRow {
  id:         string;
  source:     string;
  message:    string;
  stack:      string | null;
  context:    Record<string, unknown> | null;
  created_at: string;
}

async function recentErrors(source?: string): Promise<ErrorRow[]> {
  const db = createServerClient();
  let query = db.from("app_errors").select("*").order("created_at", { ascending: false }).limit(100);
  if (source) query = query.eq("source", source);
  const { data } = await query;
  return (data ?? []) as ErrorRow[];
}

async function distinctSources(): Promise<string[]> {
  const db = createServerClient();
  const { data } = await db.from("app_errors").select("source").order("created_at", { ascending: false }).limit(500);
  return Array.from(new Set((data ?? []).map((r) => (r as { source: string }).source)));
}

export default async function AdminErrorsPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string }>;
}) {
  const { source } = await searchParams;
  const [errors, sources] = await Promise.all([recentErrors(source), distinctSources()]);

  return (
    <div>
      <h1 className="text-lg font-bold">Errors</h1>
      <p className="mt-1 text-sm text-zinc-500">
        A permanent trail — unlike Vercel&apos;s own runtime logs, which are short-lived and don&apos;t survive being queried across a wide time range.
      </p>

      <div className="mt-6 flex flex-wrap gap-2 text-sm">
        <a
          href="/admin/errors"
          className={`rounded-full border px-3 py-1 ${!source ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-300 text-zinc-600"}`}
        >
          All
        </a>
        {sources.map((s) => (
          <a
            key={s}
            href={`/admin/errors?source=${encodeURIComponent(s)}`}
            className={`rounded-full border px-3 py-1 ${source === s ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-300 text-zinc-600"}`}
          >
            {s}
          </a>
        ))}
      </div>

      <div className="mt-6 space-y-3">
        {errors.length === 0 && <p className="text-sm text-zinc-500">No errors logged{source ? ` for "${source}"` : ""} — good sign, or nothing's wired up to log there yet.</p>}
        {errors.map((e) => (
          <details key={e.id} className="rounded-lg border border-zinc-200 bg-white p-3">
            <summary className="cursor-pointer text-sm">
              <span className="mr-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-zinc-500">{e.source}</span>
              <span className="text-zinc-900">{e.message}</span>
              <span className="ml-2 text-xs text-zinc-400">{new Date(e.created_at).toLocaleString()}</span>
            </summary>
            <div className="mt-2 space-y-2 text-xs">
              {e.context && Object.keys(e.context).length > 0 && (
                <pre className="overflow-x-auto rounded bg-zinc-50 p-2 text-zinc-600">{JSON.stringify(e.context, null, 2)}</pre>
              )}
              {e.stack && <pre className="overflow-x-auto rounded bg-zinc-50 p-2 text-zinc-400">{e.stack}</pre>}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}
