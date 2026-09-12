"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Loader2, Send, ExternalLink, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusPill } from "@/components/ui/status-pill";
import { cn } from "@/lib/utils";
import { updateListing } from "@/lib/actions/listings";
import type { ListingRow, ListingStatus } from "@/lib/supabase/types";

export interface WhatsAppBatch {
  batchId:   string;
  createdAt: string;
  listings:  ListingRow[];
}

function formatBatchDate(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(new Date(iso));
}

export function WhatsAppListingsView({ batches }: { batches: WhatsAppBatch[] }) {
  const searchParams = useSearchParams();
  const filterBatch = searchParams.get("batch");
  const visible = filterBatch ? batches.filter((b) => b.batchId === filterBatch) : batches;

  return (
    <div className="space-y-6">
      {filterBatch && (
        <Link
          href="/extension/whatsapp-listings"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-500 hover:text-zinc-800"
        >
          <X className="h-3 w-3" />
          Showing one batch — view all
        </Link>
      )}

      {visible.length === 0 ? (
        <p className="text-sm text-zinc-400">That batch isn&apos;t here anymore — it may have been from a different account.</p>
      ) : (
        visible.map((batch) => (
          <div key={batch.batchId} className="rounded-2xl border bg-white shadow-sm">
            <div className="flex items-center justify-between border-b px-5 py-3">
              <p className="text-sm font-semibold text-zinc-800">
                {batch.listings.length} product{batch.listings.length === 1 ? "" : "s"}
              </p>
              <p className="text-xs text-zinc-400">{formatBatchDate(batch.createdAt)}</p>
            </div>
            <div className="divide-y">
              {batch.listings.map((listing) => (
                <WhatsAppListingRow key={listing.id} listing={listing} />
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function WhatsAppListingRow({ listing }: { listing: ListingRow }) {
  const [price, setPrice]   = useState(listing.selling_price != null ? String(listing.selling_price) : "");
  const [stock, setStock]   = useState(String(listing.quantity ?? ""));
  const [status, setStatus] = useState<ListingStatus>(listing.status);
  const [saving, setSaving] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [message, setMessage] = useState<{ type: "ok" | "error"; text: string } | null>(null);

  const needsPrice = !listing.selling_price && !price;
  const canPush = status === "draft" || status === "failed";

  async function handleSave() {
    setSaving(true);
    setMessage(null);
    try {
      const priceNum = parseFloat(price);
      const stockNum = parseInt(stock, 10);
      await updateListing(listing.id, {
        ...(Number.isFinite(priceNum) && priceNum > 0 ? { selling_price: priceNum } : {}),
        ...(Number.isFinite(stockNum) && stockNum > 0 ? { quantity: stockNum } : {}),
      });
      setMessage({ type: "ok", text: "Saved." });
    } catch (e) {
      setMessage({ type: "error", text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function handlePush() {
    setPushing(true);
    setMessage(null);
    try {
      const res = await fetch("/api/jumia/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listingId: listing.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setStatus("pending_approval");
        setMessage({ type: "ok", text: "Submitted — pending Jumia review." });
      } else {
        setMessage({ type: "error", text: data.error ?? data.message ?? "Push failed." });
      }
    } catch {
      setMessage({ type: "error", text: "Network error — please try again." });
    } finally {
      setPushing(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start">
      <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-zinc-100">
        {listing.images[0] ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={listing.images[0]} alt="" className="h-full w-full object-cover" />
        ) : (
          <span className="text-xs text-zinc-300">No photo</span>
        )}
      </div>

      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {listing.whatsapp_seq != null && (
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-semibold text-zinc-500">
              #{listing.whatsapp_seq}
            </span>
          )}
          <p className="truncate text-sm font-semibold text-zinc-900">{listing.title ?? "(untitled)"}</p>
          <StatusPill status={status} />
        </div>
        {listing.category_path && <p className="text-xs text-zinc-400">{listing.category_path}</p>}

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label className="text-[11px] text-zinc-500">Price (GHS)</Label>
            <Input
              type="number"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="0.00"
              className={cn("h-8 w-28 text-sm", needsPrice && "border-amber-300")}
            />
          </div>
          <div>
            <Label className="text-[11px] text-zinc-500">Stock</Label>
            <Input
              type="number"
              value={stock}
              onChange={(e) => setStock(e.target.value)}
              placeholder="1"
              className="h-8 w-20 text-sm"
            />
          </div>
          <Button variant="outline" size="sm" className="h-8" onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save
          </Button>
          {canPush && (
            <Button size="sm" className="h-8 gap-1.5" onClick={handlePush} disabled={pushing}>
              {pushing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              Push to Jumia
            </Button>
          )}
          <Link
            href={`/listings/${listing.id}/review`}
            className="inline-flex items-center gap-1 text-xs font-medium text-zinc-400 hover:text-zinc-700"
          >
            Full editor <ExternalLink className="h-3 w-3" />
          </Link>
        </div>

        {needsPrice && !message && (
          <p className="text-xs text-amber-600">No price yet — set one above before pushing.</p>
        )}
        {message && (
          <p className={cn("text-xs", message.type === "ok" ? "text-emerald-600" : "text-red-600")}>{message.text}</p>
        )}
      </div>
    </div>
  );
}
