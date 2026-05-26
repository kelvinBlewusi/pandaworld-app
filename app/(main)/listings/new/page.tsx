"use client";

/**
 * Add Product — mode picker.
 *
 * Three flows live downstream of this page; the seller picks one before
 * they upload anything. This is the single source of truth for that
 * choice — every "Add Product" CTA in the app routes here first.
 *
 *   1. "List with your own images"     → /listings/new/batch?count=N&mode=own
 *      (ACTIVE — primary flow as of May 2026)
 *      Seller's photos are already studio-quality. Skip the AI image
 *      step entirely. Listing text + category get AI-generated using
 *      our premium model (Gemini 2.5 Pro) so the listing is rich.
 *
 *   2. "Rebuild image and listing"     → DISABLED (maintenance)
 *      Was: upload rough photos, AI re-renders as studio shots.
 *      Disabled because the underlying image-edit model output quality
 *      isn't where we want it yet. Re-enabled once we ship a better one.
 *
 *   3. "Text-to-image listing"         → DISABLED (maintenance)
 *      Was: type a description, generate a studio shot from scratch.
 *      Disabled alongside Rebuild — both will return when the image
 *      pipeline ships a model upgrade.
 *
 * Visual treatment for disabled modes:
 *   - Card stays visible (so sellers know the feature is coming)
 *   - "Maintenance" badge in amber instead of the original colour
 *   - Click is a no-op; cursor reflects unavailable state
 *   - Subtitle text replaced with "Currently unavailable — back soon"
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Sparkles,
  Wand2,
  ImagePlus,
  ChevronRight,
  Plus,
  Minus,
  Camera,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Mode = "own" | "rebuild" | "text";

const MIN_PRODUCTS = 1;
const MAX_PRODUCTS = 10;

interface ModeOption {
  id:            Mode;
  title:         string;
  subtitle:      string;
  description:   string;
  icon:          React.ElementType;
  /** Tailwind classes for the icon background gradient */
  iconClass:     string;
  /** Tailwind classes for the card hover ring */
  ringClass:     string;
  /** If true, card renders disabled with a "Coming back soon" overlay. */
  maintenance?:  boolean;
}

// Order is intentional: "own" first because it's the only active flow.
// The other two stay in the list so sellers know they're coming back —
// just visually disabled with a maintenance message.
const MODE_OPTIONS: ModeOption[] = [
  {
    id:          "own",
    title:       "List with your own images",
    subtitle:    "Recommended — fastest, richest listings",
    description:
      "Upload your product photos. Our AI writes a complete Jumia listing — title, description, category, attributes — using our best model. Pass QC the first time.",
    icon:        ImagePlus,
    iconClass:   "from-emerald-500 to-teal-500",
    ringClass:   "hover:ring-emerald-200 hover:border-emerald-300",
  },
  {
    id:          "rebuild",
    title:       "Rebuild image and listing",
    subtitle:    "Currently unavailable — back soon",
    description:
      "Upload rough phone photos, our AI re-renders each one as a clean studio shot on white. Coming back once we ship a better image model.",
    icon:        Sparkles,
    iconClass:   "from-orange-500 to-amber-500",
    ringClass:   "",
    maintenance: true,
  },
  {
    id:          "text",
    title:       "Text-to-image listing",
    subtitle:    "Currently unavailable — back soon",
    description:
      "Describe the product in words, AI generates the studio shot. Paused while we upgrade the image generator.",
    icon:        Wand2,
    iconClass:   "from-violet-500 to-fuchsia-500",
    ringClass:   "",
    maintenance: true,
  },
];

export default function AddProductPicker() {
  const router = useRouter();
  const [selected, setSelected] = useState<Mode | null>("own");
  const [count, setCount]       = useState(1);
  const [busy, setBusy] = useState(false);

  const handleContinue = () => {
    if (!selected || busy) return;
    const option = MODE_OPTIONS.find((m) => m.id === selected);
    if (option?.maintenance) return; // belt-and-braces — UI also blocks click
    setBusy(true);

    const n = Math.max(MIN_PRODUCTS, Math.min(MAX_PRODUCTS, count));

    switch (selected) {
      case "own":
        router.push(`/listings/new/batch?count=${n}&mode=own`);
        break;
      // The remaining cases are disabled at the card level; this is a
      // safety net only — should never run while those modes are on
      // maintenance.
      case "rebuild":
        router.push(`/listings/new/batch?count=${n}&enhance=rebuild`);
        break;
      case "text":
        router.push(`/listings/new/text?count=${n}`);
        break;
    }
  };

  return (
    <div className="-m-4 sm:-m-6 lg:-m-8 min-h-[calc(100vh-3.5rem)] lg:min-h-screen bg-zinc-50">
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="bg-white border-b border-zinc-200 sticky top-0 z-20">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 py-3 space-y-2">
          <div className="flex items-center gap-1.5 text-xs text-zinc-500">
            <Link href="/listings" className="hover:text-zinc-700">Products</Link>
            <ChevronRight className="h-3 w-3" />
            <span className="font-semibold text-orange-500">Add Product</span>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" className="h-8 w-8 -ml-2" asChild>
              <Link href="/listings"><ArrowLeft className="h-4 w-4" /></Link>
            </Button>
            <h1 className="text-xl font-bold text-zinc-900 flex-1">How do you want to add this product?</h1>
          </div>
        </div>
      </div>

      {/* ── Body ──────────────────────────────────────────────────────────── */}
      <div className="mx-auto max-w-5xl px-4 sm:px-6 py-8">
        {/* Mode cards */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {MODE_OPTIONS.map((opt) => {
            const Icon       = opt.icon;
            const disabled   = Boolean(opt.maintenance);
            const isSelected = !disabled && selected === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => !disabled && setSelected(opt.id)}
                disabled={disabled || busy}
                aria-disabled={disabled}
                className={cn(
                  "group relative flex flex-col items-start gap-3 rounded-2xl border-2 bg-white p-5 text-left transition-all",
                  isSelected
                    ? "border-orange-500 ring-2 ring-orange-100 shadow-md"
                    : "border-zinc-200 ring-1 ring-transparent",
                  !disabled && !isSelected && opt.ringClass,
                  disabled && "opacity-60 cursor-not-allowed grayscale-[0.5]",
                )}
              >
                {disabled && (
                  <span className="absolute top-3 right-3 inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-700">
                    <Wrench className="h-2.5 w-2.5" />
                    Maintenance
                  </span>
                )}
                <div
                  className={cn(
                    "flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-sm",
                    opt.iconClass,
                  )}
                >
                  <Icon className="h-5 w-5" />
                </div>
                <div className="space-y-1">
                  <h3 className="text-sm font-bold text-zinc-900">{opt.title}</h3>
                  <p className={cn(
                    "text-[11px] font-semibold uppercase tracking-wide",
                    disabled ? "text-amber-600" : "text-orange-500",
                  )}>{opt.subtitle}</p>
                </div>
                <p className="text-xs text-zinc-600 leading-relaxed">
                  {opt.description}
                </p>
                {disabled && (
                  <p className="text-[10px] text-amber-700 mt-1 italic">
                    This tool is currently experiencing downtime. It&apos;ll be back soon.
                  </p>
                )}
              </button>
            );
          })}
        </div>

        {/* Product count + Continue */}
        <div className="mt-8 flex flex-col sm:flex-row items-start sm:items-center gap-4 rounded-2xl border bg-white p-5">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-zinc-900">How many products do you want to add?</p>
            <p className="text-xs text-zinc-500 mt-0.5">
              Up to {MAX_PRODUCTS} at once — switch between them using tabs on the next screen.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-9 w-9"
              onClick={() => setCount((c) => Math.max(MIN_PRODUCTS, c - 1))}
              disabled={count <= MIN_PRODUCTS || busy}
              aria-label="Decrease"
            >
              <Minus className="h-4 w-4" />
            </Button>
            <span className="inline-flex h-9 min-w-[3rem] items-center justify-center rounded-md border bg-zinc-50 px-3 text-sm font-bold text-zinc-900">
              {count}
            </span>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-9 w-9"
              onClick={() => setCount((c) => Math.min(MAX_PRODUCTS, c + 1))}
              disabled={count >= MAX_PRODUCTS || busy}
              aria-label="Increase"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          <Button
            type="button"
            size="lg"
            disabled={!selected || busy}
            onClick={handleContinue}
            className="bg-orange-500 hover:bg-orange-600 text-white shadow-lg shadow-orange-500/30 disabled:bg-zinc-200 disabled:text-zinc-400 disabled:shadow-none gap-2 px-6"
          >
            <Camera className="h-4 w-4" />
            Continue
          </Button>
        </div>
      </div>
    </div>
  );
}
