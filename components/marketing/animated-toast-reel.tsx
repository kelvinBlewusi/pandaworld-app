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
 * Layout note — IMPORTANT (was bug source):
 *   Previously rendered toasts with `absolute inset-x-0 top-0`. That
 *   removed all children from the in-flow layout so the parent
 *   collapsed to 0 width when its own parent used `items-start` (as
 *   the landing hero does). Visual result: a 1-word-wide toast with
 *   text wrapping vertically per character.
 *
 *   Fix: use CSS grid with `grid-cols-1` and place every toast in the
 *   SAME cell (`gridArea: 1 / 1 / 2 / 2`). The grid sizes itself to
 *   the largest child's intrinsic width AND height — so the
 *   container has proper dimensions regardless of the parent flex
 *   alignment. Only the active toast is visible via opacity.
 *
 * Behaviour:
 *   - Each toast shows for ~3s
 *   - Crossfade + slight scale on entry/exit
 *   - Pauses cycling when the user hovers (gives them time to read)
 *   - Progress pips at the bottom; click to jump to a specific toast
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
const STACK_CELL: React.CSSProperties = { gridArea: "1 / 1 / 2 / 2" };

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
      className="w-full max-w-[440px]"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      aria-label="What PandaWorld does for you"
    >
      {/* CSS grid stack — every toast in the same cell. The grid
          sizes itself to the largest child so the container has
          natural dimensions regardless of parent flex alignment. */}
      <div className="grid grid-cols-1">
        {TOASTS.map((toast, i) => {
          const isActive = i === active;
          const Icon = toast.icon;
          return (
            <div
              key={i}
              style={STACK_CELL}
              role="status"
              aria-hidden={!isActive}
              className={cn(
                "rounded-2xl border border-zinc-200/70 bg-white/95 px-4 py-3.5 shadow-xl shadow-black/5",
                "[backdrop-filter:saturate(1.5)_blur(16px)]",
                "transition-all duration-500 ease-out",
                isActive
                  ? "opacity-100 scale-100"
                  : "pointer-events-none opacity-0 scale-95",
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
      </div>

      {/* Progress pips — sit below the toast (no longer absolute-
          positioned, no overlap with the CTAs below). Clickable to
          jump to a specific toast. */}
      <div className="mt-3 flex gap-1.5">
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
