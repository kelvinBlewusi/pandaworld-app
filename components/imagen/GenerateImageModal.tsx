"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { X, Wand2, Loader2, Sparkles, AlertCircle, ImagePlus, Check } from "lucide-react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/**
 * Generate-from-text image modal — Business-tier-only.
 *
 * The seller types a description ("matte black leather wallet,
 * 4-card slot, studio lighting"). We hit /api/generate-product-image
 * → Imagen 3 returns a studio shot → seller previews, accepts/rejects.
 * Approved images get appended to listing.images automatically by
 * the API route.
 *
 * Tier gating + quota are enforced server-side. This component just
 * surfaces the resulting errors cleanly.
 */

interface Props {
  listingId: string;
  /** Called once a generated image has been appended to the listing. */
  onApplied: () => void;
  /** Close (with or without applying). */
  onClose: () => void;
}

type AspectRatio = "1:1" | "3:4" | "4:3";

const ASPECT_LABELS: Record<AspectRatio, string> = {
  "1:1": "Square (recommended for Jumia)",
  "3:4": "Portrait",
  "4:3": "Landscape",
};

const PROMPT_HINTS = [
  "A matte black leather wallet, 4-card slot, studio lighting",
  "Red ceramic teapot with bamboo handle, top-down view",
  "Wireless earbuds in a transparent charging case, side view",
  "Wooden cutting board with stainless steel handle, isometric angle",
];

export function GenerateImageModal({ listingId, onApplied, onClose }: Props) {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [aspect, setAspect] = useState<AspectRatio>("1:1");
  const [generating, setGenerating] = useState(false);
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const [appended, setAppended] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleGenerate() {
    if (prompt.trim().length < 5) {
      setError("Type at least a few words describing the product.");
      return;
    }
    setError(null);
    setGenerating(true);
    setGeneratedUrl(null);
    setAppended(false);

    try {
      const res = await fetch("/api/generate-product-image", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          listingId,
          prompt:      prompt.trim(),
          aspectRatio: aspect,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `Generation failed (HTTP ${res.status})`);
        return;
      }
      setGeneratedUrl(data.url ?? null);
      setAppended(Boolean(data.appended));
      if (data.appended) {
        // The image was already appended to the listing on the server;
        // refresh the parent so the gallery picks it up.
        router.refresh();
        onApplied();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error — try again.");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 backdrop-blur-sm overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="my-10 w-full max-w-2xl rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between border-b px-6 py-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white shadow-sm">
              <Wand2 className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-zinc-900">
                Generate a product photo
              </h2>
              <p className="text-xs text-zinc-500 mt-0.5">
                Imagen 3 — Business plan · no source photo needed
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-5">
          {/* Prompt input */}
          <div className="space-y-2">
            <Label htmlFor="imagen-prompt" className="text-xs font-semibold text-zinc-700">
              Describe the product
            </Label>
            <Textarea
              id="imagen-prompt"
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              maxLength={500}
              placeholder="A matte black leather wallet, 4-card slot, studio lighting…"
              className="text-sm"
              disabled={generating}
            />
            <p className="text-[10px] text-zinc-400">
              {prompt.length} / 500 characters. Mention the colour, material, angle, and any details you want visible.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {PROMPT_HINTS.map((h) => (
                <button
                  key={h}
                  type="button"
                  onClick={() => setPrompt(h)}
                  className="rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-0.5 text-[10px] text-zinc-600 hover:bg-zinc-100"
                  disabled={generating}
                >
                  {h.slice(0, 40)}…
                </button>
              ))}
            </div>
          </div>

          {/* Aspect ratio */}
          <div className="space-y-2">
            <Label className="text-xs font-semibold text-zinc-700">Aspect ratio</Label>
            <div className="flex gap-2">
              {(["1:1", "3:4", "4:3"] as AspectRatio[]).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setAspect(r)}
                  disabled={generating}
                  className={cn(
                    "flex-1 rounded-lg border px-3 py-2 text-xs transition-colors",
                    aspect === r
                      ? "border-violet-500 bg-violet-50 text-violet-700 font-semibold"
                      : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50",
                  )}
                >
                  <span className="block text-sm font-mono">{r}</span>
                  <span className="text-[10px] text-zinc-400">{ASPECT_LABELS[r]}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Generated preview / error */}
          {generating && (
            <div className="flex items-center justify-center rounded-xl border-2 border-dashed border-zinc-200 bg-zinc-50/60 py-12">
              <div className="flex flex-col items-center gap-2 text-zinc-500">
                <Loader2 className="h-6 w-6 animate-spin text-violet-500" />
                <p className="text-xs">Generating with Imagen 3… (4–10 seconds)</p>
              </div>
            </div>
          )}

          {!generating && generatedUrl && (
            <div className="space-y-2">
              <Label className="text-xs font-semibold text-zinc-700 flex items-center gap-1.5">
                {appended ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-emerald-500" />
                    Added to your listing
                  </>
                ) : (
                  <>
                    <Sparkles className="h-3.5 w-3.5 text-violet-500" />
                    Generated
                  </>
                )}
              </Label>
              <div className="relative aspect-square w-full max-w-xs overflow-hidden rounded-xl border bg-zinc-50">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <Image
                  src={generatedUrl}
                  alt="Generated product"
                  width={400}
                  height={400}
                  className="object-contain"
                  unoptimized
                />
              </div>
              {!appended && (
                <p className="text-[11px] text-amber-600">
                  Image generated but couldn&apos;t be auto-added to the listing.
                  Copy the URL and add it manually, or try generating again.
                </p>
              )}
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <p>{error}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 border-t bg-zinc-50/60 px-6 py-3">
          <p className="text-[10px] text-zinc-500">
            Uses 1 image polish credit from your monthly quota.
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onClose} disabled={generating}>
              {appended ? "Done" : "Close"}
            </Button>
            <Button
              size="sm"
              onClick={handleGenerate}
              disabled={generating || prompt.trim().length < 5}
              className="gap-2 bg-gradient-to-r from-violet-500 to-fuchsia-500 hover:from-violet-600 hover:to-fuchsia-600 text-white"
            >
              {generating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : appended ? (
                <ImagePlus className="h-4 w-4" />
              ) : (
                <Wand2 className="h-4 w-4" />
              )}
              {generating ? "Generating…" : appended ? "Generate another" : "Generate"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
