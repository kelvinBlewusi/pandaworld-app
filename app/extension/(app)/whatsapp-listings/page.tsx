import { Suspense } from "react";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { MessageCircle } from "lucide-react";
import { createServerClient } from "@/lib/supabase/server";
import { WhatsAppListingsView, type WhatsAppBatch } from "@/components/extension/whatsapp-listings-view";
import type { ListingRow } from "@/lib/supabase/types";

// ─── /extension/whatsapp-listings ────────────────────────────────────────────
//
// Review surface for listings created via the WhatsApp chatbot's
// multi-product batch flow (see lib/whatsapp/intake.ts) — a simple read
// view of what the AI filled in per product, with just enough editing
// (price + stock, the two fields the chat flow deliberately never guesses
// — see lib/whatsapp/batch.ts) to get a batch ready for "submit" without
// needing the full web review page.

export const metadata: import("next").Metadata = {
  title: "WhatsApp Listings",
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

  const db = createServerClient();
  const { data } = await db
    .from("listings")
    .select("*")
    .eq("user_id", userId)
    .not("whatsapp_batch_id", "is", null)
    .order("created_at", { ascending: false });

  const batches = groupIntoBatches((data ?? []) as ListingRow[]);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-zinc-900">WhatsApp Listings</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Products drafted from a WhatsApp chat — review, fill in price/stock if it's missing, and push to Jumia.
        </p>
      </div>

      {batches.length === 0 ? (
        <div className="rounded-2xl border border-dashed bg-white py-16 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
            <MessageCircle className="h-5 w-5" />
          </div>
          <p className="text-sm font-medium text-zinc-600">No WhatsApp listings yet</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-zinc-400">
            Connect WhatsApp in Settings → Integrations, then send a product photo to the bot number to draft your first listing.
          </p>
        </div>
      ) : (
        <Suspense fallback={null}>
          <WhatsAppListingsView batches={batches} />
        </Suspense>
      )}
    </div>
  );
}
