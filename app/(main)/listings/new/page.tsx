"use client";

/**
 * Add Product — mode picker.
 *
 * Three flows live downstream of this page; the seller picks one before
 * they upload anything. This is the single source of truth for that
 * choice — every "Add Product" CTA in the app routes here first.
 *
 *   1. "Rebuild image and listing"     → /listings/new/batch?count=N&enhance=rebuild
 *      Seller has photos but they're amateurish (phone camera, busy
 *      background). We upload, then auto-rebuild each as a studio shot
 *      on white in the review page.
 *
 *   2. "Text-to-image listing"         → /listings/new/text?count=N
 *      Seller has NO photos. They type a description and Gemini 2.5 Image
 *      generates a studio shot from scratch. Business-tier only.
 *
 *   3. "List with your own images"     → /listings/new/batch?count=N&mode=own
 *      Seller's photos are already studio-quality. Skip the AI image
 *      step entirely. Listing text + category still get AI-generated.
 *
 * This replaces the old auto-redirect to /listings/new/batch?count=1
 * (preserved here as a fallback for sellers who want to bypass the
 * picker — the URL still works directly).
 */

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Sparkles,
  Wand2,
  ImagePlus,
  ChevronRight,
  Lock,
  Plus,
  Minus,
  Camera,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getQuotaSummaryForCurrentUser } from "@/lib/actions/subscription";

type Mode = "rebuild" | "text" | "own";

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
  /** "Business" badge if the mode is gated */
  businessOnly?: boolean;
}

const MODE_OPTIONS: ModeOption[] = [
  {
    id:          "rebuild",
    title:       "Rebuild image and listing",
    subtitle:    "Recommended for most sellers",
    description:
      "Upload your photos — even amateur phone shots. Our AI rebuilds each one as a clean, studio-quality image on white, then writes the full listing (title, description, category, attributes).",
    icon:        Sparkles,
    iconClass:   "from-orange-500 to-amber-500",
    ringClass:   "hover:ring-orange-200 hover:border-orange-300",
  },
  {
    id:          "text",
    title:       "Text-to-image listing",
    subtitle:    "No photo needed",
    description:
      "Don't have a product photo? Describe the product in words and our AI generates a studio shot from scratch, plus the full listing.",
    icon:        Wand2,
    iconClass:   "from-violet-500 to-fuchsia-500",
    ringClass:   "hover:ring-fuchsia-200 hover:border-fuchsia-300",
    businessOnly: true,
  },
  {
    id:          "own",
    title:       "List with your own images",
    subtitle:    "Skip image enhancement",
    description:
      "Already have studio-quality photos? Upload them as-is. We'll skip the image rebuild and just write the listing (title, description, category, attributes).",
    icon:        ImagePlus,
    iconClass:   "from-emerald-500 to-teal-500",
    ringClass:   "hover:ring-emerald-200 hover:border-emerald-300",
  },
];

export default function AddProductPicker() {
  const router = useRouter();
  const [selected, setSelected] = useState<Mode | null>(null);
  const [count, setCount]       = useState(1);
  const [canGenerate, setCanGenerate] = useState(false);
  const [busy, setBusy] = useState(false);

  // Check whether the user is on the Business plan (or Admin). The
  // "Text-to-image" mode is gated server-side, but disabling the card
  // up-front gives a cleaner UX than letting them click through and
  // bounce at /api/generate-product-image.
  useEffect(() => {
    getQuotaSummaryForCurrentUser().then((q) => {
      if (!q) return;
      setCanGenerate(q.is_admin || q.plan === "business");
    });
  }, []);

  const handleContinue = () => {
    if (!selected || busy) return;
    setBusy(true);

    const n = Math.max(MIN_PRODUCTS, Math.min(MAX_PRODUCTS, count));

    switch (selected) {
      case "rebuild":
        router.push(`/listings/new/batch?count=${n}&enhance=rebuild`);
        break;
      case "text":
        router.push(`/listings/new/text?count=${n}`);
        break;
      case "own":
        router.push(`/listings/new/batch?count=${n}&mode=own`);
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
            const disabled   = opt.businessOnly && !canGenerate;
            const isSelected = selected === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => !disabled && setSelected(opt.id)}
                disabled={disabled || busy}
                className={cn(
                  "group relative flex flex-col items-start gap-3 rounded-2xl border-2 bg-white p-5 text-left transition-all",
                  isSelected
                    ? "border-orange-500 ring-2 ring-orange-100 shadow-md"
                    : "border-zinc-200 ring-1 ring-transparent",
                  !disabled && !isSelected && opt.ringClass,
                  disabled && "opacity-60 cursor-not-allowed",
                )}
              >
                {opt.businessOnly && (
                  <span className={cn(
                    "absolute top-3 right-3 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
                    canGenerate
                      ? "bg-fuchsia-100 text-fuchsia-700"
                      : "bg-zinc-100 text-zinc-500"
                  )}>
                    {canGenerate ? "Business" : (
                      <span className="inline-flex items-center gap-1">
                        <Lock className="h-2.5 w-2.5" />
                        Business
                      </span>
                    )}
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
                  <p className="text-[11px] font-semibold text-orange-500 uppercase tracking-wide">{opt.subtitle}</p>
                </div>
                <p className="text-xs text-zinc-600 leading-relaxed">
                  {opt.description}
                </p>
                {disabled && (
                  <p className="text-[10px] text-zinc-500 mt-1">
                    Upgrade to Business to unlock text-to-image.
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

        {/* Footnote */}
        <p className="mt-6 text-center text-[11px] text-zinc-400">
          You can switch modes per product on the next screen — this is just the starting point.
        </p>
      </div>
    </div>
  );
}
