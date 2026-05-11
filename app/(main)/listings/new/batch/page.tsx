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
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ChevronRight, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

  // Per-tab readiness summary (shown next to tab name)
  const tabReady = useMemo(
    () =>
      drafts.map((d) => ({
        hasImage:    d.images.some((img) => img.file != null),
        hasName:     d.name.trim().length >= 15,
        hasCategory: d.categoryCode != null,
      })),
    [drafts]
  );

  const allValid = tabReady.every((t) => t.hasImage && t.hasName && t.hasCategory);

  return (
    <div className="-m-4 sm:-m-6 lg:-m-8 min-h-[calc(100vh-3.5rem)] lg:min-h-screen bg-zinc-50 flex flex-col">
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="bg-white border-b border-zinc-200 sticky top-0 z-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 py-3 space-y-2">
          {/* Breadcrumb: own image > prdt1 > prdt2 > ... */}
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
          </div>
          {/* Title row */}
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" className="h-8 w-8 -ml-2" asChild>
              <Link href="/listings/new?mode=own&step=count"><ArrowLeft className="h-4 w-4" /></Link>
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

              {/* Name + Category */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor={`name-${activeIdx}`} className="text-xs font-semibold text-zinc-700">
                    Name<span className="ml-0.5 text-orange-500">*</span>
                  </Label>
                  <Input
                    id={`name-${activeIdx}`}
                    value={active.name}
                    onChange={(e) => updateActive({ name: e.target.value })}
                    placeholder="Ex: Wireless Noise-Cancelling Headphones [Clear product name for a better c..."
                    className="h-10 text-sm"
                    maxLength={70}
                  />
                  <p className={cn(
                    "text-[11px]",
                    active.name.length === 0 ? "text-zinc-400" :
                    active.name.length < 15  ? "text-red-500"  :
                    active.name.length > 70  ? "text-red-500"  :
                                               "text-emerald-600"
                  )}>
                    {active.name.length}/70 characters · min 15
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold text-zinc-700">
                    Category<span className="ml-0.5 text-orange-500">*</span>
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
                    <span className="truncate">{active.categoryName || "Category"}</span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-zinc-400" />
                  </button>
                </div>
              </div>

              {/* Tab nav at bottom (mobile-friendly secondary switcher) */}
              {drafts.length > 1 && (
                <div className="border-t pt-4 flex flex-wrap gap-2">
                  {drafts.map((d, i) => {
                    const isActive = i === activeIdx;
                    const status   = tabReady[i];
                    const ready    = status.hasImage && status.hasName && status.hasCategory;
                    return (
                      <button
                        key={i}
                        type="button"
                        onClick={() => setActiveIdx(i)}
                        className={cn(
                          "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors flex items-center gap-1.5",
                          isActive
                            ? "border-orange-500 bg-orange-50 text-orange-600"
                            : ready
                            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                            : "border-zinc-200 bg-white text-zinc-500 hover:border-zinc-300",
                        )}
                      >
                        <span className={cn(
                          "h-1.5 w-1.5 rounded-full",
                          isActive ? "bg-orange-500" : ready ? "bg-emerald-500" : "bg-zinc-300"
                        )} />
                        {d.name.trim() || `Product ${i + 1}`}
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        </div>
      </div>

      {/* ── Floating Submit (bottom-right, disabled until all valid) ──────── */}
      <div className="fixed bottom-6 right-6 z-30 flex items-center gap-2">
        {!allValid && (
          <span className="rounded-md bg-white border border-zinc-200 px-3 py-1.5 text-[11px] text-zinc-500 shadow-sm">
            Fill name (15+), category and at least 1 image on each tab
          </span>
        )}
        <Button
          type="button"
          size="lg"
          disabled={!allValid}
          className="bg-orange-500 hover:bg-orange-600 text-white shadow-lg shadow-orange-500/30 disabled:bg-zinc-200 disabled:text-zinc-400 disabled:shadow-none gap-2 px-8"
          onClick={() => {
            // Continue to AI processing / review wired up in a follow-up prompt.
            // For now: show a toast-style hint so the user knows the next step
            // is intentional and not missing.
            window.alert("Next step: AI analysis + Variants + Product Specification — wired up in the next prompt.");
          }}
        >
          Submit
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
