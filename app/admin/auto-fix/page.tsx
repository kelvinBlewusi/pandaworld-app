import { createServerClient } from "@/lib/supabase/server";
import { autoFixKind, type AutoFixKind } from "@/lib/jumia/auto-resubmit";
import { extractRejectionText } from "@/lib/jumia/rejection-remedy";
import { autoFixListingAction } from "./actions";

export const dynamic = "force-dynamic";

interface FailedRow {
  id:           string;
  user_id:      string;
  title:        string | null;
  jumia_error:  string | null;
  whatsapp_seq: number | null;
  updated_at:   string;
}

const FIX: Record<AutoFixKind, string> = {
  hidden_fields: "Resubmit without the fields its category doesn't show",
  banned_words:  "Take the banned words out and resubmit",
  brand_words:   "Take the refused brand word out of its text and resubmit",
};

/** Rejected in the last week, with a rejection the bot can now fix itself. */
async function fixableListings(): Promise<(FailedRow & { kind: AutoFixKind })[]> {
  const db = createServerClient();
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await db
    .from("listings")
    .select("id, user_id, title, jumia_error, whatsapp_seq, updated_at")
    .eq("status", "failed")
    .gt("updated_at", since)
    .order("updated_at", { ascending: false })
    .limit(200);
  return ((data ?? []) as FailedRow[])
    .map((r) => ({ ...r, kind: autoFixKind(r.jumia_error) }))
    .filter((r): r is FailedRow & { kind: AutoFixKind } => r.kind !== null);
}

export default async function AdminAutoFixPage({
  searchParams,
}: {
  searchParams: Promise<{ done?: string; failed?: string; skipped?: string }>;
}) {
  const { done, failed, skipped } = await searchParams;
  const rows = await fixableListings();

  return (
    <div>
      <h1 className="text-lg font-bold">Auto-fix</h1>
      <p className="mt-1 max-w-3xl text-sm text-zinc-500">
        Listings Jumia rejected in the last week for something the bot now fixes without the seller: fields
        the category doesn&apos;t show, banned words, or a brand word Jumia&apos;s quality check refused in the
        listing&apos;s text. New rejections like these are fixed automatically. This is for ones from before.
        Fixing resubmits the listing to the seller&apos;s Jumia shop and tells them on WhatsApp. Credits are only
        charged if it goes live.
      </p>

      {done && <p className="mt-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">Resubmitted {done}. Its seller has been told.</p>}
      {failed && <p className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">Couldn&apos;t resubmit {failed}: see the logs (no credits, a push error, the daily limit, or the word isn&apos;t in its text).</p>}
      {skipped && <p className="mt-4 rounded-md bg-zinc-100 px-3 py-2 text-sm text-zinc-700">{skipped} isn&apos;t rejected any more.</p>}

      {rows.length === 0 ? (
        <p className="mt-6 text-sm text-zinc-500">Nothing to fix.</p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-3 py-2 font-medium">Listing</th>
                <th className="px-3 py-2 font-medium">Jumia said</th>
                <th className="px-3 py-2 font-medium">Fix</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {rows.map((r) => (
                <tr key={r.id} className="align-top">
                  <td className="px-3 py-2">
                    <div className="text-zinc-900">{r.title ?? "Untitled"}</div>
                    <div className="text-xs text-zinc-400">{r.user_id} · {new Date(r.updated_at).toLocaleString()}</div>
                  </td>
                  <td className="max-w-sm px-3 py-2 text-xs text-zinc-600">{extractRejectionText(r.jumia_error).slice(0, 300)}</td>
                  <td className="px-3 py-2 text-xs text-zinc-600">{FIX[r.kind]}</td>
                  <td className="px-3 py-2">
                    <form action={autoFixListingAction}>
                      <input type="hidden" name="listing_id" value={r.id} />
                      <button type="submit" className="whitespace-nowrap rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700">
                        Fix &amp; resubmit
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
