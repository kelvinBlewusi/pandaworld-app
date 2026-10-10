import { WhatsAppIcon } from "@/components/whatsapp/whatsapp-icon";
import { Suspense } from "react";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import { createServerClient } from "@/lib/supabase/server";
import { getWhatsAppConnection } from "@/lib/whatsapp/link";
import { refreshPendingFeedStatus } from "@/lib/jumia/push-listing";
import { getValidJumiaCredentials } from "@/lib/jumia/api";
import { WhatsAppListingsView, type WhatsAppBatch } from "@/components/extension/whatsapp-listings-view";
import { BeginWhatsAppBanner } from "@/components/whatsapp/begin-whatsapp-banner";
import type { ListingRow } from "@/lib/supabase/types";

// ─── /extension/whatsapp-listings ────────────────────────────────────────────
//
// Review surface for listings created via the WhatsApp chatbot's
// multi-product batch flow (see lib/whatsapp/intake.ts) — a simple read
// view of what the AI filled in per product, with just enough editing
// (price + stock, the two fields the chat flow deliberately never guesses
// — see lib/whatsapp/batch.ts) to get a batch ready for "submit" without
// needing the full web review page.
//
// The not-connected empty state is a one-click banner (not just a pointer
// to Settings -> Integrations) because that page lives inside the (main)
// route group, which (main)/layout.tsx gates behind an ACTIVE Jumia
// connection — exactly what a brand-new seller doing the whole thing from
// WhatsApp (link -> paste Jumia app credentials in chat -> list) doesn't
// have yet. This extension-flow page has no such gate, so it's the one
// place that population can actually reach a "Connect WhatsApp" action.

export const metadata: import("next").Metadata = {
  title: "Drafts & Listings",
  robots: { index: false },
};

/** How long the page will wait on Jumia before giving up and rendering
 *  stored statuses. Well under any sane page-load budget — this is a
 *  freshness bonus, never a dependency. */
const STATUS_REFRESH_TIMEOUT_MS = 5_000;

/**
 * Live-refresh every pending listing's status, returning rows with the
 * refreshed values patched in. Never throws and never rejects: on timeout
 * or any failure the caller gets the original rows back unchanged.
 */
async function refreshPendingStatuses(userId: string, rows: ListingRow[]): Promise<ListingRow[]> {
  const pending = rows.filter((l) => l.status === "pending_approval" && l.jumia_ref);
  if (pending.length === 0) return rows;

  const work = (async (): Promise<Map<string, ListingRow["status"]>> => {
    const resolved = new Map<string, ListingRow["status"]>();
    const { accessToken } = await getValidJumiaCredentials(userId);
    await Promise.all(
      pending.map(async (l) => {
        const { status } = await refreshPendingFeedStatus(accessToken, {
          id: l.id, status: l.status, jumia_ref: l.jumia_ref,
        });
        if (status !== l.status) resolved.set(l.id, status as ListingRow["status"]);
      }),
    );
    return resolved;
  })();

  const timeout = new Promise<Map<string, ListingRow["status"]>>((resolve) => {
    setTimeout(() => resolve(new Map()), STATUS_REFRESH_TIMEOUT_MS);
  });

  const resolved = await Promise.race([work, timeout]).catch(() => new Map<string, ListingRow["status"]>());
  if (resolved.size === 0) return rows;

  return rows.map((l) => (resolved.has(l.id) ? { ...l, status: resolved.get(l.id)! } : l));
}

function groupIntoBatches(listings: ListingRow[]): WhatsAppBatch[] {
  const byBatch = new Map<string, ListingRow[]>();
  for (const listing of listings) {
    const batchId = listing.whatsapp_batch_id;
    if (!batchId) continue;
    if (!byBatch.has(batchId)) byBatch.set(batchId, []);
    byBatch.get(batchId)!.push(listing);
  }

  const batches: WhatsAppBatch[] = Array.from(byBatch.entries()).map(([batchId, items]) => ({
    batchId,
    createdAt: items.reduce((latest, l) => (l.created_at > latest ? l.created_at : latest), items[0].created_at),
    listings: items.slice().sort((a, b) => (a.whatsapp_seq ?? 0) - (b.whatsapp_seq ?? 0)),
  }));

  batches.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return batches;
}

export default async function WhatsAppListingsPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in?redirect_url=/extension/whatsapp-listings");

  const [{ data }, wa] = await Promise.all([
    createServerClient()
      .from("listings")
      .select("*")
      .eq("user_id", userId)
      .not("whatsapp_batch_id", "is", null)
      .order("created_at", { ascending: false }),
    getWhatsAppConnection(userId),
  ]);

  // Ask Jumia for the real status of anything still pending before
  // rendering. Without this the page shows whatever the last cron run
  // wrote, and that cron fires once a day (Vercel's Hobby plan caps the
  // frequency) while Jumia usually finishes in minutes — so a seller who
  // submitted and came straight here saw "Pending" that never moved, for
  // up to 24 hours. Bounded and best-effort: a slow or failing Jumia call
  // must never block the page, it just renders the stored status instead.
  const rows = await refreshPendingStatuses(userId, (data ?? []) as ListingRow[]);

  const batches = groupIntoBatches(rows);

  return (
    <div className="mx-auto max-w-5xl">
      <p className="mb-6 text-sm text-zinc-500">
        Every product drafted in a chat shows here, from WhatsApp or the Listing Assistant on this website, marked with where it was made. Edit and submit them here, or in either chat.
      </p>

      {batches.length === 0 ? (
        <div className="mx-auto max-w-md">
          {wa.connected ? (
            <div className="rounded-2xl border border-dashed bg-white py-16 text-center">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
                <WhatsAppIcon className="h-5 w-5" />
              </div>
              <p className="text-sm font-medium text-zinc-600">You&apos;re connected — no listings yet</p>
              <p className="mx-auto mt-1 max-w-sm text-xs text-zinc-400">
                Send a product photo to {wa.phoneNumber ?? "your linked number"} on WhatsApp to start your first listing.
              </p>
            </div>
          ) : (
            <BeginWhatsAppBanner />
          )}
        </div>
      ) : (
        <Suspense fallback={null}>
          <WhatsAppListingsView batches={batches} />
        </Suspense>
      )}
    </div>
  );
}
