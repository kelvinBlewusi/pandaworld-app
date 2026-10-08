"use client";

/**
 * The Listing Assistant's product form (owner, 2026-10-08: "should we
 * standardise and make product upload on the web a fixed flow? ... build the
 * form for only admin let me see first"). One card per product, each with
 * its own photos, price, quantity, sizes, colour and notes, so nothing is
 * guessed from the order of chat messages: no count question, no Done, and a
 * price can't land on the wrong product. "Draft" sends them all at once
 * (POST /api/listing-assistant/products); the chat then shows them as one
 * message and reports the drafting as usual.
 */

import { useEffect, useRef, useState } from "react";
import { ImagePlus, Loader2, Plus, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";

/** Jumia takes at most 8 photos a product. */
const MAX_PHOTOS = 8;

interface Photo { key: string; preview: string; mediaId?: string; uploading: boolean; error?: string }
interface Draft { key: string; photos: Photo[]; price: string; quantity: string; sizes: string; colour: string; notes: string }

const newKey = () => crypto.randomUUID();
const blank = (): Draft => ({ key: newKey(), photos: [], price: "", quantity: "", sizes: "", colour: "", notes: "" });

/** What a card still needs before the batch can go, or null. */
function missing(d: Draft): string | null {
  if (d.photos.some((p) => p.uploading)) return "Photos are still uploading";
  if (!d.photos.some((p) => p.mediaId)) return "Add at least one photo";
  const price = Number(d.price);
  if (!d.price.trim() || !Number.isFinite(price) || price <= 0) return "Add its price";
  if (d.quantity.trim() && !(Number.isInteger(Number(d.quantity)) && Number(d.quantity) >= 1)) return "Quantity is a whole number";
  return null;
}

async function upload(file: File): Promise<{ mediaId: string } | { error: string }> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/listing-assistant/upload", { method: "POST", body: form }).catch(() => null);
  const data = res ? ((await res.json().catch(() => ({}))) as { mediaId?: string; error?: string }) : {};
  return res?.ok && data.mediaId ? { mediaId: data.mediaId } : { error: data.error ?? "Didn't upload" };
}

export function ProductForm({ currency, maxProducts, onClose, onSent }: {
  currency: string;
  maxProducts: number;
  onClose: () => void;
  /** After the batch went: the chat polls for its message and the bot's. */
  onSent: () => void;
}) {
  const [drafts, setDrafts] = useState<Draft[]>([blank()]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);

  // Previews are object URLs: released when the form closes.
  const all = useRef<Draft[]>(drafts);
  all.current = drafts;
  useEffect(() => () => all.current.forEach((d) => d.photos.forEach((p) => URL.revokeObjectURL(p.preview))), []);

  const patch = (key: string, change: Partial<Draft> | ((d: Draft) => Partial<Draft>)) =>
    setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...(typeof change === "function" ? change(d) : change) } : d)));

  function addPhotos(key: string, files: FileList | File[] | null) {
    if (!files) return;
    const card = all.current.find((d) => d.key === key);
    if (!card) return;
    const images = Array.from(files).filter((f) => f.type.startsWith("image/")).slice(0, MAX_PHOTOS - card.photos.length);
    if (images.length === 0) return;
    const added = images.map((file) => ({ file, photo: { key: newKey(), preview: URL.createObjectURL(file), uploading: true } as Photo }));
    patch(key, (d) => ({ photos: [...d.photos, ...added.map((a) => a.photo)] }));
    for (const { file, photo } of added) {
      void upload(file).then((r) => patch(key, (d) => ({
        photos: d.photos.map((p) => (p.key === photo.key ? { ...p, uploading: false, ...("mediaId" in r ? { mediaId: r.mediaId } : { error: r.error }) } : p)),
      })));
    }
  }

  function removePhoto(key: string, photoKey: string) {
    patch(key, (d) => {
      const gone = d.photos.find((p) => p.key === photoKey);
      if (gone) URL.revokeObjectURL(gone.preview);
      return { photos: d.photos.filter((p) => p.key !== photoKey) };
    });
  }

  function removeCard(key: string) {
    setDrafts((prev) => {
      prev.find((d) => d.key === key)?.photos.forEach((p) => URL.revokeObjectURL(p.preview));
      return prev.filter((d) => d.key !== key);
    });
  }

  const problems = drafts.map(missing);
  const ready = drafts.length > 0 && problems.every((p) => p == null);

  async function submit() {
    setTried(true);
    if (!ready || sending) return;
    setSending(true);
    setError(null);
    const res = await fetch("/api/listing-assistant/products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: `web-${newKey()}`,
        products: drafts.map((d) => ({
          mediaIds: d.photos.filter((p) => p.mediaId).map((p) => p.mediaId),
          price: Number(d.price),
          quantity: d.quantity.trim() ? Number(d.quantity) : null,
          sizes: d.sizes, colour: d.colour, notes: d.notes,
        })),
      }),
    }).catch(() => null);
    setSending(false);
    if (!res?.ok) {
      const msg = res ? ((await res.json().catch(() => ({}))) as { error?: string }).error : null;
      setError(msg ?? "That didn't go. Check your connection and try again.");
      return;
    }
    onSent();
    onClose();
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-label="New products">
      <div className="flex max-h-[100dvh] w-full flex-col overflow-hidden bg-white sm:max-h-[90dvh] sm:max-w-2xl sm:rounded-2xl sm:shadow-xl">
        <div className="flex items-center justify-between border-b border-zinc-100 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-5">
          <div>
            <p className="font-semibold text-zinc-900">New products</p>
            <p className="text-xs text-zinc-500">Each product&apos;s photos and details, then Draft. Admin preview.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-10 w-10 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-zinc-50/60 px-3 py-4 sm:px-5">
          {drafts.map((d, i) => (
            <Card
              key={d.key}
              n={i + 1}
              draft={d}
              currency={currency}
              problem={tried ? problems[i] : null}
              canRemove={drafts.length > 1}
              onChange={(change) => patch(d.key, change)}
              onPhotos={(files) => addPhotos(d.key, files)}
              onRemovePhoto={(photoKey) => removePhoto(d.key, photoKey)}
              onRemove={() => removeCard(d.key)}
            />
          ))}
          {drafts.length < maxProducts && (
            <button
              type="button"
              onClick={() => setDrafts((prev) => [...prev, blank()])}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-300 bg-white py-3 text-sm font-medium text-zinc-700 hover:border-orange-300 hover:bg-orange-50"
            >
              <Plus className="h-4 w-4 text-orange-500" /> Add product
            </button>
          )}
        </div>

        {error && <p className="border-t border-red-100 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>}
        <div className="flex items-center justify-between gap-3 border-t border-zinc-100 bg-white px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5">
          <p className="min-w-0 text-xs text-zinc-500">
            {drafts.length} product{drafts.length === 1 ? "" : "s"}{tried && !ready ? " · fill in what's marked" : ""}
          </p>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={sending}
            className="inline-flex h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-xl bg-orange-500 px-5 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-60"
          >
            {sending && <Loader2 className="h-4 w-4 animate-spin" />}
            Draft {drafts.length} product{drafts.length === 1 ? "" : "s"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Card({ n, draft, currency, problem, canRemove, onChange, onPhotos, onRemovePhoto, onRemove }: {
  n: number;
  draft: Draft;
  currency: string;
  problem: string | null;
  canRemove: boolean;
  onChange: (change: Partial<Draft>) => void;
  onPhotos: (files: FileList | File[] | null) => void;
  onRemovePhoto: (key: string) => void;
  onRemove: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const field = "w-full rounded-lg border border-zinc-200 px-3 py-2 text-base text-zinc-900 outline-none placeholder:text-zinc-400 focus:border-orange-300 focus:ring-2 focus:ring-orange-100 sm:text-sm";
  return (
    <div className={cn("rounded-xl border bg-white p-4 shadow-sm", problem ? "border-red-300" : "border-zinc-200")}>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-semibold text-zinc-900">Product {n}</p>
        {canRemove && (
          <button type="button" onClick={onRemove} aria-label={`Remove product ${n}`} className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600">
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setOver(false); onPhotos(e.dataTransfer.files); }}
        className={cn("flex flex-wrap gap-2 rounded-lg p-1", over && "bg-orange-50 ring-2 ring-orange-200")}
      >
        {draft.photos.map((p) => (
          <div key={p.key} className={cn("relative h-16 w-16 overflow-hidden rounded-lg border", p.error ? "border-red-300" : "border-zinc-200")}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={p.preview} alt="" className={cn("h-full w-full object-cover", (p.uploading || p.error) && "opacity-50")} />
            {p.uploading && <Loader2 className="absolute inset-0 m-auto h-5 w-5 animate-spin text-zinc-600" />}
            <button
              type="button"
              onClick={() => onRemovePhoto(p.key)}
              aria-label="Remove photo"
              className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        {draft.photos.length < MAX_PHOTOS && (
          <button
            type="button"
            onClick={() => input.current?.click()}
            className="flex h-16 w-16 flex-col items-center justify-center gap-0.5 rounded-lg border border-dashed border-zinc-300 text-[11px] font-medium text-zinc-500 hover:border-orange-300 hover:bg-orange-50"
          >
            <ImagePlus className="h-5 w-5 text-orange-500" />
            Photos
          </button>
        )}
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          className="hidden"
          onChange={(e) => { onPhotos(e.target.files); e.target.value = ""; }}
        />
      </div>
      {draft.photos.some((p) => p.error) && <p className="mt-1 text-xs text-red-600">A photo didn&apos;t upload: remove it and add it again.</p>}

      <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-zinc-600">Price ({currency})*</span>
          <input inputMode="decimal" value={draft.price} onChange={(e) => onChange({ price: e.target.value.replace(/[^\d.]/g, "") })} placeholder="e.g. 150" className={field} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-zinc-600">Quantity</span>
          <input inputMode="numeric" value={draft.quantity} onChange={(e) => onChange({ quantity: e.target.value.replace(/\D/g, "") })} placeholder="1" className={field} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-zinc-600">Sizes / variations</span>
          <input value={draft.sizes} onChange={(e) => onChange({ sizes: e.target.value })} placeholder="e.g. S, M, L or 100ml" className={field} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-zinc-600">Colour</span>
          <input value={draft.colour} onChange={(e) => onChange({ colour: e.target.value })} placeholder="e.g. cream, black" className={field} />
        </label>
        <label className="col-span-2 block">
          <span className="mb-1 block text-xs font-medium text-zinc-600">Notes</span>
          <textarea
            value={draft.notes}
            onChange={(e) => onChange({ notes: e.target.value })}
            rows={2}
            placeholder="Brand, material, sale price and dates, anything else"
            className={cn(field, "resize-none")}
          />
        </label>
      </div>
      {problem && <p className="mt-2 text-xs font-medium text-red-600">{problem}</p>}
    </div>
  );
}
