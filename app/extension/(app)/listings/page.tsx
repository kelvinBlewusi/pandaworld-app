import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Wand2, ListChecks } from "lucide-react";
import { listRecentFillEvents } from "@/lib/security/extension-keys";

export const metadata: import("next").Metadata = {
  title: "Autofill Activity — Extension",
  robots: { index: false },
};

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// The extension writes straight into Jumia's own form — we never get the
// finished listing back (title, price, category), only that a fill
// happened and how many fields it touched. So this is an activity log of
// autofills, not a listings table like the main app's /listings — named
// "Autofill Activity" everywhere (sidebar, page title, this eyebrow) to
// keep that distinction obvious rather than calling both "My listings".
export default async function ExtensionListingsPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in?redirect_url=/extension/listings");

  const events = await listRecentFillEvents(userId, 50);

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-orange-600">
        <ListChecks className="h-3.5 w-3.5" /> Autofill Activity
      </div>
      <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">Recent autofills</h1>
      <p className="mt-2 max-w-xl text-sm text-zinc-600">
        Every time the extension fills a Jumia listing form for you, it shows up here.
        You still review and submit each one on Jumia itself — we just track the activity.
      </p>

      <div className="mt-6 overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
        {events.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-zinc-100">
              <Wand2 className="h-6 w-6 text-zinc-400" />
            </div>
            <p className="text-sm font-medium text-zinc-500">No autofills yet</p>
            <p className="text-xs text-zinc-400">
              Install the extension and click Autofill on a Jumia listing to see it here.
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-100 text-left text-xs font-semibold uppercase tracking-wide text-zinc-400">
                <th className="px-5 py-3">When</th>
                <th className="px-5 py-3">Fields filled</th>
                <th className="px-5 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {events.map((e) => (
                <tr key={e.id}>
                  <td className="px-5 py-3 text-zinc-700">{formatDateTime(e.createdAt)}</td>
                  <td className="px-5 py-3 text-zinc-700">{e.fieldsFilled}</td>
                  <td className="px-5 py-3">
                    <span
                      className={
                        e.mock
                          ? "rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-500"
                          : "rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-600"
                      }
                    >
                      {e.mock ? "Test fill" : "Autofilled"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
