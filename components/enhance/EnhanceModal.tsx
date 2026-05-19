"use client";

/**
 * EnhanceModal — before/after preview for Gemini image enhancement.
 *
 * Opens from the Polish / Rebuild buttons on either the batch upload page
 * or the review page. Calls /api/enhance-images, then renders a grid of
 * original vs enhanced pairs. Per-image toggle decides which version
 * lands in listings.images on Apply.
 *
 * State machine:
 *   - idle:        modal just opened; show "Run enhancement" prompt
 *   - running:     fetch /api/enhance-images, show progress
 *   - reviewing:   results back; show before/after grid + per-image toggles
 *   - applying:    saving the seller's selection to listings.images
 *   - error:       something failed; show retry
 */

import { useState, useCallback } from "react";
import {
  Loader2,
  Sparkles,
  Check,
  X as XIcon,
  AlertCircle,
  RefreshCw,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type EnhanceMode = "polish" | "rebuild";

interface EnhanceResult {
  originalUrl: string;
  enhancedUrl: string;
  error?:      string;
}

interface EnhanceModalProps {
  open:        boolean;
  onClose:     () => void;
  /** Which enhancement to apply on Run. Picked by the calling button. */
  mode:        EnhanceMode;
  /** Listing whose images we're enhancing. */
  listingId:   string;
  /**
   * Called when the seller hits Apply with the final picked URLs (in
   * original order). The parent decides how to persist — typically a
   * PATCH /api/listings/[id] with the new images array.
   */
  onApply:     (chosenUrls: string[]) => Promise<void> | void;
}

export function EnhanceModal({
  open,
  onClose,
  mode,
  listingId,
  onApply,
}: EnhanceModalProps) {
  const [phase, setPhase]       = useState<"idle" | "running" | "reviewing" | "applying" | "error">("idle");
  const [results, setResults]   = useState<EnhanceResult[]>([]);
  // Per-image: true → use enhanced; false → keep original. Defaults to
  // true for every image that came back without an error.
  const [accept, setAccept]     = useState<Record<number, boolean>>({});
  const [error, setError]       = useState<string | null>(null);

  // Reset state whenever the modal opens with fresh inputs. Without this
  // a second open after a successful run shows stale results.
  const reset = useCallback(() => {
    setPhase("idle");
    setResults([]);
    setAccept({});
    setError(null);
  }, []);

  const runEnhancement = useCallback(async () => {
    setPhase("running");
    setError(null);
    try {
      const res = await fetch("/api/enhance-images", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ listingId, mode }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? "Enhancement failed");
      }
      const enhanced = (data.enhanced ?? []) as EnhanceResult[];
      setResults(enhanced);
      // Default: accept every enhancement that came back without an error.
      // Failed slots default to "keep original" so the seller isn't asked
      // to choose between two identical URLs.
      const initialAccept: Record<number, boolean> = {};
      enhanced.forEach((r, i) => {
        initialAccept[i] = !r.error && r.enhancedUrl !== r.originalUrl;
      });
      setAccept(initialAccept);
      setPhase("reviewing");
    } catch (e) {
      setError((e as Error).message);
      setPhase("error");
    }
  }, [listingId, mode]);

  const handleApply = useCallback(async () => {
    setPhase("applying");
    try {
      const chosen = results.map((r, i) => (accept[i] ? r.enhancedUrl : r.originalUrl));
      await onApply(chosen);
      reset();
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setPhase("error");
    }
  }, [results, accept, onApply, onClose, reset]);

  const acceptedCount = Object.values(accept).filter(Boolean).length;
  const totalCount    = results.length;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-orange-500" />
            {mode === "polish" ? "Polish images" : "Rebuild as studio shot"}
          </DialogTitle>
          <p className="text-xs text-zinc-500 mt-1">
            {mode === "polish"
              ? "Cleans up backgrounds, adds a soft shadow, centres the product on white. The product itself stays exactly as it is."
              : "Re-renders the product on a fresh studio backdrop. Use this when the original shot is off-axis, badly lit, or visually unappealing."}
          </p>
        </DialogHeader>

        {/* ── Idle: invite the seller to start the run ─────────────────── */}
        {phase === "idle" && (
          <div className="py-6 text-center space-y-3">
            <p className="text-sm text-zinc-600">
              We&apos;ll run Gemini on every image on this listing. Originals
              are kept — you can pick which version to use, per image,
              before applying.
            </p>
            <Button
              onClick={runEnhancement}
              className="bg-orange-500 hover:bg-orange-600 text-white gap-2"
            >
              <Sparkles className="h-4 w-4" />
              {mode === "polish" ? "Polish all images" : "Rebuild all images"}
            </Button>
            <p className="text-[10px] text-zinc-400">
              This takes 3-8 seconds per image. AI can make mistakes — review the results before applying.
            </p>
          </div>
        )}

        {/* ── Running: show a small loader ───────────────────────────── */}
        {phase === "running" && (
          <div className="py-10 text-center space-y-3">
            <Loader2 className="h-6 w-6 animate-spin mx-auto text-orange-500" />
            <p className="text-sm text-zinc-600">
              {mode === "polish" ? "Polishing your images…" : "Rebuilding your images…"}
            </p>
            <p className="text-[11px] text-zinc-400">
              Gemini is working — usually a few seconds per image.
            </p>
          </div>
        )}

        {/* ── Reviewing: before/after grid with per-image toggle ──────── */}
        {phase === "reviewing" && (
          <>
            <div className="grid gap-3 sm:grid-cols-2 max-h-[60vh] overflow-y-auto pr-1">
              {results.map((r, i) => {
                const isAccepted = accept[i];
                const failed     = Boolean(r.error);
                return (
                  <div
                    key={i}
                    className={cn(
                      "rounded-lg border p-2 transition-colors",
                      failed
                        ? "border-amber-200 bg-amber-50"
                        : isAccepted
                        ? "border-orange-300 bg-orange-50"
                        : "border-zinc-200 bg-white",
                    )}
                  >
                    <div className="grid grid-cols-2 gap-2">
                      <figure className="space-y-1">
                        <p className="text-[10px] uppercase tracking-wider text-zinc-400">Original</p>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={r.originalUrl}
                          alt={`Original ${i + 1}`}
                          className="aspect-square w-full rounded object-cover bg-zinc-50"
                        />
                      </figure>
                      <figure className="space-y-1">
                        <p className="text-[10px] uppercase tracking-wider text-zinc-400">Enhanced</p>
                        {failed ? (
                          <div className="aspect-square w-full rounded bg-amber-100 flex flex-col items-center justify-center gap-1 text-amber-700 text-[10px] text-center px-2">
                            <AlertCircle className="h-4 w-4" />
                            <span className="leading-tight">{r.error}</span>
                          </div>
                        ) : (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={r.enhancedUrl}
                            alt={`Enhanced ${i + 1}`}
                            className="aspect-square w-full rounded object-cover bg-zinc-50"
                          />
                        )}
                      </figure>
                    </div>
                    {!failed && (
                      <div className="mt-2 flex items-center justify-between text-[11px]">
                        <span className="text-zinc-500">Image {i + 1}</span>
                        <div className="flex gap-1">
                          <button
                            type="button"
                            onClick={() => setAccept((p) => ({ ...p, [i]: false }))}
                            className={cn(
                              "rounded-md px-2 py-1 transition-colors flex items-center gap-1",
                              !isAccepted
                                ? "bg-zinc-200 text-zinc-900 font-medium"
                                : "text-zinc-500 hover:bg-zinc-100",
                            )}
                          >
                            <XIcon className="h-3 w-3" /> Keep original
                          </button>
                          <button
                            type="button"
                            onClick={() => setAccept((p) => ({ ...p, [i]: true }))}
                            className={cn(
                              "rounded-md px-2 py-1 transition-colors flex items-center gap-1",
                              isAccepted
                                ? "bg-orange-500 text-white font-medium"
                                : "text-zinc-500 hover:bg-zinc-100",
                            )}
                          >
                            <Check className="h-3 w-3" /> Use enhanced
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <DialogFooter>
              <p className="text-[11px] text-zinc-500 mr-auto">
                Using {acceptedCount} of {totalCount} enhanced images
              </p>
              <Button
                variant="outline"
                onClick={runEnhancement}
                className="gap-1.5"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Re-run
              </Button>
              <Button
                onClick={handleApply}
                className="bg-orange-500 hover:bg-orange-600 text-white"
              >
                Apply changes
              </Button>
            </DialogFooter>
          </>
        )}

        {/* ── Applying ────────────────────────────────────────────────── */}
        {phase === "applying" && (
          <div className="py-10 text-center space-y-3">
            <Loader2 className="h-6 w-6 animate-spin mx-auto text-orange-500" />
            <p className="text-sm text-zinc-600">Updating your listing…</p>
          </div>
        )}

        {/* ── Error ───────────────────────────────────────────────────── */}
        {phase === "error" && (
          <div className="py-6 text-center space-y-3">
            <div className="flex items-center justify-center gap-2 text-red-600">
              <AlertCircle className="h-5 w-5" />
              <p className="text-sm font-medium">Something went wrong</p>
            </div>
            <p className="text-xs text-zinc-500 max-w-md mx-auto">
              {error ?? "Unknown error"}
            </p>
            <Button onClick={runEnhancement} variant="outline" className="gap-1.5">
              <RefreshCw className="h-3.5 w-3.5" />
              Try again
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
