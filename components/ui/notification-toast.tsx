"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * macOS-style notification toast.
 *
 * Modelled on the native macOS Notification Center banners — clean
 * white card with the app icon on the left, app name + relative
 * timestamp on the top right, and a title + body underneath.
 *
 * Also plays a short two-note chime via the Web Audio API on mount so
 * the seller hears the toast even if they're not looking at the screen
 * (e.g. waiting for Paystack redirect after a MoMo PIN entry on phone).
 * Success and error chimes use different pitch patterns so the seller
 * can tell them apart by ear alone.
 *
 * Usage:
 *   const [toast, setToast] = useState<ToastInput | null>(null);
 *   …
 *   {toast && <NotificationToast toast={toast} onClose={() => setToast(null)} />}
 */

export type ToastType = "success" | "error" | "info";

export interface ToastInput {
  type:     ToastType;
  title:    string;
  message?: string;
  /** Auto-dismiss after this many ms. Default 5000. Pass 0 to disable. */
  duration?: number;
}

// ─── Web Audio chime ────────────────────────────────────────────────────────

/**
 * Generate a short two-note "ding" sound on the fly. No audio asset
 * needed — keeps the bundle small and works offline.
 *
 * Success: 800Hz → 1000Hz (rising — feels positive)
 * Error:   600Hz → 400Hz  (falling — feels alerting)
 * Info:    700Hz only      (single neutral note)
 *
 * Wrapped in try/catch so a missing AudioContext (rare, old browsers)
 * doesn't break the toast rendering.
 */
function playChime(type: ToastType): void {
  try {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;

    const ctx = new Ctor();
    // Resume in case the context starts suspended (common on some
    // browsers when no prior user interaction has occurred).
    if (ctx.state === "suspended") {
      void ctx.resume();
    }

    const notes =
      type === "success" ? [880, 1175]      // A5 → D6   (rising fifth)
        : type === "error"  ? [659, 466]    // E5 → A#4  (falling tritone)
          : [700];                          // info: single tone

    notes.forEach((freq, i) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(ctx.destination);

      const start = ctx.currentTime + i * 0.09;   // 90ms between notes
      const peakVol = 0.18;                       // gentle, not jarring
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(peakVol, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);

      osc.start(start);
      osc.stop(start + 0.2);
    });

    // Close the context after the chime finishes so we don't leak
    // an open AudioContext per toast.
    window.setTimeout(() => void ctx.close().catch(() => {}), 500);
  } catch {
    // Web Audio unavailable — silent fallback, toast still renders.
  }
}

// ─── Component ──────────────────────────────────────────────────────────────

interface Props {
  toast: ToastInput;
  onClose: () => void;
}

export function NotificationToast({ toast, onClose }: Props) {
  const [visible, setVisible] = useState(false);

  // Play chime + slide-in on mount. The visible flag drives the CSS
  // transition so the card slides + fades in cleanly (matches macOS).
  useEffect(() => {
    playChime(toast.type);
    // Next-frame trigger so the transition fires (browser sees the
    // "hidden → visible" state change as an animatable transition).
    const raf = requestAnimationFrame(() => setVisible(true));

    const duration = toast.duration ?? 5000;
    if (duration > 0) {
      const timer = window.setTimeout(() => onClose(), duration);
      return () => {
        cancelAnimationFrame(raf);
        window.clearTimeout(timer);
      };
    }
    return () => cancelAnimationFrame(raf);
  }, [toast, onClose]);

  // Tiny coloured dot in the corner of the app icon to indicate
  // success/error at a glance — keeps the macOS-style clean card
  // intact while still conveying the toast type.
  const accent =
    toast.type === "success"
      ? "bg-emerald-500"
      : toast.type === "error"
        ? "bg-red-500"
        : "bg-blue-500";

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "fixed top-4 right-4 z-[60] w-[360px] max-w-[calc(100vw-2rem)]",
        "rounded-2xl border border-zinc-200/70 bg-white/95 px-3 py-3 shadow-2xl shadow-black/10",
        // Slight glass effect — matches macOS Big Sur+ notification look
        "[backdrop-filter:saturate(1.5)_blur(16px)]",
        "transition-all duration-300 ease-out",
        visible
          ? "translate-y-0 opacity-100 scale-100"
          : "-translate-y-2 opacity-0 scale-95",
      )}
    >
      <div className="flex items-start gap-3">
        {/* App icon — gradient panda square matches the sidebar brand chip */}
        <div className="relative shrink-0">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 text-base shadow-sm">
            🐼
          </div>
          {/* Type-indicator dot in the corner */}
          <span
            className={cn(
              "absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white",
              accent,
            )}
          />
        </div>

        {/* Content column */}
        <div className="min-w-0 flex-1">
          {/* App name + relative timestamp (macOS shows "now", "1m ago"…) */}
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
              PandaWorld
            </span>
            <span className="text-[10px] text-zinc-400">now</span>
          </div>

          <p className="mt-0.5 text-sm font-semibold leading-tight text-zinc-900">
            {toast.title}
          </p>
          {toast.message && (
            <p className="mt-0.5 text-xs leading-snug text-zinc-600">
              {toast.message}
            </p>
          )}
        </div>

        {/* Close X — subtle, only shows on hover (matches macOS behaviour) */}
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-md p-0.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
          aria-label="Dismiss notification"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
