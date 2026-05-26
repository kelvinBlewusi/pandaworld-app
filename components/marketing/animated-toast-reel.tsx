"use client";

import { useEffect, useState } from "react";
import {
  Sparkles,
  Wand2,
  FolderTree,
  ListChecks,
  Rocket,
  Check,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Animated toast reel — drops into the landing hero in place of a static
 * value-prop paragraph. Cycles through a sequence of macOS-style
 * notifications, each calling out one thing PandaWorld does for the
 * seller. Loops indefinitely.
 *
 * Same visual language as components/ui/notification-toast.tsx (the
 * one used for real billing toasts) — keeps the brand consistent
 * between marketing site and in-app UI.
 *
 * No animation library — pure CSS transitions driven by a single
 * React state interval. Keeps the marketing bundle small (we don't
 * already ship framer-motion or similar).
 *
 * Behaviour:
 *   - Each toast shows for ~3s
 *   - Slides up + fades out on exit, slides in + fades on entry
 *   - One "ghost" card peeks out behind for that stacked-notifications
 *     feel from the screenshot the user pasted
 *   - Pauses cycling when the user hovers (gives them time to read)
 */

interface ReelToast {
  /** Lucide icon rendered inside the colored chip on the left. */
  icon: LucideIcon;
  /** Tailwind classes for the chip background gradient. */
  chipClass: string;
  /** Color of the dot indicator under the chip. */
  accentClass: string;
  /** Bold first line — the headline. */
  title: string;
  /** Subtler second line — short explanation. */
  body: string;
}

// Six toasts that together tell the value-prop story. Order matters —
// they should narrate the flow a seller experiences: upload → AI →
// category → attributes → publish → time saved.
const TOASTS: ReelToast[] = [
  {
    icon:        Sparkles,
    chipClass:   "bg-gradient-to-br from-sky-400 to-blue-500",
    accentClass: "bg-blue-500",
    title:       "Skip manual uploads",
    body:        "No more typing the same product details over and over.",
  },
  {
    icon:        Wand2,
    chipClass:   "bg-gradient-to-br from-purple-500 to-fuchsia-500",
    accentClass: "bg-purple-500",
    title:       "PandaworldAI writes the listing",
    body:        "Title, description, and highlights — all from one product photo.",
  },
  {
    icon:        FolderTree,
    chipClass:   "bg-gradient-to-br from-emerald-400 to-green-500",
    accentClass: "bg-emerald-500",
    title:       "Picks the right Jumia category",
    body:        "Matched against the live Jumia Ghana category tree.",
  },
  {
    icon:        ListChecks,
    chipClass:   "bg-gradient-to-br from-amber-400 to-orange-500",
    accentClass: "bg-amber-500",
    title:       "Fills every required attribute",
    body:        "Brand, color, material, size — auto-detected from your images.",
  },
  {
    icon:        Rocket,
    chipClass:   "bg-gradient-to-br from-rose-400 to-red-500",
    accentClass: "bg-rose-500",
    title:       "Pushes straight to your store",
    body:        "No copy-pasting. No form-filling. One click and it's live.",
  },
  {
    icon:        Check,
    chipClass:   "bg-gradient-to-br from-zinc-700 to-zinc-900",
    accentClass: "bg-zinc-900",
    title:       "No more long hours on listings",
    body:        "What used to take an hour per product now takes 30 seconds.",
  },
];

const ROTATE_MS = 3000;

export function AnimatedToastReel() {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);

  // Reset to first slide on mount; rotate while not paused (hover).
  useEffect(() => {
    if (paused) return;
    const id = window.setInterval(() => {
      setActive((i) => (i + 1) % TOASTS.length);
    }, ROTATE_MS);
    return () => window.clearInterval(id);
  }, [paused]);

  return (
    <div
      className="relative h-[120px] w-full max-w-[420px]"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      aria-label="What PandaWorld does for you"
    >
      {/* Two ghost cards behind the active toast for that stacked-
          notifications depth from the reference screenshot. They
          don't carry content — just visual hints that more toasts
          are waiting. Translate further back as the index grows. */}
      <div
        aria-hidden
        className="absolute left-1/2 top-2 h-[88px] w-[94%] -translate-x-1/2 rounded-2xl border border-zinc-200/60 bg-white/60 shadow-sm"
      />
      <div
        aria-hidden
        className="absolute left-1/2 top-4 h-[80px] w-[88%] -translate-x-1/2 rounded-2xl border border-zinc-200/40 bg-white/40 shadow-sm"
      />

      {/* Active toast — absolutely positioned so transitions don't
          shift the layout. Each entry crossfades + slides while the
          previous one fades out. */}
      {TOASTS.map((toast, i) => {
        const isActive = i === active;
        const Icon = toast.icon;
        return (
          <div
            key={i}
            role="status"
            aria-hidden={!isActive}
            className={cn(
              "absolute inset-x-0 top-0 rounded-2xl border border-zinc-200/70 bg-white/95 px-3 py-3 shadow-xl shadow-black/5",
              "[backdrop-filter:saturate(1.5)_blur(16px)]",
              "transition-all duration-500 ease-out",
              isActive
                ? "translate-y-0 opacity-100 scale-100"
                : "pointer-events-none -translate-y-3 opacity-0 scale-95",
            )}
          >
            <div className="flex items-start gap-3">
              {/* Colored chip with the icon, mirroring the brand chip */}
              <div className="relative shrink-0">
                <div
                  className={cn(
                    "flex h-10 w-10 items-center justify-center rounded-xl text-white shadow-sm",
                    toast.chipClass,
                  )}
                >
                  <Icon className="h-5 w-5" />
                </div>
                {/* Type-indicator dot in the corner (matches notification toast) */}
                <span
                  className={cn(
                    "absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white",
                    toast.accentClass,
                  )}
                />
              </div>

              {/* Content */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                    PandaWorld
                  </span>
                  <span className="text-[10px] text-zinc-400">now</span>
                </div>
                <p className="mt-0.5 text-sm font-semibold leading-tight text-zinc-900">
                  {toast.title}
                </p>
                <p className="mt-0.5 text-xs leading-snug text-zinc-600">
                  {toast.body}
                </p>
              </div>
            </div>
          </div>
        );
      })}

      {/* Progress pips at the bottom — show which toast we're on and
          subtly preview that there's a sequence */}
      <div className="absolute -bottom-5 left-1/2 flex -translate-x-1/2 gap-1.5">
        {TOASTS.map((_, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setActive(i)}
            aria-label={`Show notification ${i + 1}`}
            className={cn(
              "h-1 rounded-full transition-all duration-300",
              i === active
                ? "w-5 bg-zinc-700"
                : "w-1.5 bg-zinc-300 hover:bg-zinc-400",
            )}
          />
        ))}
      </div>
    </div>
  );
}
