import { createServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface MessageRow {
  id:           string;
  phone_number: string;
  direction:    "inbound" | "outbound";
  message_type: string;
  body_text:    string | null;
  payload:      Record<string, unknown> | null;
  created_at:   string;
}

async function recentPhoneNumbers(): Promise<{ phone_number: string; last_activity: string; messages: number }[]> {
  const db = createServerClient();
  // Every number, latest activity first (admin_recent_whatsapp_numbers,
  // 2026-10-04_admin-recent-whatsapp-numbers.sql). It used to be the
  // numbers in the latest 500 rows, so a number that went quiet for 500
  // messages dropped off the list.
  const { data, error } = await db.rpc("admin_recent_whatsapp_numbers", { p_limit: 100 });
  if (error) console.error(`[admin/messages] couldn't list numbers: ${error.message}`);
  return ((data ?? []) as { phone_number: string; last_activity: string; messages: number | string }[])
    .map((r) => ({ ...r, messages: Number(r.messages) }));
}

const THREAD_PAGE = 500;

/**
 * The latest THREAD_PAGE messages (before `before`, when paging back),
 * oldest first. It used to be the FIRST 500 ever, so a number past 500
 * stopped showing anything new (2026-10-04: 527, the latest 27 missing).
 */
async function conversationFor(phone: string, before?: string): Promise<MessageRow[]> {
  const db = createServerClient();
  let query = db
    .from("whatsapp_message_log")
    .select("*")
    .eq("phone_number", phone);
  if (before) query = query.lt("created_at", before);
  const { data } = await query
    .order("created_at", { ascending: false })
    .limit(THREAD_PAGE);
  return ((data ?? []) as MessageRow[]).reverse();
}

function payloadSummary(row: MessageRow): string | null {
  if (!row.payload) return null;
  const p = row.payload as { buttons?: { title?: string }[]; rows?: { title?: string }[]; url?: string; imageMediaId?: string };
  if (p.buttons) return p.buttons.map((b) => b.title).filter(Boolean).join(" · ");
  if (p.rows) return `${p.rows.length} option${p.rows.length === 1 ? "" : "s"}: ` + p.rows.map((r) => r.title).filter(Boolean).join(", ");
  if (p.url) return p.url;
  if (p.imageMediaId) return "📷 image";
  return null;
}

export default async function AdminMessagesPage({
  searchParams,
}: {
  searchParams: Promise<{ phone?: string; before?: string }>;
}) {
  const { phone, before } = await searchParams;
  const recent = await recentPhoneNumbers();
  const thread = phone ? await conversationFor(phone, before) : [];
  const threadUrl = (extra: string) => `/admin/messages?phone=${encodeURIComponent(phone ?? "")}${extra}`;

  return (
    <div>
      <h1 className="text-lg font-bold">WhatsApp messages</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Every inbound and outbound message, logged as it happens. Reconstructs a real conversation for debugging — not a customer-facing feature.
      </p>

      <form className="mt-6 flex gap-2" action="/admin/messages">
        <input
          type="text"
          name="phone"
          defaultValue={phone ?? ""}
          placeholder="Phone number, e.g. 233550607231"
          className="w-72 rounded-md border border-zinc-300 px-3 py-1.5 text-sm"
        />
        <button type="submit" className="rounded-md bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white">
          Search
        </button>
      </form>

      <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-[220px_1fr]">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Recent numbers</h2>
          <ul className="mt-2 space-y-1">
            {recent.map((r) => (
              <li key={r.phone_number}>
                <a
                  href={`/admin/messages?phone=${encodeURIComponent(r.phone_number)}`}
                  className={`block rounded-md px-2 py-1.5 text-sm hover:bg-zinc-100 ${r.phone_number === phone ? "bg-zinc-100 font-medium" : ""}`}
                >
                  {r.phone_number}
                  <span className="block text-[11px] text-zinc-400">
                    {new Date(r.last_activity).toLocaleDateString()} · {r.messages} message{r.messages === 1 ? "" : "s"}
                  </span>
                </a>
              </li>
            ))}
            {recent.length === 0 && <li className="text-sm text-zinc-400">No messages logged yet.</li>}
          </ul>
        </div>

        <div>
          {!phone && <p className="text-sm text-zinc-500">Pick a number on the left, or search above.</p>}
          {phone && thread.length === 0 && <p className="text-sm text-zinc-500">No messages found for {phone}.</p>}
          {phone && (thread.length === THREAD_PAGE || before) && (
            <div className="mb-4 flex gap-4 text-sm">
              {thread.length === THREAD_PAGE && (
                <a href={threadUrl(`&before=${encodeURIComponent(thread[0].created_at)}`)} className="text-orange-700 underline">
                  ← Older messages
                </a>
              )}
              {before && (
                <a href={threadUrl("")} className="text-orange-700 underline">
                  Latest messages →
                </a>
              )}
            </div>
          )}
          <div className="space-y-2">
            {thread.map((row) => {
              const isOut = row.direction === "outbound";
              const summary = payloadSummary(row);
              return (
                <div key={row.id} className={`flex ${isOut ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-lg rounded-lg border px-3 py-2 text-sm ${
                      isOut ? "border-orange-200 bg-orange-50" : "border-zinc-200 bg-white"
                    }`}
                  >
                    <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-zinc-400">
                      <span>{isOut ? "bot" : "seller"}</span>
                      <span>·</span>
                      <span>{row.message_type}</span>
                      <span>·</span>
                      <span>{new Date(row.created_at).toLocaleString()}</span>
                    </div>
                    {row.body_text && <p className="mt-1 whitespace-pre-wrap">{row.body_text}</p>}
                    {summary && <p className="mt-1 text-xs text-zinc-500">{summary}</p>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
