import { Suspense } from "react";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { MessageCircle } from "lucide-react";
import { createServerClient } from "@/lib/supabase/server";
import { getWhatsAppConnection } from "@/lib/whatsapp/link";
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
  title: "List from WhatsApp",
  robots: { index: false },
};

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

  const batches = groupIntoBatches((data ?? []) as ListingRow[]);

  return (
    <div className="mx-auto max-w-5xl">
      <p className="mb-6 text-sm text-zinc-500">
        Products drafted from a WhatsApp chat show here. You may edit and submit manually from here.
      </p>

      {batches.length === 0 ? (
        <div className="mx-auto max-w-md">
          {wa.connected ? (
            <div className="rounded-2xl border border-dashed bg-white py-16 text-center">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
                <MessageCircle className="h-5 w-5" />
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
