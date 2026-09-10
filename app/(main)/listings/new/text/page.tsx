"use client";

/**
 * Text-to-image batch flow.
 *
 * Routed from the Add Product picker (option 2: "Text-to-image listing").
 * Business-tier-only; the picker hides this option for lower plans, but
 * we also guard server-side at /api/generate-product-image.
 *
 * Per product the seller types:
 *   - A product description (required, 5–500 chars)  → the image prompt
 *   - An optional name + category (AI fills if blank)
 *
 * On submit, for each product:
 *   1. Create bare draft via /api/process-listing (skipAnalysis + textToImage)
 *   2. Generate image via /api/generate-product-image — appends to listing
 *   3. Run /api/listings/[id]/auto-analyze with the description as userPrompt
 *      so title / description / category / attributes get filled
 *   4. Route the seller to the review page (with batch-tab support)
 *
 * Mirrors the layout / multi-product UX of /listings/new/batch — same
 * count tabs, same floating Submit. The only differences are the prompt
 * input (instead of an 8-image grid) and the per-product success message
 * ("image generated, listing analysed").
 */

import { useEffect, useMemo, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  ChevronRight,
  Plus,
  X,
  Loader2,
  Sparkles,
  Wand2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CategoryDrawer } from "@/components/ui/category-drawer";
import { cn } from "@/lib/utils";

const MIN_PRODUCTS = 1;
const MAX_PRODUCTS = 10;
const MIN_PROMPT_LEN = 5;
const MAX_PROMPT_LEN = 500;

type AspectRatio = "1:1" | "3:4" | "4:3";

interface ProductDraft {
  /** What the seller wants the AI to draw + describe. */
  prompt:       string;
  /** Image shape. 1:1 is recommended for Jumia. */
  aspect:       AspectRatio;
  /** Optional pre-fill — AI auto-generates if blank. */
  name:         string;
  categoryCode: number | null;
  categoryName: string | null;
  categoryPath: string | null;
}

function emptyDraft(): ProductDraft {
  return {
    prompt:       "",
    aspect:       "1:1",
    name:         "",
    categoryCode: null,
    categoryName: null,
    categoryPath: null,
  };
}

const PROMPT_HINTS = [
  "A matte black leather wallet, 4-card slot, studio lighting",
  "Red ceramic teapot with bamboo handle, top-down view",
  "Wireless earbuds in a transparent charging case, side view",
  "Wooden cutting board with stainless steel handle",
];

export default function TextToImageBatchPage() {
  const search = useSearchParams();
  const router = useRouter();
  const rawCount = parseInt(search.get("count") ?? "1", 10);
  const count = Math.max(MIN_PRODUCTS, Math.min(MAX_PRODUCTS, isNaN(rawCount) ? 1 : rawCount));

  const [drafts, setDrafts] = useState<ProductDraft[]>(() =>
    Array.from({ length: count }, emptyDraft),
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

  const active = drafts[activeIdx];

  const updateActive = (patch: Partial<ProductDraft>) => {
    setDrafts((prev) => prev.map((d, i) => (i === activeIdx ? { ...d, ...patch } : d)));
  };

  const handleCategoryChange = (cat: { code: number; name: string; path: string }) => {
    updateActive({ categoryCode: cat.code, categoryName: cat.name, categoryPath: cat.path });
  };

  const syncCountToUrl = (next: number) => {
    router.replace(`/listings/new/text?count=${next}`, { scroll: false });
  };

  const addProduct = () => {
    if (drafts.length >= MAX_PRODUCTS) return;
    const next = [...drafts, emptyDraft()];
    setDrafts(next);
    setActiveIdx(next.length - 1);
    syncCountToUrl(next.length);
  };

  const removeProduct = (idx: number) => {
    if (drafts.length <= MIN_PRODUCTS) return;
    const next = drafts.filter((_, i) => i !== idx);
    setDrafts(next);
    setActiveIdx((curr) => {
      if (curr === idx) return Math.max(0, idx - 1);
      if (curr > idx)   return curr - 1;
      return curr;
    });
    syncCountToUrl(next.length);
  };

  // Per-tab readiness — every tab needs a prompt of at least MIN_PROMPT_LEN.
  const tabReady = useMemo(
    () =>
      drafts.map((d) => ({
        hasPrompt: d.prompt.trim().length >= MIN_PROMPT_LEN,
      })),
    [drafts],
  );
  const allValid = tabReady.every((t) => t.hasPrompt);

  // ── Submit ────────────────────────────────────────────────────────────
  const [submitting, setSubmitting] = useState(false);
  const [submitStep, setSubmitStep] = useState<string>("");
  const [submitError, setSubmitError] = useState<string | null>(null);

  async function handleSubmit() {
    setSubmitting(true);
    setSubmitError(null);
    const listingIds: string[] = [];

    try {
      for (let i = 0; i < drafts.length; i++) {
        const d = drafts[i];
        const label = drafts.length === 1
          ? "Creating draft…"
          : `Creating draft ${i + 1}/${drafts.length}…`;
        setSubmitStep(label);

        // 1. Bare draft — no images yet. Allow empty images via textToImage flag.
        const fd = new FormData();
        fd.append("mode", "own");
        fd.append("skipAnalysis", "true");
        fd.append("textToImage", "true");
        if (d.name.trim().length >= 15) fd.append("name", d.name.trim());
        if (d.categoryCode != null) {
          fd.append("categoryCode", String(d.categoryCode));
          if (d.categoryPath) fd.append("categoryPath", d.categoryPath);
        }

        const createRes = await fetch("/api/process-listing", { method: "POST", body: fd });
        const createData = await createRes.json();
        if (!createRes.ok || !createData.listingId) {
          throw new Error(createData.error ?? "Failed to create draft");
        }
        const listingId = createData.listingId as string;
        listingIds.push(listingId);

        // 2. Generate the product image via Gemini 2.5 Image
        setSubmitStep(
          drafts.length === 1
            ? "Generating product image…"
            : `Generating image ${i + 1}/${drafts.length}…`,
        );
        const genRes = await fetch("/api/generate-product-image", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({
            listingId,
            prompt:      d.prompt.trim(),
            aspectRatio: d.aspect,
          }),
        });
        const genData = await genRes.json();
        if (!genRes.ok) {
          throw new Error(genData.error ?? "Image generation failed");
        }

        // 3. Auto-analyze with the prompt threaded in
        setSubmitStep(
          drafts.length === 1
            ? "Writing the listing…"
            : `Writing listing ${i + 1}/${drafts.length}…`,
        );
        const analyzeRes = await fetch(`/api/listings/${listingId}/auto-analyze`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ userPrompt: d.prompt.trim() }),
        });
        if (!analyzeRes.ok) {
          // Non-fatal — image was generated, listing exists. Seller can
          // hit "Re-analyze" from the review page.
          console.warn(`[text-batch] auto-analyze failed for ${listingId}`);
        }
      }

      if (listingIds.length > 0) {
        const batchQuery = listingIds.length > 1
          ? `?batch=${listingIds.join(",")}`
          : "";
        router.push(`/listings/${listingIds[0]}/review${batchQuery}`);
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
          <div className="flex items-center gap-1.5 text-xs text-zinc-500 overflow-x-auto pb-1">
            <Link href="/listings" className="hover:text-zinc-700">text-to-image</Link>
            {drafts.map((_, i) => (
              <div key={i} className="flex items-center gap-1.5 shrink-0">
                <ChevronRight className="h-3 w-3 shrink-0" />
                <button
                  type="button"
                  onClick={() => setActiveIdx(i)}
                  className={cn(
                    "rounded px-1.5 py-0.5 transition-colors",
                    i === activeIdx
                      ? "font-semibold text-fuchsia-600 bg-fuchsia-50"
                      : "text-zinc-500 hover:text-zinc-700",
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
                className="ml-1 inline-flex items-center gap-1 rounded-md border border-dashed border-fuchsia-300 px-2 py-0.5 text-[11px] font-medium text-fuchsia-600 hover:bg-fuchsia-50 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                title={`Add another product (max ${MAX_PRODUCTS})`}
              >
                <Plus className="h-3 w-3" />
                Add product
              </button>
            )}
          </div>
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" className="h-8 w-8 -ml-2" asChild>
              <Link href="/listings"><ArrowLeft className="h-4 w-4" /></Link>
            </Button>
            <h1 className="text-xl font-bold text-zinc-900 flex-1">
              Add Products — text-to-image
            </h1>
            <span className="text-xs text-zinc-500">
              Product {activeIdx + 1} of {drafts.length}
            </span>
          </div>
        </div>
      </div>

      {/* ── Body ──────────────────────────────────────────────────────────── */}
      <div className="mx-auto max-w-7xl w-full px-4 sm:px-6 py-6">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[180px_1fr]">

          {/* Sticky left rail */}
          <div className="hidden lg:block">
            <div className="sticky top-24 space-y-3">
              <div className="flex items-start gap-2">
                <div className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-fuchsia-500 bg-white">
                  <span className="h-1.5 w-1.5 rounded-full bg-fuchsia-500" />
                </div>
                <div className="text-xs leading-tight text-fuchsia-600 font-semibold">
                  <p>Describe</p><p>Your Product</p>
                </div>
              </div>
              <div className="ml-2.5 h-12 w-0.5 rounded-full bg-zinc-200" />
              <div className="flex items-start gap-2 opacity-60">
                <div className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-zinc-300 bg-white" />
                <div className="text-xs leading-tight text-zinc-400">
                  <p>Generate</p><p>Image</p>
                </div>
              </div>
              <div className="ml-2.5 h-12 w-0.5 rounded-full bg-zinc-200" />
              <div className="flex items-start gap-2 opacity-60">
                <div className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-zinc-300 bg-white" />
                <div className="text-xs leading-tight text-zinc-400">
                  <p>Review</p><p>& Submit</p>
                </div>
              </div>
            </div>
          </div>

          {/* Form */}
          <div className="space-y-4 pb-32">
            <section className="bg-white rounded-md border border-zinc-200 p-6 space-y-5">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white shadow-sm">
                  <Wand2 className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-zinc-900">Describe your product</h2>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    Gemini 2.5 Image will generate a studio shot from your words.
                  </p>
                </div>
              </div>

              {/* Prompt */}
              <div className="space-y-2">
                <Label htmlFor={`prompt-${activeIdx}`} className="text-xs font-semibold text-zinc-700">
                  What does the product look like?
                </Label>
                <Textarea
                  id={`prompt-${activeIdx}`}
                  rows={4}
                  value={active.prompt}
                  onChange={(e) => updateActive({ prompt: e.target.value })}
                  maxLength={MAX_PROMPT_LEN}
                  placeholder="A matte black leather wallet, 4-card slot, studio lighting, front view…"
                  className="text-sm"
                  disabled={submitting}
                />
                <div className="flex items-center justify-between">
                  <p className="text-[10px] text-zinc-400">
                    {active.prompt.length} / {MAX_PROMPT_LEN} characters · mention colour, material, angle, details
                  </p>
                  {active.prompt.trim().length > 0 && active.prompt.trim().length < MIN_PROMPT_LEN && (
                    <p className="text-[10px] text-amber-600">
                      Need at least {MIN_PROMPT_LEN} characters
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {PROMPT_HINTS.map((h) => (
                    <button
                      key={h}
                      type="button"
                      onClick={() => updateActive({ prompt: h })}
                      disabled={submitting}
                      className="rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-0.5 text-[10px] text-zinc-600 hover:bg-zinc-100 disabled:opacity-50"
                    >
                      {h.slice(0, 40)}…
                    </button>
                  ))}
                </div>
              </div>

              {/* Aspect ratio */}
              <div className="space-y-2">
                <Label className="text-xs font-semibold text-zinc-700">Image shape</Label>
                <div className="flex gap-2">
                  {(["1:1", "3:4", "4:3"] as AspectRatio[]).map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => updateActive({ aspect: r })}
                      disabled={submitting}
                      className={cn(
                        "flex-1 rounded-lg border px-3 py-2 text-xs transition-colors",
                        active.aspect === r
                          ? "border-fuchsia-500 bg-fuchsia-50 text-fuchsia-700 font-semibold"
                          : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50",
                      )}
                    >
                      <span className="block text-sm font-mono">{r}</span>
                      <span className="text-[10px] text-zinc-400">
                        {r === "1:1" ? "Square (recommended)" : r === "3:4" ? "Portrait" : "Landscape"}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Name + Category — both optional */}
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
                        ? "border-fuchsia-500 text-zinc-800"
                        : "border-zinc-200 text-zinc-400 hover:border-zinc-300",
                    )}
                  >
                    <span className="truncate">{active.categoryName || "Leave blank to let AI pick"}</span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-zinc-400" />
                  </button>
                </div>
              </div>

              {/* Tab nav */}
              <div className="border-t pt-4 flex flex-wrap gap-2 items-center">
                {drafts.length > 1 && drafts.map((d, i) => {
                  const isActive = i === activeIdx;
                  const ready    = tabReady[i].hasPrompt;
                  return (
                    <div
                      key={i}
                      className={cn(
                        "rounded-full border transition-colors flex items-center pl-3 pr-1.5 py-0.5 text-xs font-medium",
                        isActive
                          ? "border-fuchsia-500 bg-fuchsia-50 text-fuchsia-600"
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
                          isActive ? "bg-fuchsia-500" : ready ? "bg-emerald-500" : "bg-zinc-300",
                        )} />
                        {d.name.trim() || `Product ${i + 1}`}
                      </button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); removeProduct(i); }}
                        disabled={submitting}
                        className="ml-1.5 flex h-5 w-5 items-center justify-center rounded-full text-zinc-400 hover:bg-red-50 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-50"
                        aria-label={`Remove product ${i + 1}`}
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
                    className="rounded-full border border-dashed border-fuchsia-300 px-3 py-1.5 text-xs font-medium text-fuchsia-600 hover:bg-fuchsia-50 transition-colors flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Plus className="h-3 w-3" />
                    Add another product
                  </button>
                )}
              </div>
            </section>
          </div>
        </div>
      </div>

      {/* ── Floating Submit ───────────────────────────────────────────────── */}
      <div className="fixed bottom-6 right-6 z-30 flex items-end gap-2 flex-col sm:flex-row">
        {submitError && (
          <span className="max-w-[260px] rounded-md bg-white border border-red-200 px-3 py-1.5 text-[11px] text-red-600 shadow-sm">
            {submitError}
          </span>
        )}
        {!allValid && !submitting && (
          <span className="rounded-md bg-white border border-zinc-200 px-3 py-1.5 text-[11px] text-zinc-500 shadow-sm">
            Type a prompt on every tab (min {MIN_PROMPT_LEN} chars)
          </span>
        )}
        {submitting && (
          <span className="rounded-md bg-white border border-fuchsia-200 px-3 py-1.5 text-[11px] text-fuchsia-700 shadow-sm flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" />
            {submitStep}
          </span>
        )}
        <Button
          type="button"
          size="lg"
          disabled={!allValid || submitting}
          onClick={handleSubmit}
          className="bg-gradient-to-r from-violet-500 to-fuchsia-500 hover:from-violet-600 hover:to-fuchsia-600 text-white shadow-lg shadow-fuchsia-500/30 disabled:bg-zinc-200 disabled:text-zinc-400 disabled:shadow-none gap-2 px-8"
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
