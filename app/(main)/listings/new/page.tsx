"use client";

import { useState, useCallback, useRef, Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  ImageIcon,
  Wand2,
  Link2,
  Upload,
  ArrowRight,
  ArrowLeft,
  Check,
  Plus,
  X,
  Sparkles,
  ChevronRight,
  Loader2,
  AlertCircle,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Stepper } from "@/components/ui/stepper";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

type WizardMode = "own" | "ai" | "url";

interface MockFile {
  id: string;
  name: string;
  preview: string;
  file: File;
}

interface ProductDraft {
  id: string;
  files: MockFile[];
  description: string;
}

interface UrlEntry {
  id: string;
  value: string;
}

interface ProcessResult {
  listingId:     string;
  title:         string | null;
  category:      string | null;
  brand:         string | null;
  color:         string | null;
  weight_kg:     number | null;
  selling_price: number | null;
  sourceUrl?:    string;
  imagesFound?:  number;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function CountPicker({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (n: number) => void;
}) {
  return (
    <div className="grid grid-cols-5 gap-2">
      {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
        <button
          key={n}
          onClick={() => onChange(n)}
          className={cn(
            "flex h-12 items-center justify-center rounded-xl border-2 text-base font-bold transition-all duration-150",
            value === n
              ? "border-blue-500 bg-blue-50 text-blue-600 shadow-sm"
              : "border-zinc-200 text-zinc-500 hover:border-zinc-300 hover:bg-zinc-50"
          )}
        >
          {n}
        </button>
      ))}
    </div>
  );
}

function ProductProgress({
  total,
  current,
}: {
  total: number;
  current: number;
}) {
  return (
    <div className="flex items-center gap-1.5">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={cn(
            "h-2 rounded-full transition-all duration-200",
            i < current
              ? "w-4 bg-emerald-400"
              : i === current
              ? "w-6 bg-blue-500"
              : "w-2 bg-zinc-200"
          )}
        />
      ))}
      <span className="ml-1.5 text-xs text-zinc-400">
        {current + 1} of {total}
      </span>
    </div>
  );
}

function CompactDropzone({
  files,
  maxFiles,
  onFilesChange,
  label,
}: {
  files: MockFile[];
  maxFiles: number;
  onFilesChange: (f: MockFile[]) => void;
  label?: string;
}) {
  const [isDragging, setIsDragging] = useState(false);

  const addFiles = useCallback(
    (fileList: FileList) => {
      const added: MockFile[] = Array.from(fileList)
        .slice(0, maxFiles - files.length)
        .map((f) => ({
          id: Math.random().toString(36).slice(2),
          name: f.name,
          preview: URL.createObjectURL(f),
          file: f,
        }));
      onFilesChange([...files, ...added]);
    },
    [files, maxFiles, onFilesChange]
  );

  const remove = (id: string) =>
    onFilesChange(files.filter((f) => f.id !== id));

  if (files.length === 0) {
    return (
      <label
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-6 text-center transition-all",
          isDragging
            ? "border-blue-400 bg-blue-50"
            : "border-zinc-200 bg-zinc-50/60 hover:border-zinc-300 hover:bg-zinc-50"
        )}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
        }}
      >
        <input
          type="file"
          accept="image/*"
          multiple={maxFiles > 1}
          className="sr-only"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
          }}
        />
        <div
          className={cn(
            "rounded-full p-2.5 transition-colors",
            isDragging ? "bg-blue-100 text-blue-500" : "bg-zinc-100 text-zinc-400"
          )}
        >
          <Upload className="h-5 w-5" />
        </div>
        <div>
          <p className="text-sm font-medium text-zinc-600">
            {label ?? "Drop photos here or click to browse"}
          </p>
          <p className="mt-0.5 text-xs text-zinc-400">
            JPG · PNG · WEBP · up to 10 MB each
            {maxFiles > 1 ? ` · max ${maxFiles} images` : ""}
          </p>
        </div>
      </label>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      {files.map((f) => (
        <div
          key={f.id}
          className="group relative h-16 w-16 overflow-hidden rounded-lg border bg-zinc-50"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={f.preview} alt={f.name} className="h-full w-full object-cover" />
          <button
            onClick={() => remove(f.id)}
            className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100"
          >
            <X className="h-4 w-4 text-white" />
          </button>
        </div>
      ))}
      {files.length < maxFiles && (
        <label className="flex h-16 w-16 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-zinc-200 text-zinc-400 transition-colors hover:border-zinc-300">
          <input
            type="file"
            accept="image/*"
            multiple={maxFiles > 1}
            className="sr-only"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
            }}
          />
          <Plus className="h-4 w-4" />
          <span className="text-[10px] font-medium">Add</span>
        </label>
      )}
    </div>
  );
}

// ─── URL Import Populate Step ─────────────────────────────────────────────────
//
// Processes a list of URLs one by one.
// The first URL creates a listing and redirects to its review page.
// Remaining URLs are queued — user can process them later.

function UrlImportStep({ urls }: { urls: string[] }) {
  const router = useRouter();
  const calledRef = useRef(false);

  const [status, setStatus]   = useState<"processing" | "done" | "error">("processing");
  const [result, setResult]   = useState<ProcessResult | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [phase, setPhase]     = useState<"scraping" | "analysing" | "saving">("scraping");

  const totalUrls = urls.length;

  useEffect(() => {
    if (calledRef.current) return;
    calledRef.current = true;

    async function run() {
      const url = urls[0];
      if (!url) {
        setError("No URL provided.");
        setStatus("error");
        return;
      }

      try {
        setPhase("scraping");

        const formData = new FormData();
        formData.append("mode", "url");
        formData.append("url", url);

        // Small delay to show the scraping phase label
        await new Promise((r) => setTimeout(r, 400));
        setPhase("analysing");

        const res = await fetch("/api/process-listing", {
          method: "POST",
          body: formData,
        });

        setPhase("saving");

        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: "Unknown error" }));
          throw new Error(body.error ?? "Processing failed");
        }

        const data: ProcessResult = await res.json();
        setResult(data);
        setStatus("done");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Processing failed");
        setStatus("error");
      }
    }

    run();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const phaseLabels: Record<typeof phase, string> = {
    scraping:  "Scraping product page…",
    analysing: "AI is analysing the product…",
    saving:    "Saving listing…",
  };

  const phaseSteps = [
    { label: "Fetching product page",         key: "scraping"  },
    { label: "Downloading product images",    key: "scraping"  },
    { label: "Gemini Vision analysis",        key: "analysing" },
    { label: "Matching Jumia GH category",    key: "analysing" },
    { label: "Populating all listing fields", key: "saving"    },
  ];

  const currentPhaseIdx = ["scraping", "analysing", "saving"].indexOf(phase);

  // ── Processing ──────────────────────────────────────────────────────────────
  if (status === "processing") {
    return (
      <div className="space-y-5">
        <div className="rounded-2xl border bg-gradient-to-br from-emerald-50 to-teal-50 p-6">
          <div className="mb-5 flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-100">
              <Loader2 className="h-4 w-4 animate-spin text-emerald-600" />
            </div>
            <div>
              <p className="text-sm font-semibold text-zinc-800">
                {phaseLabels[phase]}
              </p>
              <p className="text-xs text-zinc-500">
                {totalUrls > 1
                  ? `Processing URL 1 of ${totalUrls}`
                  : "Processing product URL"}
              </p>
            </div>
          </div>
          <div className="space-y-2.5">
            {phaseSteps.map(({ label, key }, idx) => {
              const stepPhaseIdx = ["scraping", "scraping", "analysing", "analysing", "saving"].indexOf(key);
              const isDone    = stepPhaseIdx < currentPhaseIdx;
              const isActive  = stepPhaseIdx === currentPhaseIdx;
              return (
                <div key={label} className="flex items-center gap-2.5 text-xs text-zinc-500">
                  {isDone ? (
                    <Check className="h-3 w-3 text-emerald-500 shrink-0" />
                  ) : (
                    <div
                      className={cn(
                        "h-1.5 w-1.5 rounded-full shrink-0",
                        isActive ? "bg-emerald-400 animate-pulse" : "bg-zinc-200"
                      )}
                      style={{ animationDelay: `${idx * 0.2}s` }}
                    />
                  )}
                  <span className={isDone ? "text-zinc-400 line-through" : isActive ? "text-zinc-700 font-medium" : ""}>
                    {label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        <p className="text-center text-xs text-zinc-400">
          Do not close this page while processing…
        </p>
      </div>
    );
  }

  // ── Error ───────────────────────────────────────────────────────────────────
  if (status === "error") {
    return (
      <div className="space-y-5">
        <div className="rounded-2xl border border-red-200 bg-red-50 p-5">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 shrink-0 mt-0.5 text-red-500" />
            <div>
              <p className="text-sm font-semibold text-red-700">Import failed</p>
              <p className="mt-1 text-xs text-red-500">{error}</p>
              <p className="mt-2 text-xs text-zinc-500">
                Make sure the URL is a publicly accessible product page. Some sites
                block automated access.
              </p>
            </div>
          </div>
        </div>
        <div className="flex gap-3">
          <Button
            variant="outline"
            className="flex-1"
            onClick={() => router.push("/listings/new?mode=url")}
          >
            Try a different URL
          </Button>
          <Button
            className="flex-1"
            onClick={() => {
              calledRef.current = false;
              setStatus("processing");
              setError(null);
              setPhase("scraping");
            }}
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }

  // ── Done ────────────────────────────────────────────────────────────────────
  const fields = [
    { label: "Product name",  value: result?.title         ?? "—" },
    { label: "Category",      value: result?.category      ?? "—" },
    { label: "Brand",         value: result?.brand         ?? "—" },
    { label: "Color",         value: result?.color         ?? "—" },
    { label: "Images saved",  value: result?.imagesFound != null ? `${result.imagesFound} image${result.imagesFound === 1 ? "" : "s"}` : "—" },
    {
      label: "Selling price",
      value: result?.selling_price != null
        ? `GHS ${result.selling_price.toLocaleString()}`
        : "—",
    },
  ];

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border bg-gradient-to-br from-emerald-50 to-teal-50 p-5">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-100">
            <Check className="h-4 w-4 text-emerald-600" />
          </div>
          <div>
            <p className="text-sm font-semibold text-zinc-800">
              Listing populated from URL
            </p>
            <p className="text-xs text-zinc-500">
              AI has filled all available fields — review before publishing
            </p>
          </div>
        </div>

        {result?.sourceUrl && (
          <a
            href={result.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mb-3 flex items-center gap-1.5 truncate text-[11px] text-emerald-600 hover:underline"
          >
            <ExternalLink className="h-3 w-3 shrink-0" />
            {result.sourceUrl}
          </a>
        )}

        <div className="space-y-1.5">
          {fields.map(({ label, value }) => (
            <div
              key={label}
              className="flex items-center justify-between rounded-lg bg-white px-3 py-2 text-xs shadow-sm"
            >
              <span className="text-zinc-500">{label}</span>
              <span className="font-medium text-zinc-800 truncate max-w-[180px]">
                {value}
              </span>
            </div>
          ))}
        </div>
      </div>

      {totalUrls > 1 && (
        <p className="rounded-xl border bg-amber-50 px-4 py-2.5 text-xs text-amber-700">
          Processed 1 of {totalUrls} URLs. The remaining {totalUrls - 1} can be
          imported individually from the New Listing page.
        </p>
      )}

      <div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-xs text-blue-700">
        <strong>Next:</strong> Review the full Jumia listing form — edit any field,
        set pricing, add variants, then publish.
      </div>

      <div className="flex gap-3">
        <Button
          variant="outline"
          className="flex-1"
          onClick={() => router.push("/listings")}
        >
          View drafts
        </Button>
        <Button
          className="flex-1 gap-2 bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700"
          onClick={() => router.push(`/listings/${result!.listingId}/review`)}
        >
          <Sparkles className="h-4 w-4" />
          Review & publish
        </Button>
      </div>
    </div>
  );
}

// ─── Own/AI Populate Step ─────────────────────────────────────────────────────

function PopulateStep({
  mode,
  products,
  totalProducts,
}: {
  mode: WizardMode;
  products: ProductDraft[];
  totalProducts: number;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<"processing" | "done" | "error">(
    "processing"
  );
  const [result, setResult] = useState<ProcessResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const calledRef = useRef(false);

  useEffect(() => {
    if (calledRef.current) return;
    calledRef.current = true;

    async function run() {
      try {
        const product = products[0];
        if (!product) throw new Error("No product data found.");

        const formData = new FormData();
        formData.append("mode", mode);

        if (
          mode === "ai" &&
          product.files.length === 0 &&
          product.description.trim()
        ) {
          formData.append("description", product.description);
        } else if (product.files.length > 0) {
          product.files.forEach((f) => formData.append("files", f.file));
        } else {
          throw new Error(
            "No images or description provided. Please go back and add your product."
          );
        }

        const res = await fetch("/api/process-listing", {
          method: "POST",
          body: formData,
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: "Unknown error" }));
          throw new Error(body.error ?? "Processing failed");
        }

        const data: ProcessResult = await res.json();
        setResult(data);
        setStatus("done");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Processing failed");
        setStatus("error");
      }
    }

    run();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (status === "processing") {
    return (
      <div className="space-y-5">
        <div className="rounded-2xl border bg-gradient-to-br from-emerald-50 to-teal-50 p-6">
          <div className="mb-5 flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-100">
              <Loader2 className="h-4 w-4 animate-spin text-emerald-600" />
            </div>
            <div>
              <p className="text-sm font-semibold text-zinc-800">
                AI is analysing your product
              </p>
              <p className="text-xs text-zinc-500">
                Gemini Vision is reading your images — this takes ~15 seconds
              </p>
            </div>
          </div>
          <div className="space-y-2.5">
            {[
              { label: "Uploading images to storage",  delay: "0s"    },
              { label: "Gemini Vision analysis",       delay: "0.25s" },
              { label: "Matching Jumia GH category",   delay: "0.5s"  },
              { label: "Populating listing fields",    delay: "0.75s" },
            ].map(({ label, delay }) => (
              <div key={label} className="flex items-center gap-2.5 text-xs text-zinc-500">
                <div
                  className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse"
                  style={{ animationDelay: delay }}
                />
                {label}
              </div>
            ))}
          </div>
        </div>
        <p className="text-center text-xs text-zinc-400">
          Do not close this page while processing…
        </p>
      </div>
    );
  }

  if (status === "error") {
    const isLimitError = error?.includes("FREE_LIMIT_REACHED");
    return (
      <div className="space-y-5">
        <div
          className={`rounded-2xl border p-5 ${
            isLimitError
              ? "border-amber-200 bg-amber-50"
              : "border-red-200 bg-red-50"
          }`}
        >
          <div className="flex items-start gap-3">
            <AlertCircle
              className={`h-5 w-5 shrink-0 mt-0.5 ${
                isLimitError ? "text-amber-500" : "text-red-500"
              }`}
            />
            <div>
              <p className={`text-sm font-semibold ${isLimitError ? "text-amber-800" : "text-red-700"}`}>
                {isLimitError ? "Free trial limit reached" : "Processing failed"}
              </p>
              <p className={`mt-1 text-xs ${isLimitError ? "text-amber-600" : "text-red-500"}`}>
                {isLimitError
                  ? "You've used all 5 free uploads. Upgrade to Pro for unlimited listings."
                  : error}
              </p>
            </div>
          </div>
        </div>
        {isLimitError && (
          <Button
            className="w-full bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700"
            onClick={() => router.push("/settings/billing")}
          >
            Upgrade to Pro — GHS 50/mo
          </Button>
        )}
        <div className="flex gap-3">
          <Button variant="outline" className="flex-1" onClick={() => router.push("/listings/new")}>
            Start over
          </Button>
          <Button
            className="flex-1"
            onClick={() => {
              calledRef.current = false;
              setStatus("processing");
              setError(null);
            }}
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }

  const fields = [
    { label: "Product name",  value: result?.title         ?? "—" },
    { label: "Category path", value: result?.category      ?? "—" },
    { label: "Brand",         value: result?.brand         ?? "—" },
    { label: "Color",         value: result?.color         ?? "—" },
    { label: "Weight",        value: result?.weight_kg != null ? `${result.weight_kg} kg` : "—" },
    { label: "Selling price", value: result?.selling_price != null ? `GHS ${result.selling_price.toLocaleString()}` : "—" },
  ];

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border bg-gradient-to-br from-emerald-50 to-teal-50 p-5">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-100">
            <Check className="h-4 w-4 text-emerald-600" />
          </div>
          <div>
            <p className="text-sm font-semibold text-zinc-800">Listing fields populated</p>
            <p className="text-xs text-zinc-500">
              AI has filled in all available fields — review before publishing
            </p>
          </div>
        </div>
        <div className="space-y-1.5">
          {fields.map(({ label, value }) => (
            <div
              key={label}
              className="flex items-center justify-between rounded-lg bg-white px-3 py-2 text-xs shadow-sm"
            >
              <span className="text-zinc-500">{label}</span>
              <span className="font-medium text-zinc-800 truncate max-w-[180px]">{value}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-xs text-blue-700">
        <strong>Next:</strong> Review the full Jumia listing form — edit any
        field, set pricing, add variants and specifications, then publish.
      </div>

      {totalProducts > 1 && (
        <p className="rounded-xl border bg-amber-50 px-4 py-2.5 text-xs text-amber-700">
          Processed 1 of {totalProducts} products. The remaining{" "}
          {totalProducts - 1} can be created individually from your listings page.
        </p>
      )}

      <div className="flex gap-3">
        <Button variant="outline" className="flex-1" onClick={() => router.push("/listings")}>
          View drafts
        </Button>
        <Button
          className="flex-1 gap-2 bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700"
          onClick={() => router.push(`/listings/${result!.listingId}/review`)}
        >
          <Sparkles className="h-4 w-4" />
          Review & publish
        </Button>
      </div>
    </div>
  );
}

// ─── Processing step content ──────────────────────────────────────────────────

function getProcessingSteps(mode: WizardMode) {
  if (mode === "url") {
    return [{ id: 1, label: "Import" }];
  }
  if (mode === "ai") {
    return [
      { id: 1, label: "Enhance" },
      { id: 2, label: "Detect" },
      { id: 3, label: "Populate" },
    ];
  }
  // own
  return [
    { id: 1, label: "Detect" },
    { id: 2, label: "Populate" },
  ];
}

type StepName = "enhance" | "detect" | "populate" | "url-import";

function resolveStepName(
  step: number,
  mode: WizardMode
): StepName {
  if (mode === "url")  return "url-import";
  if (mode === "ai") {
    if (step === 1) return "enhance";
    if (step === 2) return "detect";
    return "populate";
  }
  // own
  if (step === 1) return "detect";
  return "populate";
}

function ProcessingStepContent({
  step,
  mode,
  totalProducts,
  products,
  urlEntries,
  onNext,
}: {
  step:          number;
  mode:          WizardMode;
  totalProducts: number;
  products:      ProductDraft[];
  urlEntries:    UrlEntry[];
  onNext:        () => void;
}) {
  const resolved = resolveStepName(step, mode);

  // ── URL import ────────────────────────────────────────────────────────────
  if (resolved === "url-import") {
    const validUrls = urlEntries
      .map((u) => u.value.trim())
      .filter(Boolean);
    return <UrlImportStep urls={validUrls} />;
  }

  // ── Enhance / Generate ────────────────────────────────────────────────────
  if (resolved === "enhance") {
    return (
      <div className="space-y-5">
        <div className="rounded-2xl border bg-gradient-to-br from-blue-50 to-purple-50 p-5">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-100">
              <Sparkles className="h-4 w-4 text-blue-600" />
            </div>
            <div>
              <p className="text-sm font-semibold text-zinc-800">
                AI image enhancement {totalProducts > 1 && `— ${totalProducts} products`}
              </p>
              <p className="text-xs text-zinc-500">
                Creating professional product shots from your reference
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {["Image generation", "White-bg rendering", "Lifestyle shots"].map((feat) => (
              <div
                key={feat}
                className="flex items-center gap-1.5 rounded-lg bg-white px-2.5 py-2 text-xs text-zinc-600 shadow-sm"
              >
                <Check className="h-3 w-3 shrink-0 text-emerald-500" />
                {feat}
              </div>
            ))}
          </div>
        </div>
        <p className="text-center text-xs text-zinc-400">
          Image generation coming in a future release.
        </p>
        <Button onClick={onNext} className="w-full gap-2">
          Continue with reference image
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  // ── Category detection ────────────────────────────────────────────────────
  if (resolved === "detect") {
    return (
      <div className="space-y-5">
        <div className="rounded-2xl border bg-gradient-to-br from-amber-50 to-orange-50 p-5">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-amber-100">
              <Sparkles className="h-4 w-4 text-amber-600" />
            </div>
            <div>
              <p className="text-sm font-semibold text-zinc-800">
                AI category detection
              </p>
              <p className="text-xs text-zinc-500">
                Analysing images to find the exact Jumia category + attribute set
              </p>
            </div>
          </div>
          <div className="space-y-2">
            <div className="rounded-xl border border-amber-200 bg-white p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
                  Detection method
                </span>
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-600">
                  Real Jumia tree
                </span>
              </div>
              <p className="text-xs text-zinc-500 leading-relaxed">
                The AI matches your product against all {" "}
                <strong>50 live Jumia GH categories</strong> and their exact
                attribute schemas.
              </p>
              <p className="mt-1 text-[10px] text-zinc-400">
                You can always change the category on the Review page.
              </p>
            </div>
          </div>
        </div>
        <Button onClick={onNext} className="w-full gap-2">
          Analyse & populate fields
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  // ── Populate ──────────────────────────────────────────────────────────────
  return (
    <PopulateStep mode={mode} products={products} totalProducts={totalProducts} />
  );
}

// ─── Wizard ───────────────────────────────────────────────────────────────────

function NewListingWizard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const modeParam = searchParams.get("mode") as WizardMode | null;

  const [mode, setMode] = useState<WizardMode | null>(
    ["own", "ai", "url"].includes(modeParam ?? "") ? modeParam : null
  );

  // Sync mode with URL so switching methods from sidebar always works
  useEffect(() => {
    const valid = ["own", "ai", "url"].includes(modeParam ?? "");
    setMode(valid ? (modeParam as WizardMode) : null);
  }, [modeParam]);

  const [productCount, setProductCount]       = useState<number | null>(null);
  const [currentProductIdx, setCurrentProductIdx] = useState(0);
  const [products, setProducts]               = useState<ProductDraft[]>([]);
  const [showStepper, setShowStepper]         = useState(false);
  const [stepperStep, setStepperStep]         = useState(1);

  // URL mode entries
  const [urlEntries, setUrlEntries] = useState<UrlEntry[]>([
    { id: "u1", value: "" },
  ]);

  const initProducts = (count: number) => {
    setProducts(
      Array.from({ length: count }, (_, i) => ({
        id: `p${i + 1}`,
        files: [],
        description: "",
      }))
    );
    setCurrentProductIdx(0);
    setProductCount(count);
  };

  const updateProduct = (idx: number, patch: Partial<ProductDraft>) =>
    setProducts((prev) =>
      prev.map((p, i) => (i === idx ? { ...p, ...patch } : p))
    );

  const currentProduct = products[currentProductIdx];

  // ── Mode selection ────────────────────────────────────────────────────────
  if (!mode) {
    const modeOptions = [
      {
        id: "own" as WizardMode,
        icon: ImageIcon,
        bg: "bg-blue-50 hover:bg-blue-100",
        border: "border-blue-200",
        iconColor: "text-blue-600",
        label: "I have my own product images",
        sub: "Upload up to 8 high-quality photos per product. AI will analyse them and auto-fill all Jumia listing fields.",
        badge: "Max 8 images",
        badgeColor: "bg-blue-100 text-blue-600",
      },
      {
        id: "ai" as WizardMode,
        icon: Wand2,
        bg: "bg-violet-50 hover:bg-violet-100",
        border: "border-violet-200",
        iconColor: "text-violet-600",
        label: "Generate images with AI",
        sub: "Upload 1 reference photo or describe your product in words — AI generates listing copy and auto-fills all fields.",
        badge: "Text or photo",
        badgeColor: "bg-violet-100 text-violet-600",
      },
      {
        id: "url" as WizardMode,
        icon: Link2,
        bg: "bg-emerald-50 hover:bg-emerald-100",
        border: "border-emerald-200",
        iconColor: "text-emerald-600",
        label: "Import from product URL",
        sub: "Paste a link from any product page. PandaWorld scrapes the title, images and description, then AI fills all Jumia fields automatically.",
        badge: "Multiple URLs",
        badgeColor: "bg-emerald-100 text-emerald-600",
      },
    ];

    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900">Create new listing</h1>
          <p className="mt-1 text-sm text-zinc-500">How would you like to get started?</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-1 md:grid-cols-3">
          {modeOptions.map(({ id, icon: Icon, bg, border, iconColor, label, sub, badge, badgeColor }) => (
            <motion.button
              key={id}
              whileHover={{ y: -2 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => {
                setMode(id);
                router.replace(`/listings/new?mode=${id}`, { scroll: false });
              }}
              className={cn(
                "group flex flex-col items-start gap-4 rounded-2xl border-2 bg-white p-6 text-left shadow-sm transition-all hover:shadow-md",
                border
              )}
            >
              <div className={cn("flex h-11 w-11 items-center justify-center rounded-xl transition-colors", bg)}>
                <Icon className={cn("h-5 w-5", iconColor)} />
              </div>
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-zinc-900">{label}</p>
                  <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", badgeColor)}>
                    {badge}
                  </span>
                </div>
                <p className="text-xs leading-relaxed text-zinc-500">{sub}</p>
              </div>
              <div className={cn("mt-auto flex items-center gap-1 text-xs font-semibold transition-colors", iconColor)}>
                Select <ChevronRight className="h-3.5 w-3.5" />
              </div>
            </motion.button>
          ))}
        </div>
      </div>
    );
  }

  // ── URL import input ──────────────────────────────────────────────────────
  if (mode === "url" && !showStepper) {
    const validUrls = urlEntries.filter((u) => u.value.trim().length > 0).length;
    return (
      <div className="space-y-6">
        <WizardHeader
          mode={mode}
          onBack={() => {
            setMode(null);
            router.replace("/listings/new", { scroll: false });
          }}
        />
        <div className="rounded-2xl border bg-white p-6 space-y-5">
          <div>
            <p className="text-base font-semibold text-zinc-900">
              Paste product URLs
            </p>
            <p className="mt-0.5 text-sm text-zinc-500">
              One URL per product — PandaWorld will scrape the title, images and
              description for each, then AI fills all Jumia fields.
            </p>
          </div>

          {/* Supported stores hint */}
          <div className="flex flex-wrap gap-2 text-[11px] text-zinc-400">
            {["Alibaba", "AliExpress", "Amazon", "Jumia", "Tonaton", "Any store"].map((s) => (
              <span
                key={s}
                className="rounded-full border border-zinc-100 bg-zinc-50 px-2 py-0.5 font-medium"
              >
                {s}
              </span>
            ))}
          </div>

          <div className="space-y-2.5">
            <AnimatePresence initial={false}>
              {urlEntries.map((entry, index) => (
                <motion.div
                  key={entry.id}
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.15 }}
                  className="flex items-center gap-2"
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-xs font-bold text-zinc-500">
                    {index + 1}
                  </span>
                  <div className="relative flex-1">
                    <Link2 className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                    <Input
                      className="pl-8"
                      placeholder={`https://www.aliexpress.com/item/product-${index + 1}.html`}
                      value={entry.value}
                      onChange={(e) =>
                        setUrlEntries((prev) =>
                          prev.map((u) =>
                            u.id === entry.id ? { ...u, value: e.target.value } : u
                          )
                        )
                      }
                    />
                  </div>
                  {urlEntries.length > 1 && (
                    <button
                      onClick={() =>
                        setUrlEntries((prev) => prev.filter((u) => u.id !== entry.id))
                      }
                      className="rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-red-50 hover:text-red-500"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </motion.div>
              ))}
            </AnimatePresence>
          </div>

          <button
            onClick={() =>
              setUrlEntries((prev) => [
                ...prev,
                { id: `u${Date.now()}`, value: "" },
              ])
            }
            className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 hover:text-emerald-700"
          >
            <Plus className="h-3.5 w-3.5" /> Add another product URL
          </button>

          <Button
            className="w-full gap-2 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white"
            disabled={validUrls === 0}
            onClick={() => setShowStepper(true)}
          >
            <Link2 className="h-4 w-4" />
            {validUrls > 0
              ? `Import ${validUrls} ${validUrls === 1 ? "product" : "products"}`
              : "Paste at least one URL to continue"}
          </Button>
        </div>
      </div>
    );
  }

  // ── Product count picker (own / ai modes) ────────────────────────────────
  if (!productCount && !showStepper) {
    return (
      <div className="space-y-6">
        <WizardHeader
          mode={mode}
          onBack={() => {
            setMode(null);
            router.replace("/listings/new", { scroll: false });
          }}
        />
        <div className="rounded-2xl border bg-white p-6 space-y-5">
          <div>
            <p className="text-base font-semibold text-zinc-900">
              How many products do you want to list?
            </p>
            <p className="mt-0.5 text-sm text-zinc-500">
              You can list 1 to 10 different products in one go.
            </p>
          </div>
          <CountPicker value={productCount} onChange={initProducts} />
          {!productCount && (
            <p className="text-center text-xs text-zinc-400">
              Select a number above to continue
            </p>
          )}
        </div>
      </div>
    );
  }

  // ── Per-product upload ────────────────────────────────────────────────────
  if (productCount && !showStepper && currentProduct) {
    const isLast = currentProductIdx === productCount - 1;
    const canProceed =
      mode === "own"
        ? currentProduct.files.length > 0
        : currentProduct.files.length > 0 ||
          currentProduct.description.trim().length > 0;

    const handleNext = () => {
      if (isLast) setShowStepper(true);
      else setCurrentProductIdx((i) => i + 1);
    };

    return (
      <div className="space-y-6">
        <WizardHeader
          mode={mode}
          onBack={() => {
            if (currentProductIdx > 0) setCurrentProductIdx((i) => i - 1);
            else {
              setProductCount(null);
              setProducts([]);
            }
          }}
        />

        <div className="rounded-2xl border bg-white p-6 space-y-5">
          <div className="flex items-center justify-between">
            <ProductProgress total={productCount} current={currentProductIdx} />
            <span className="text-xs font-semibold text-zinc-400">
              {mode === "own" ? "Max 8 images" : "1 photo or description"}
            </span>
          </div>

          <div className="border-t pt-4">
            <AnimatePresence mode="wait">
              <motion.div
                key={currentProductIdx}
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -12 }}
                transition={{ duration: 0.18 }}
                className="space-y-4"
              >
                <p className="text-base font-semibold text-zinc-900">
                  Product {currentProductIdx + 1}
                  {productCount > 1 && (
                    <span className="ml-2 text-sm font-normal text-zinc-400">
                      of {productCount}
                    </span>
                  )}
                </p>

                {mode === "own" && (
                  <div className="space-y-3">
                    <CompactDropzone
                      files={currentProduct.files}
                      maxFiles={8}
                      onFilesChange={(f) => updateProduct(currentProductIdx, { files: f })}
                      label="Drop up to 8 product photos here or click to browse"
                    />
                    {currentProduct.files.length > 0 && (
                      <p className="text-xs text-zinc-400">
                        {currentProduct.files.length}/8 images added
                        {currentProduct.files.length === 8 && " · maximum reached"}
                      </p>
                    )}
                  </div>
                )}

                {mode === "ai" && (
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <div className="h-px flex-1 bg-zinc-100" />
                        <span className="text-xs font-medium text-zinc-400">Option A — Reference photo</span>
                        <div className="h-px flex-1 bg-zinc-100" />
                      </div>
                      <CompactDropzone
                        files={currentProduct.files}
                        maxFiles={1}
                        onFilesChange={(f) => updateProduct(currentProductIdx, { files: f })}
                        label="Drop 1 reference photo (any angle)"
                      />
                    </div>

                    <div className="flex items-center gap-3">
                      <div className="h-px flex-1 bg-zinc-100" />
                      <span className="text-[11px] font-semibold text-zinc-400">OR</span>
                      <div className="h-px flex-1 bg-zinc-100" />
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <div className="h-px flex-1 bg-zinc-100" />
                        <span className="text-xs font-medium text-zinc-400">Option B — Describe your product</span>
                        <div className="h-px flex-1 bg-zinc-100" />
                      </div>
                      <Textarea
                        placeholder={`Describe Product ${currentProductIdx + 1} in detail…\n\nExample: "A black leather men's wallet with 8 card slots, a coin pocket, and gold-tone zip."`}
                        className="min-h-[120px] resize-none text-sm"
                        value={currentProduct.description}
                        onChange={(e) => updateProduct(currentProductIdx, { description: e.target.value })}
                      />
                    </div>
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          </div>

          <div className="flex flex-col gap-2 pt-1">
            <Button
              className="w-full gap-2"
              disabled={!canProceed}
              onClick={handleNext}
            >
              {isLast ? (
                <>
                  <Sparkles className="h-4 w-4" />
                  {mode === "own"
                    ? `Analyse ${productCount === 1 ? "product" : `all ${productCount} products`}`
                    : `Generate & analyse ${productCount === 1 ? "product" : `all ${productCount} products`}`}
                </>
              ) : (
                <>
                  Next — Product {currentProductIdx + 2}
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </Button>
            {!canProceed && (
              <p className="text-center text-xs text-zinc-400">
                {mode === "own"
                  ? "Upload at least 1 image to continue"
                  : "Add a reference photo or description to continue"}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Stepper ───────────────────────────────────────────────────────────────
  const totalProducts =
    mode === "url"
      ? urlEntries.filter((u) => u.value.trim()).length || 1
      : productCount ?? 1;

  const processingSteps = getProcessingSteps(mode);

  return (
    <div className="space-y-6">
      <WizardHeader mode={mode} showBack={false} />
      <div className="rounded-2xl border bg-white p-6 space-y-6">
        <div className="overflow-x-auto pb-1">
          <Stepper steps={processingSteps} currentStep={stepperStep} />
        </div>
        <div className="border-t pt-5">
          <AnimatePresence mode="wait">
            <motion.div
              key={stepperStep}
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -10 }}
              transition={{ duration: 0.15 }}
            >
              <ProcessingStepContent
                step={stepperStep}
                mode={mode}
                totalProducts={totalProducts}
                products={products}
                urlEntries={urlEntries}
                onNext={() => {
                  if (stepperStep < processingSteps.length)
                    setStepperStep((s) => s + 1);
                }}
              />
            </motion.div>
          </AnimatePresence>
          {stepperStep > 1 &&
            resolveStepName(stepperStep, mode) !== "populate" &&
            resolveStepName(stepperStep, mode) !== "url-import" && (
              <button
                onClick={() => setStepperStep((s) => s - 1)}
                className="mt-4 flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-600"
              >
                <ArrowLeft className="h-3 w-3" /> Back
              </button>
            )}
        </div>
      </div>
    </div>
  );
}

// ─── Shared header ────────────────────────────────────────────────────────────

const modeLabel: Record<WizardMode, { icon: React.ElementType; color: string; label: string }> = {
  own: { icon: ImageIcon, color: "text-blue-500",    label: "Own images"        },
  ai:  { icon: Wand2,     color: "text-violet-500",  label: "AI-generated images" },
  url: { icon: Link2,     color: "text-emerald-500", label: "Import from URL"   },
};

function WizardHeader({
  mode,
  onBack,
  showBack = true,
}: {
  mode:      WizardMode;
  onBack?:   () => void;
  showBack?: boolean;
}) {
  const cfg  = modeLabel[mode];
  const Icon = cfg.icon;
  return (
    <div className="flex items-center gap-3">
      {showBack && onBack && (
        <button
          onClick={onBack}
          className="flex h-8 w-8 items-center justify-center rounded-lg border text-zinc-400 transition-colors hover:bg-zinc-50 hover:text-zinc-600"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
      )}
      <div>
        <div className="flex items-center gap-2">
          <Icon className={cn("h-4 w-4", cfg.color)} />
          <span className={cn("text-xs font-semibold", cfg.color)}>{cfg.label}</span>
        </div>
        <h1 className="text-2xl font-bold text-zinc-900 leading-tight">
          Create new listing
        </h1>
      </div>
    </div>
  );
}

// ─── Page export ──────────────────────────────────────────────────────────────

export default function NewListingPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-6">
          <div className="h-8 w-48 animate-pulse rounded-lg bg-zinc-100" />
          <div className="h-64 animate-pulse rounded-2xl bg-zinc-100" />
        </div>
      }
    >
      <NewListingWizard />
    </Suspense>
  );
}
