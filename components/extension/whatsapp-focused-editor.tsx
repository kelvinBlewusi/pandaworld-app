"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, ExternalLink, Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusPill } from "@/components/ui/status-pill";
import { cn } from "@/lib/utils";
import { updateListing } from "@/lib/actions/listings";
import { SchemaForm } from "@/components/jumia/SchemaForm";
import { columnFor, fieldChangeToUpdate } from "@/lib/jumia/attribute-mapping";
import { STATIC_FIELDS, universalInfoFields } from "@/lib/jumia/universal-fields";
import { reviewUrl } from "@/lib/whatsapp/draft";
import type { ListingRow, ListingStatus } from "@/lib/supabase/types";

/**
 * The "focused editor" — a single-product form scoped to exactly what
 * Jumia asks for in that product's category, reached by tapping a link
 * the WhatsApp bot sends once a chat-drafted product finishes analysis
 * (see lib/whatsapp/intake.ts). Deliberately much simpler than the full
 * editor (app/(main)/listings/[id]/review/review-client.tsx): no AI-assist
 * tooling, no multi-variant matrix, no quality score, no category picker —
 * just this product's fields, editable, with Save and Submit.
 *
 * Modeled on components/extension/whatsapp-listings-view.tsx's existing
 * Price/Stock + Save + Push pattern, extended with a SchemaForm block for
 * the category-specific fields that view doesn't show.
 */
export function WhatsAppFocusedEditor({ listing: initialListing }: { listing: ListingRow }) {
  const [listing, setListing] = useState(initialListing);
  const [title, setTitle]     = useState(initialListing.title ?? "");
  const [price, setPrice]     = useState(initialListing.selling_price != null ? String(initialListing.selling_price) : "");
  const [stock, setStock]     = useState(String(initialListing.quantity ?? ""));
  const [status, setStatus]   = useState<ListingStatus>(initialListing.status);

  // Same two-store pattern as the full editor: dynAttrs for
  // dynamic_attributes-backed fields, columnOverrides for fields that map
  // to a first-class column (color, weight_kg, main_material, ...).
  const [dynAttrs, setDynAttrs] = useState<Record<string, string>>(
    (initialListing.dynamic_attributes ?? {}) as Record<string, string>,
  );
  const [columnOverrides, setColumnOverrides] = useState<Record<string, string>>({});

  const [saving, setSaving] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [message, setMessage] = useState<{ type: "ok" | "error"; text: string } | null>(null);

  function handleFieldChange(attributeName: string, value: string) {
    if (columnFor(attributeName)) {
      setColumnOverrides((prev) => ({ ...prev, [attributeName]: value }));
    } else {
      setDynAttrs((prev) => ({ ...prev, [attributeName]: value }));
    }
  }

  const overrideValues: Record<string, string> = { ...dynAttrs, ...columnOverrides };
  const needsPrice = !price;
  const needsCategory = !listing.category_code;
  const canPush = status === "draft" || status === "failed";

  async function persist(): Promise<boolean> {
    const priceNum = parseFloat(price);
    const stockNum = parseInt(stock, 10);

    const overrideColumnUpdates: Record<string, unknown> = {};
    for (const [attr, val] of Object.entries(columnOverrides)) {
      const { columnUpdate } = fieldChangeToUpdate(attr, val);
      if (columnUpdate) Object.assign(overrideColumnUpdates, columnUpdate);
    }

    try {
      const updated = await updateListing(listing.id, {
        title: title.trim() || null,
        ...(Number.isFinite(priceNum) && priceNum > 0 ? { selling_price: priceNum } : {}),
        ...(Number.isFinite(stockNum) && stockNum > 0 ? { quantity: stockNum } : {}),
        dynamic_attributes: { ...dynAttrs },
        ...overrideColumnUpdates,
      });
      setListing(updated);
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
    // Submit always saves first — a seller should never push stale data by
    // forgetting to tap Save, and there's no reason a failed validation
    // here should also lose their edits.
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
    <div className="mx-auto max-w-2xl space-y-6">
      <Link
        href="/extension/whatsapp-listings"
        className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-500 hover:text-zinc-800"
      >
        <ArrowLeft className="h-3 w-3" />
        Back to WhatsApp listings
      </Link>

      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-orange-600">Edit product</p>
          <h1 className="mt-1 text-xl font-bold text-zinc-900">{title || "(untitled)"}</h1>
        </div>
        <StatusPill status={status} />
      </div>

      {listing.images.length > 0 && (
        <div className="flex gap-2 overflow-x-auto">
          {listing.images.map((url, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={i} src={url} alt="" className="h-20 w-20 shrink-0 rounded-lg object-cover" />
          ))}
        </div>
      )}

      <div className="space-y-4 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
        <div>
          <Label className="text-xs text-zinc-500">Product name</Label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1" />
        </div>
        <div className="flex gap-4">
          <div className="flex-1">
            <Label className="text-xs text-zinc-500">Price (GHS)</Label>
            <Input
              type="number"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="0.00"
              className={cn("mt-1", needsPrice && "border-amber-300")}
            />
          </div>
          <div className="flex-1">
            <Label className="text-xs text-zinc-500">Stock</Label>
            <Input type="number" value={stock} onChange={(e) => setStock(e.target.value)} placeholder="1" className="mt-1" />
          </div>
        </div>
        {listing.category_path && <p className="text-xs text-zinc-400">{listing.category_path}</p>}
      </div>

      {needsCategory ? (
        <div className="rounded-md border border-dashed border-zinc-300 bg-zinc-50/50 p-6 text-center text-sm text-zinc-500">
          This product needs a category before its category fields can show — finish it in the{" "}
          <Link href={reviewUrl(listing.id)} className="font-medium text-orange-600 underline">
            full editor
          </Link>
          .
        </div>
      ) : (
        <SchemaForm
          categoryCode={listing.category_code}
          listing={listing}
          overrideValues={overrideValues}
          onFieldChange={handleFieldChange}
          excludeNames={STATIC_FIELDS}
          extraFields={universalInfoFields()}
          excludeVariants
          cols={2}
        />
      )}

      {message && (
        <p className={cn("text-sm", message.type === "ok" ? "text-emerald-600" : "text-red-600")}>{message.text}</p>
      )}
      {needsPrice && !message && (
        <p className="text-xs text-amber-600">No price yet — set one above before submitting.</p>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-zinc-100 pt-4">
        <Button variant="outline" onClick={handleSave} disabled={saving || pushing}>
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          Save
        </Button>
        {canPush && (
          <Button onClick={handlePush} disabled={saving || pushing} className="gap-1.5">
            {pushing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Submit to Jumia
          </Button>
        )}
        <Link
          href={reviewUrl(listing.id)}
          className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-zinc-400 hover:text-zinc-700"
        >
          Full editor <ExternalLink className="h-3 w-3" />
        </Link>
      </div>
    </div>
  );
}
