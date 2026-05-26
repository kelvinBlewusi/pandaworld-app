"use client";

/**
 * Multi-product batch "Add Products" page.
 *
 * Mirrors Jumia Vendor Center's single-product page, but with a per-product
 * tab navigation in the breadcrumb area. Users prompted to list N products
 * land here with a fresh draft per product; switching tabs swaps the active
 * draft without losing edits.
 *
 * Routed from the sidebar:
 *   Sidebar → "Upload product from your own images"
 *     → /listings/new?mode=own&step=count
 *       → user picks N
 *         → /listings/new/batch?count=N
 *
 * Structural skeleton only — no Jumia push from this page yet. Each tab
 * shows the Product Information section (8-slot image grid + Name +
 * Category). Variants + Product Specification sections live in the existing
 * per-listing review form once each draft is finalised.
 */

import { useEffect, useMemo, useState, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ChevronRight, Plus, X, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CategoryDrawer } from "@/components/ui/category-drawer";
import { cn } from "@/lib/utils";

const MIN_PRODUCTS = 1;
const MAX_PRODUCTS = 10;
const IMAGE_SLOTS = 8;
const MAX_FILE_BYTES = 2 * 1024 * 1024;        // 2 MB
const MIN_DIM = 500;
const MAX_DIM = 2000;

// ─── Per-product draft state ─────────────────────────────────────────────────

interface ImageSlot {
  file:    File | null;
  preview: string | null;
  error:   string | null;
}

interface ProductDraft {
  name:         string;
  categoryCode: number | null;
  categoryName: string | null;
  categoryPath: string | null;
  images:       ImageSlot[];
  /**
   * Free-form instruction the seller can give the AI BEFORE it analyses
   * the images. Things like "this is a pack of 6", "the colour is teal not
   * blue", "specify it's wireless". Sent through to /auto-analyze as
   * `userPrompt` and woven into Pass A/B prompts.
   */
  aiInstruction: string;
}

function emptyDraft(): ProductDraft {
  return {
    name:         "",
    categoryCode: null,
    categoryName: null,
    categoryPath: null,
    images:       Array.from({ length: IMAGE_SLOTS }, () => ({
      file: null, preview: null, error: null,
    })),
    aiInstruction: "",
  };
}

// ─── Image grid ───────────────────────────────────────────────────────────────

function ImageSlots({
  slots,
  onPick,
  onRemove,
}: {
  slots:    ImageSlot[];
  onPick:   (idx: number, file: File) => void;
  onRemove: (idx: number) => void;
}) {
  const fileRefs = useRef<(HTMLInputElement | null)[]>([]);

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-4 gap-3 sm:grid-cols-8">
        {slots.map((slot, i) => (
          <div key={i} className="relative">
            <input
              ref={(el) => { fileRefs.current[i] = el; }}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onPick(i, f);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => fileRefs.current[i]?.click()}
              className={cn(
                "group relative flex aspect-square w-full cursor-pointer flex-col items-center justify-center gap-1 rounded-md border-2 overflow-hidden transition-colors",
                slot.preview
                  ? "border-solid border-zinc-200 bg-white"
                  : "border-dashed border-orange-300 bg-white hover:bg-orange-50",
              )}
            >
              {slot.preview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={slot.preview} alt="" className="h-full w-full object-cover" />
              ) : (
                <>
                  <Plus className="h-5 w-5 text-orange-400" />
                  <span className="text-[10px] font-medium text-zinc-500">
                    {i === 0 ? "Main Image" : "Image"}
                  </span>
                </>
              )}
            </button>
            {slot.preview && (
              <button
                type="button"
                onClick={() => onRemove(i)}
                className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-500 shadow-sm hover:bg-red-50 hover:text-red-500"
                aria-label="Remove image"
              >
                <X className="h-3 w-3" />
              </button>
            )}
            {slot.error && (
              <p className="absolute left-0 right-0 -bottom-5 truncate text-[9px] text-red-500">{slot.error}</p>
            )}
          </div>
        ))}
      </div>
      <p className="text-xs text-zinc-400">
        Image needs to be between {MIN_DIM}×{MIN_DIM} and {MAX_DIM}×{MAX_DIM} pixels. White backgrounds are recommended. No watermarks. Maximum image size 2Mb.
      </p>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function BatchAddProductsPage() {
  const search = useSearchParams();
  const rawCount = parseInt(search.get("count") ?? "1", 10);
  const count = Math.max(MIN_PRODUCTS, Math.min(MAX_PRODUCTS, isNaN(rawCount) ? 1 : rawCount));

  const [drafts, setDrafts]       = useState<ProductDraft[]>(() =>
    Array.from({ length: count }, emptyDraft)
  );
  const [activeIdx, setActiveIdx] = useState(0);
  const [showCategoryPicker, setShowCategoryPicker] = useState(false);

  // Resize drafts if URL count changes
  useEffect(() => {
    setDrafts((prev) => {
      if (prev.length === count) return prev;
      if (count > prev.length) {
        return [...prev, ...Array.from({ length: count - prev.length }, emptyDraft)];
      }
      return prev.slice(0, count);
    });
    setActiveIdx((i) => Math.min(i, count - 1));
  }, [count]);

  // Revoke object URLs on unmount to avoid memory leaks
  useEffect(() => {
    return () => {
      drafts.forEach((d) => d.images.forEach((img) => { if (img.preview) URL.revokeObjectURL(img.preview); }));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const active = drafts[activeIdx];

  const updateActive = (patch: Partial<ProductDraft>) => {
    setDrafts((prev) => prev.map((d, i) => (i === activeIdx ? { ...d, ...patch } : d)));
  };

  const handlePickImage = (slotIdx: number, file: File) => {
    let error: string | null = null;
    if (file.size > MAX_FILE_BYTES) error = "File > 2 MB";
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) error = "JPG / PNG / WEBP only";

    const preview = error ? null : URL.createObjectURL(file);

    setDrafts((prev) =>
      prev.map((d, i) => {
        if (i !== activeIdx) return d;
        return {
          ...d,
          images: d.images.map((img, j) => {
            if (j !== slotIdx) return img;
            if (img.preview) URL.revokeObjectURL(img.preview);
            return { file: error ? null : file, preview, error };
          }),
        };
      })
    );
  };

  const handleRemoveImage = (slotIdx: number) => {
    setDrafts((prev) =>
      prev.map((d, i) => {
        if (i !== activeIdx) return d;
        const next = d.images.map((img, j) => {
          if (j !== slotIdx) return img;
          if (img.preview) URL.revokeObjectURL(img.preview);
          return { file: null, preview: null, error: null };
        });
        return { ...d, images: next };
      })
    );
  };

  const handleCategoryChange = (cat: { code: number; name: string; path: string }) => {
    updateActive({ categoryCode: cat.code, categoryName: cat.name, categoryPath: cat.path });
  };

  // ── Multi-product controls ────────────────────────────────────────────────
  //
  // The page already supports 1-N drafts via the `count` URL param. These
  // handlers expose the "grow / shrink" actions inline so sellers don't
  // have to go back to a count picker — they just keep adding.

  const syncCountToUrl = (next: number) => {
    // Use replace so back button doesn't accumulate intermediate counts.
    // scroll:false keeps the seller in place; otherwise the page jumps to
    // top each time they add or remove a product.
    router.replace(`/listings/new/batch?count=${next}`, { scroll: false });
  };

  const addProduct = () => {
    if (drafts.length >= MAX_PRODUCTS) return;
    const newDrafts = [...drafts, emptyDraft()];
    setDrafts(newDrafts);
    setActiveIdx(newDrafts.length - 1);
    syncCountToUrl(newDrafts.length);
  };

  const removeProduct = (idx: number) => {
    if (drafts.length <= MIN_PRODUCTS) return;
    // Revoke object URLs so we don't leak memory for the removed draft.
    drafts[idx].images.forEach((img) => {
      if (img.preview) URL.revokeObjectURL(img.preview);
    });
    const next = drafts.filter((_, i) => i !== idx);
    setDrafts(next);
    setActiveIdx((curr) => {
      if (curr === idx) return Math.max(0, idx - 1);
      if (curr > idx)   return curr - 1;
      return curr;
    });
    syncCountToUrl(next.length);
  };

  // Per-tab readiness summary (shown next to tab name).
  // Only the image is hard-required. Name + category are OPTIONAL because
  // the AI will fill them on Submit. If the user typed a name or picked a
  // category, we honour those values; otherwise the AI picks.
  const tabReady = useMemo(
    () =>
      drafts.map((d) => ({
        hasImage:    d.images.some((img) => img.file != null),
        hasName:     d.name.trim().length >= 15,
        hasCategory: d.categoryCode != null,
      })),
    [drafts]
  );

  const allValid = tabReady.every((t) => t.hasImage);

  // ── Submit handler: upload images → create drafts → run auto-analyze ────
  const [submitting, setSubmitting] = useState(false);
  const [submitStep, setSubmitStep] = useState<string>("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const router = useRouter();

  async function handleSubmit() {
    setSubmitting(true);
    setSubmitError(null);
    const listingIds: string[] = [];

    try {
      for (let i = 0; i < drafts.length; i++) {
        const d = drafts[i];
        const label = drafts.length === 1 ? "Uploading images…" : `Uploading product ${i + 1}/${drafts.length}…`;
        setSubmitStep(label);

        // 1. Upload images + create draft (no AI analysis yet)
        const fd = new FormData();
        fd.append("mode", "own");
        fd.append("skipAnalysis", "true");
        d.images.forEach((img) => {
          if (img.file) fd.append("files", img.file);
        });
        if (d.name.trim().length >= 15) fd.append("name", d.name.trim());
        if (d.categoryCode != null) {
          fd.append("categoryCode", String(d.categoryCode));
          if (d.categoryPath) fd.append("categoryPath", d.categoryPath);
        }
        // Persist the seller's "what do you want in the listing" text so
        // it survives across re-analyzes. The auto-analyze route also
        // updates this column, but we set it here too in case the seller
        // navigates away before the first analyze finishes.
        if (d.aiInstruction.trim()) {
          fd.append("userPrompt", d.aiInstruction.trim().slice(0, 1000));
        }

        const createRes = await fetch("/api/process-listing", { method: "POST", body: fd });
        const createData = await createRes.json();
        if (!createRes.ok || !createData.listingId) {
          throw new Error(createData.error ?? "Failed to create listing");
        }
        const listingId = createData.listingId as string;
        listingIds.push(listingId);

        // 2. Run the new auto-analyze pipeline (4 passes — picks category +
        //    fills attributes). If user already picked a category we still
        //    run it; the merge logic on the server respects their choice.
        setSubmitStep(
          drafts.length === 1
            ? "Analysing with AI…"
            : `Analysing product ${i + 1}/${drafts.length} with AI…`
        );
        const analyzeRes = await fetch(`/api/listings/${listingId}/auto-analyze`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: d.aiInstruction.trim()
            ? JSON.stringify({ userPrompt: d.aiInstruction.trim() })
            : undefined,
        });
        if (!analyzeRes.ok) {
          // Non-fatal — listing is created, AI just couldn't run. The user
          // can hit "Analyze with AI" again from the review page.
          console.warn(`[batch] auto-analyze failed for ${listingId}`);
        }
      }

      // All drafts created. Route to first product's review page so the
      // seller can verify + edit + submit to Jumia.
      if (listingIds.length > 0) {
        // Include the full batch ID list so the review page can show a
        // product switcher (prdt1 / prdt2 / prdt3 …) — preserves the
        // tabbed-upload experience after AI has finished. Also forward
        // the `enhance` param if the picker said to auto-rebuild — the
        // review page reads it and opens the rebuild modal on mount.
        const qs = new URLSearchParams();
        if (listingIds.length > 1) qs.set("batch", listingIds.join(","));
        const enhanceParam = search.get("enhance");
        if (enhanceParam === "rebuild") qs.set("enhance", "rebuild");
        const queryString = qs.toString() ? `?${qs.toString()}` : "";
        router.push(`/listings/${listingIds[0]}/review${queryString}`);
      }
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Something went wrong");
      setSubmitting(false);
    }
  }

  return (
    <div className="-m-4 sm:-m-6 lg:-m-8 min-h-[calc(100vh-3.5rem)] lg:min-h-screen bg-zinc-50 flex flex-col">
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="bg-white border-b border-zinc-200 sticky top-0 z-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 py-3 space-y-2">
          {/* Breadcrumb: own image > prdt1 > prdt2 > … + Add product */}
          <div className="flex items-center gap-1.5 text-xs text-zinc-500 overflow-x-auto pb-1">
            <Link href="/listings" className="hover:text-zinc-700">own image</Link>
            {drafts.map((_, i) => (
              <div key={i} className="flex items-center gap-1.5 shrink-0">
                <ChevronRight className="h-3 w-3 shrink-0" />
                <button
                  type="button"
                  onClick={() => setActiveIdx(i)}
                  className={cn(
                    "rounded px-1.5 py-0.5 transition-colors",
                    i === activeIdx
                      ? "font-semibold text-orange-500 bg-orange-50"
                      : "text-zinc-500 hover:text-zinc-700"
                  )}
                >
                  prdt{i + 1}
                </button>
              </div>
            ))}
            {drafts.length < MAX_PRODUCTS && (
              <button
                type="button"
                onClick={addProduct}
                disabled={submitting}
                className="ml-1 inline-flex items-center gap-1 rounded-md border border-dashed border-orange-300 px-2 py-0.5 text-[11px] font-medium text-orange-600 hover:bg-orange-50 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                title={`Add another product (max ${MAX_PRODUCTS})`}
              >
                <Plus className="h-3 w-3" />
                Add product
              </button>
            )}
          </div>
          {/* Title row */}
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" className="h-8 w-8 -ml-2" asChild>
              <Link href="/listings/new"><ArrowLeft className="h-4 w-4" /></Link>
            </Button>
            <h1 className="text-xl font-bold text-zinc-900 flex-1">Add Products</h1>
            <span className="text-xs text-zinc-500">
              Product {activeIdx + 1} of {drafts.length}
            </span>
          </div>
        </div>
      </div>

      {/* ── Body ──────────────────────────────────────────────────────────── */}
      <div className="mx-auto max-w-7xl w-full px-4 sm:px-6 py-6">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[180px_1fr]">

          {/* Sticky left rail (placeholder for symmetry with single-product page) */}
          <div className="hidden lg:block">
            <div className="sticky top-24 space-y-3">
              <div className="flex items-start gap-2">
                <div className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-orange-500 bg-white">
                  <span className="h-1.5 w-1.5 rounded-full bg-orange-500" />
                </div>
                <div className="text-xs leading-tight text-orange-500 font-semibold">
                  <p>Product</p><p>Information</p>
                </div>
              </div>
              <div className="ml-2.5 h-12 w-0.5 rounded-full bg-zinc-200" />
              <div className="flex items-start gap-2 opacity-60">
                <div className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-zinc-300 bg-white" />
                <div className="text-xs leading-tight text-zinc-400">
                  <p>Variants</p>
                </div>
              </div>
              <div className="ml-2.5 h-12 w-0.5 rounded-full bg-zinc-200" />
              <div className="flex items-start gap-2 opacity-60">
                <div className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-zinc-300 bg-white" />
                <div className="text-xs leading-tight text-zinc-400">
                  <p>Product</p><p>Specification</p>
                </div>
              </div>
            </div>
          </div>

          {/* Form */}
          <div className="space-y-4 pb-32">
            <section className="bg-white rounded-md border border-zinc-200 p-6 space-y-5">
              <h2 className="text-lg font-bold text-zinc-900">Product Information</h2>

              <ImageSlots
                slots={active.images}
                onPick={handlePickImage}
                onRemove={handleRemoveImage}
              />

              {/* AI prompt block — seller tells the AI what they want */}
              <div className="rounded-md border border-orange-200 bg-gradient-to-r from-orange-50 to-amber-50 px-4 py-3 space-y-2">
                <div className="flex items-start gap-3">
                  <Sparkles className="h-4 w-4 text-orange-500 mt-0.5 shrink-0" />
                  <p className="text-xs font-semibold text-orange-900">
                    What do you want in the listing
                  </p>
                </div>
                <Textarea
                  value={active.aiInstruction}
                  onChange={(e) => updateActive({ aiInstruction: e.target.value })}
                  rows={2}
                  maxLength={1000}
                  placeholder="Optional: tell the AI anything the images don't show. E.g. 'this is a pack of 6', 'the colour is teal not blue', 'specify it's wireless'."
                  className="text-xs bg-white border-orange-200 focus-visible:ring-orange-200"
                />
                <p className="text-[10px] text-orange-700/80 leading-relaxed">
                  AI can make mistakes, Please double check.
                </p>
              </div>

              {/* Name + Category — BOTH OPTIONAL (AI fills if blank) */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor={`name-${activeIdx}`} className="text-xs font-semibold text-zinc-700 flex items-center gap-1.5">
                    Name
                    <span className="text-[10px] font-normal text-zinc-400 normal-case">(optional · AI fills)</span>
                  </Label>
                  <Input
                    id={`name-${activeIdx}`}
                    value={active.name}
                    onChange={(e) => updateActive({ name: e.target.value })}
                    placeholder="Leave blank to let AI generate the name"
                    className="h-10 text-sm"
                  />
                  {active.name.length > 0 && (
                    <p className={cn(
                      "text-[11px]",
                      active.name.length < 15  ? "text-amber-600"   :
                                                 "text-emerald-600"
                    )}>
                      {active.name.length} characters
                      {active.name.length < 15 && " · min 15 for Jumia (or let AI rewrite)"}
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold text-zinc-700 flex items-center gap-1.5">
                    Category
                    <span className="text-[10px] font-normal text-zinc-400 normal-case">(optional · AI picks)</span>
                  </Label>
                  <button
                    type="button"
                    onClick={() => setShowCategoryPicker(true)}
                    className={cn(
                      "flex h-10 w-full items-center justify-between rounded-md border bg-white px-3 text-sm text-left transition-colors",
                      active.categoryName
                        ? "border-orange-500 text-zinc-800"
                        : "border-zinc-200 text-zinc-400 hover:border-zinc-300"
                    )}
                  >
                    <span className="truncate">{active.categoryName || "Leave blank to let AI pick"}</span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-zinc-400" />
                  </button>
                </div>
              </div>

              {/* Tab nav at bottom: per-product switcher + add/remove pills.
                  Always rendered (even at count===1) so the "+ Add product"
                  pill is discoverable without scrolling to the breadcrumb. */}
              <div className="border-t pt-4 flex flex-wrap gap-2 items-center">
                {drafts.length > 1 && drafts.map((d, i) => {
                  const isActive = i === activeIdx;
                  const status   = tabReady[i];
                  const ready    = status.hasImage;   // images are the only hard requirement
                  return (
                    <div
                      key={i}
                      className={cn(
                        "rounded-full border transition-colors flex items-center pl-3 pr-1.5 py-0.5 text-xs font-medium",
                        isActive
                          ? "border-orange-500 bg-orange-50 text-orange-600"
                          : ready
                          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                          : "border-zinc-200 bg-white text-zinc-500 hover:border-zinc-300",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => setActiveIdx(i)}
                        className="inline-flex items-center gap-1.5 py-1"
                      >
                        <span className={cn(
                          "h-1.5 w-1.5 rounded-full",
                          isActive ? "bg-orange-500" : ready ? "bg-emerald-500" : "bg-zinc-300"
                        )} />
                        {d.name.trim() || `Product ${i + 1}`}
                      </button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); removeProduct(i); }}
                        disabled={submitting}
                        className="ml-1.5 flex h-5 w-5 items-center justify-center rounded-full text-zinc-400 hover:bg-red-50 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-50"
                        aria-label={`Remove product ${i + 1}`}
                        title="Remove this product from the batch"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  );
                })}
                {drafts.length < MAX_PRODUCTS && (
                  <button
                    type="button"
                    onClick={addProduct}
                    disabled={submitting}
                    className="rounded-full border border-dashed border-orange-300 px-3 py-1.5 text-xs font-medium text-orange-600 hover:bg-orange-50 transition-colors flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Plus className="h-3 w-3" />
                    Add another product
                  </button>
                )}
                {drafts.length >= MAX_PRODUCTS && (
                  <span className="text-[11px] text-zinc-400">
                    Batch limit reached ({MAX_PRODUCTS} products).
                  </span>
                )}
              </div>
            </section>
          </div>
        </div>
      </div>

      {/* ── Floating Submit (bottom-right) ────────────────────────────────── */}
      <div className="fixed bottom-6 right-6 z-30 flex items-end gap-2 flex-col sm:flex-row">
        {submitError && (
          <span className="max-w-[260px] rounded-md bg-white border border-red-200 px-3 py-1.5 text-[11px] text-red-600 shadow-sm">
            {submitError}
          </span>
        )}
        {!allValid && !submitting && (
          <span className="rounded-md bg-white border border-zinc-200 px-3 py-1.5 text-[11px] text-zinc-500 shadow-sm">
            Upload at least 1 image on each tab
          </span>
        )}
        {submitting && (
          <span className="rounded-md bg-white border border-blue-200 px-3 py-1.5 text-[11px] text-blue-700 shadow-sm flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" />
            {submitStep}
          </span>
        )}
        <Button
          type="button"
          size="lg"
          disabled={!allValid || submitting}
          onClick={handleSubmit}
          className="bg-orange-500 hover:bg-orange-600 text-white shadow-lg shadow-orange-500/30 disabled:bg-zinc-200 disabled:text-zinc-400 disabled:shadow-none gap-2 px-8"
        >
          {submitting
            ? <><Loader2 className="h-4 w-4 animate-spin" /> Working…</>
            : <><Sparkles className="h-4 w-4" /> Generate listing</>}
        </Button>
      </div>

      <CategoryDrawer
        open={showCategoryPicker}
        onClose={() => setShowCategoryPicker(false)}
        onSelect={handleCategoryChange}
        initialPath={active.categoryPath ?? undefined}
      />
    </div>
  );
}
