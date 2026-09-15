"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Loader2, Send, ExternalLink, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusPill } from "@/components/ui/status-pill";
import { cn } from "@/lib/utils";
import { deleteListing, updateListing } from "@/lib/actions/listings";
import { focusedEditorUrl } from "@/lib/whatsapp/batch";
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

// ─── Organising the page ─────────────────────────────────────────────────────
//
// The page was a flat reverse-chronological list of batch cards, each
// headed only "N products". That is fine at three batches and unusable at
// thirty: nothing says which products still need a price, which pushes
// failed, or which are already live, so finding the one thing that needs
// doing means opening every card.
//
// Three pieces of structure, in the order a seller actually needs them:
//   1. Filter chips with live counts, led by "Needs attention".
//   2. Date grouping, so "the batch I sent this morning" is findable by
//      when it happened rather than by scrolling.
//   3. A per-batch status breakdown in each header.

/** A listing the seller has to do something about: a push that failed, or
 *  a draft that cannot be pushed yet because it has no price or no
 *  category. Everything else is either in flight or finished. */
function needsAttention(l: ListingRow): boolean {
  if (l.status === "failed") return true;
  if (l.status !== "draft") return false;
  return l.selling_price == null || l.selling_price <= 0 || !l.category_code;
}

type Filter = "all" | "attention" | "draft" | "pending" | "live";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all",       label: "All" },
  { id: "attention", label: "Needs attention" },
  { id: "draft",     label: "Drafts" },
  { id: "pending",   label: "Submitted" },
  { id: "live",      label: "Live" },
];

function matchesFilter(l: ListingRow, filter: Filter): boolean {
  switch (filter) {
    case "all":       return true;
    case "attention": return needsAttention(l);
    case "draft":     return l.status === "draft" && !needsAttention(l);
    case "pending":   return l.status === "pending_approval" || l.status === "processing" || l.status === "awaiting_review";
    case "live":      return l.status === "live";
  }
}

/** "Today" / "Yesterday" / "12 Sept 2026" — grouped on the seller's own
 *  calendar days, not a fixed number of hours back. */
function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(d);
}

/** Compact "2 live · 1 draft" summary for a batch header. Ordered so the
 *  parts a seller must act on come first. */
function batchSummary(listings: ListingRow[]): string {
  const attention = listings.filter(needsAttention).length;
  const live      = listings.filter((l) => l.status === "live").length;
  const submitted = listings.filter((l) => matchesFilter(l, "pending")).length;
  const drafts    = listings.filter((l) => matchesFilter(l, "draft")).length;

  return [
    attention ? `${attention} need${attention === 1 ? "s" : ""} attention` : null,
    drafts    ? `${drafts} draft${drafts === 1 ? "" : "s"}` : null,
    submitted ? `${submitted} submitted` : null,
    live      ? `${live} live` : null,
  ].filter(Boolean).join(" · ");
}

export function WhatsAppListingsView({ batches }: { batches: WhatsAppBatch[] }) {
  const searchParams = useSearchParams();
  const filterBatch = searchParams.get("batch");
  const [filter, setFilter] = useState<Filter>("all");

  const scoped = filterBatch ? batches.filter((b) => b.batchId === filterBatch) : batches;
  const allListings = scoped.flatMap((b) => b.listings);

  // Counts come from the batch-scoped set, so a chip never advertises
  // products the current view could not show even if tapped.
  const counts = Object.fromEntries(
    FILTERS.map((f) => [f.id, allListings.filter((l) => matchesFilter(l, f.id)).length]),
  ) as Record<Filter, number>;

  // Drop batches with nothing left under the active filter, rather than
  // rendering empty cards.
  const visible = scoped
    .map((b) => ({ ...b, listings: b.listings.filter((l) => matchesFilter(l, filter)) }))
    .filter((b) => b.listings.length > 0);

  // Group by calendar day, preserving the newest-first batch order.
  const days: { label: string; batches: WhatsAppBatch[] }[] = [];
  for (const batch of visible) {
    const label = dayLabel(batch.createdAt);
    const last = days[days.length - 1];
    if (last && last.label === label) last.batches.push(batch);
    else days.push({ label, batches: [batch] });
  }

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

      {allListings.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((f) => {
            const count = counts[f.id];
            // "All" always shows; the rest only when they have something,
            // so the row doesn't fill with dead zeroes.
            if (f.id !== "all" && count === 0) return null;
            const active = filter === f.id;
            const urgent = f.id === "attention";
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                aria-pressed={active}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition",
                  active
                    ? "border-zinc-900 bg-zinc-900 text-white"
                    : urgent
                      ? "border-amber-300 bg-amber-50 text-amber-700 hover:border-amber-400"
                      : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300",
                )}
              >
                {f.label}
                <span className={cn("tabular-nums", active ? "text-zinc-300" : "text-zinc-400")}>{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {scoped.length === 0 ? (
        <p className="text-sm text-zinc-400">That batch isn&apos;t here anymore — it may have been from a different account.</p>
      ) : visible.length === 0 ? (
        <p className="text-sm text-zinc-400">
          Nothing here under &ldquo;{FILTERS.find((f) => f.id === filter)?.label}&rdquo;.{" "}
          <button type="button" onClick={() => setFilter("all")} className="font-medium text-zinc-600 underline">
            Show all
          </button>
        </p>
      ) : (
        days.map((day) => (
          <section key={day.label} className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">{day.label}</h2>
            {day.batches.map((batch) => {
              const summary = batchSummary(batch.listings);
              return (
                <div key={batch.batchId} className="rounded-2xl border bg-white shadow-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b px-5 py-3">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <p className="text-sm font-semibold text-zinc-800">
                        {batch.listings.length} product{batch.listings.length === 1 ? "" : "s"}
                      </p>
                      {summary && <p className="text-xs text-zinc-400">{summary}</p>}
                    </div>
                    <p className="text-xs text-zinc-400">{formatBatchDate(batch.createdAt)}</p>
                  </div>
                  <div className="divide-y">
                    {batch.listings.map((listing) => (
                      <WhatsAppListingRow key={listing.id} listing={listing} />
                    ))}
                  </div>
                </div>
              );
            })}
          </section>
        ))
      )}
    </div>
  );
}

function WhatsAppListingRow({ listing }: { listing: ListingRow }) {
  const router = useRouter();
  const [price, setPrice]   = useState(listing.selling_price != null ? String(listing.selling_price) : "");
  const [stock, setStock]   = useState(String(listing.quantity ?? ""));
  const [status, setStatus] = useState<ListingStatus>(listing.status);
  const [saving, setSaving] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState<{ type: "ok" | "error"; text: string } | null>(null);

  const needsPrice = !listing.selling_price && !price;
  const canPush = status === "draft" || status === "failed";

  // A listing Jumia already has is a different thing to delete than a
  // draft: removing the row here does NOT take the product down from
  // Jumia, it only stops PandaWorld tracking it — so the seller loses
  // their way back to it while it stays live for buyers. Say that
  // plainly rather than letting them find out afterwards.
  const onJumia = status === "live" || status === "pending_approval";

  async function handleDelete() {
    const name = listing.title ?? "this product";
    const warning = onJumia
      ? `Delete "${name}" from PandaWorld?\n\nThis does NOT remove it from Jumia — it stays live there, you just stop tracking it here. This cannot be undone.`
      : `Delete "${name}"? This cannot be undone.`;
    if (!window.confirm(warning)) return;

    setDeleting(true);
    setMessage(null);
    try {
      await deleteListing(listing.id);
      // The row is server-rendered from the batch query, so a refresh is
      // what actually makes it disappear. Stay in the deleting state
      // until then — re-enabling the button over a row that is about to
      // vanish just invites a second click on a listing that is gone.
      router.refresh();
    } catch (e) {
      setMessage({ type: "error", text: (e as Error).message });
      setDeleting(false);
    }
  }

  async function persist(): Promise<boolean> {
    try {
      const priceNum = parseFloat(price);
      const stockNum = parseInt(stock, 10);
      await updateListing(listing.id, {
        ...(Number.isFinite(priceNum) && priceNum > 0 ? { selling_price: priceNum } : {}),
        ...(Number.isFinite(stockNum) && stockNum > 0 ? { quantity: stockNum } : {}),
      });
      return true;
    } catch (e) {
      setMessage({ type: "error", text: (e as Error).message });
      return false;
    }
  }

  async function handleSave() {
    setSaving(true);
    setMessage(null);
    const ok = await persist();
    if (ok) setMessage({ type: "ok", text: "Saved." });
    setSaving(false);
  }

  async function handlePush() {
    setPushing(true);
    setMessage(null);
    // Submit always saves first — a seller who typed a price and hit
    // "Push to Jumia" without clicking Save first used to push whatever
    // was already in the DB (often nothing), failing with "price is
    // required" even though a price was visibly typed in the field.
    const saved = await persist();
    if (!saved) {
      setPushing(false);
      return;
    }
    try {
      const res = await fetch("/api/jumia/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listingId: listing.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setStatus("pending_approval");
        // Name anything Jumia did not receive as written. Silently
        // "succeeding" while a value the seller typed was dropped is the
        // failure mode this exists to end.
        const adjusted = (data.adjustments ?? []) as string[];
        setMessage({
          type: "ok",
          text: adjusted.length > 0
            ? `Submitted — pending Jumia review. Note: ${adjusted.join("; ")}.`
            : "Submitted — pending Jumia review.",
        });
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
          <Link
            href={focusedEditorUrl(listing.id)}
            className="truncate text-sm font-semibold text-zinc-900 hover:text-orange-600 hover:underline"
          >
            {listing.title ?? "(untitled)"}
          </Link>
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
            href={focusedEditorUrl(listing.id)}
            className="inline-flex items-center gap-1 text-xs font-medium text-zinc-400 hover:text-zinc-700"
          >
            Edit product <ExternalLink className="h-3 w-3" />
          </Link>
          {/* Pushed to the far end, away from Save and Push. The
              destructive action should not sit under a thumb aiming for
              the one next to it. */}
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleting}
            aria-label={`Delete ${listing.title ?? "product"}`}
            className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-zinc-400 transition-colors hover:text-red-600 disabled:opacity-50"
          >
            {deleting
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <Trash2 className="h-3.5 w-3.5" />}
            Delete
          </button>
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
