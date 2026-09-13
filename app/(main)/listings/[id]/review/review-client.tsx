"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  Sparkles,
  Check,
  RefreshCw,
  ChevronRight,
  ChevronDown,
  Plus,
  Star,
  Loader2,
  AlertCircle,
  Tag,
  X,
  ShieldAlert,
  CheckCircle2,
  Info,
  ListChecks,
  Pencil,
  Clock,
  Wand2,
} from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { calcNetPayout } from "@/lib/mock/categories";
import { formatGHS, cn } from "@/lib/utils";
import type { ListingRow, VariantRow as VariantRowDB } from "@/lib/supabase/types";
import { updateListing, replaceVariantsForListing } from "@/lib/actions/listings";
import { calculateQualityScore, scoreLabel, scoreColor, DEFAULT_THRESHOLD } from "@/lib/quality-score";
import { stripHtml } from "@/lib/utils/strip-html";
import type { JumiaCategoryAttribute } from "@/lib/jumia/categories";
import { CategoryDrawer } from "@/components/ui/category-drawer";
import { PublishingLoader } from "@/components/ui/publishing-loader";
import { EnhanceModal, type EnhanceMode } from "@/components/enhance/EnhanceModal";
import { GenerateImageModal } from "@/components/imagen/GenerateImageModal";
import { getQuotaSummaryForCurrentUser } from "@/lib/actions/subscription";
import { MultiSelectDropdown } from "@/components/ui/multi-select";
import { SchemaForm } from "@/components/jumia/SchemaForm";
import { STATIC_FIELDS, universalInfoFields } from "@/lib/jumia/universal-fields";
import {
  columnFor,
  fieldChangeToUpdate,
  type MappedColumn,
} from "@/lib/jumia/attribute-mapping";
import { VariantCard, buildAxisCombos, abbr } from "@/components/jumia/VariantCard";
import type { VariantRow, AxisDef } from "@/lib/jumia/variant-types";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AttrSchema {
  name:           string;
  label:          string;
  type:           "enum" | "string" | "number" | "boolean" | "multi" | "date" | "datetime" | "textarea";
  allowed_values: string[];
  required:       boolean;
  is_variant:     boolean;
  min_length?:    number | null;
  max_length?:    number | null;
}

// ─── Quality score badge (collapsible details) ───────────────────────────────

function QualityScoreBadge({
  score,
  threshold,
  issues,
}: {
  score: number;
  threshold: number;
  issues: string[];
}) {
  const [open, setOpen] = useState(false);
  const color = scoreColor(score);
  const label = scoreLabel(score);
  const blocked = score < threshold;

  const colorClasses: Record<string, string> = {
    emerald: "bg-emerald-50 border-emerald-200 text-emerald-700",
    blue:    "bg-blue-50 border-blue-200 text-blue-700",
    amber:   "bg-amber-50 border-amber-200 text-amber-700",
    red:     "bg-red-50 border-red-200 text-red-700",
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors",
          colorClasses[color] ?? colorClasses.amber
        )}
      >
        <Star className="h-3 w-3" />
        {score}/100 · {label}
        {blocked && <ShieldAlert className="h-3 w-3 ml-0.5 text-red-500" />}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 w-72 rounded-xl border bg-white p-4 shadow-lg text-xs space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-zinc-700">Quality breakdown</span>
            <button onClick={() => setOpen(false)} className="text-zinc-400 hover:text-zinc-600">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="rounded-lg bg-zinc-50 border px-3 py-2">
            <div className="flex h-2 overflow-hidden rounded-full bg-zinc-200">
              <div
                className={cn("h-full rounded-full transition-all", {
                  "bg-emerald-500": color === "emerald",
                  "bg-blue-500":    color === "blue",
                  "bg-amber-500":   color === "amber",
                  "bg-red-500":     color === "red",
                })}
                style={{ width: `${score}%` }}
              />
            </div>
            <p className="mt-1.5 text-center text-[11px] font-bold text-zinc-600">{score}/100</p>
          </div>
          {blocked && (
            <p className="flex items-start gap-1.5 text-red-600">
              <ShieldAlert className="h-3 w-3 shrink-0 mt-0.5" />
              Score below publish threshold ({threshold}). Fix the issues below.
            </p>
          )}
          {issues.length > 0 && (
            <ul className="space-y-1 text-zinc-500">
              {issues.slice(0, 6).map((iss, i) => (
                <li key={i} className="flex items-start gap-1">
                  <AlertCircle className="h-3 w-3 shrink-0 mt-0.5 text-amber-500" />
                  {iss}
                </li>
              ))}
              {issues.length > 6 && (
                <li className="text-zinc-400">+{issues.length - 6} more…</li>
              )}
            </ul>
          )}
          <p className="text-zinc-400 text-[10px]">
            Threshold: {threshold} — set via QUALITY_SCORE_MIN env var.
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Required asterisk ────────────────────────────────────────────────────────

function Required() {
  return <span className="ml-0.5 text-orange-500">*</span>;
}

// (The Jumia-style rich-text editor lives in components/jumia/RichTextField.tsx —
// SchemaField uses it for every long-text attribute. The local cosmetic copy
// that used to live here has been removed.)

// ─── Brand combobox (Jumia API search) ────────────────────────────────────────

function BrandCombobox({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [query, setQuery] = useState(value);
  const [results, setResults] = useState<{ code: number; name: string }[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { setQuery(value); }, [value]);

  const search = useCallback((q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!q.trim()) { setResults([]); setOpen(false); return; }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res  = await fetch(`/api/jumia/brands?q=${encodeURIComponent(q)}`);
        const data = await res.json() as { brands: { code: number; name: string }[] };
        setResults(data.brands ?? []);
        setOpen(true);
      } catch { setResults([]); }
      finally { setLoading(false); }
    }, 300);
  }, []);

  return (
    <div className="relative">
      <Input
        value={query}
        onChange={(e) => { setQuery(e.target.value); onChange(e.target.value); search(e.target.value); }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Brand"
        className="h-10 text-sm"
      />
      {loading && (
        <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 animate-spin text-zinc-400" />
      )}
      {open && results.length > 0 && (
        <div className="absolute z-10 w-full mt-1 rounded-md border bg-white shadow-lg max-h-48 overflow-y-auto">
          {results.map((b) => (
            <button
              key={b.code}
              type="button"
              className="w-full px-3 py-2 text-left text-sm hover:bg-orange-50 border-b last:border-b-0"
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(b.name);
                setQuery(b.name);
                setOpen(false);
              }}
            >
              {b.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Vertical step rail (left side, sticky) ──────────────────────────────────

const STEP_DEFS = [
  { id: "info",     label: "Product Information" },
  { id: "variants", label: "Variants" },
  { id: "spec",     label: "Product Specification" },
] as const;
type StepId = typeof STEP_DEFS[number]["id"];

function StepRail({
  active,
  completed,
  onJump,
}: {
  active: StepId;
  completed: Set<StepId>;
  onJump: (id: StepId) => void;
}) {
  return (
    <div className="flex flex-col">
      {STEP_DEFS.map((s, i) => {
        const isActive = active === s.id;
        const isDone   = completed.has(s.id) && !isActive;
        return (
          <div key={s.id} className="flex">
            <div className="flex shrink-0 flex-col items-center">
              <button
                type="button"
                onClick={() => onJump(s.id)}
                className={cn(
                  "flex h-5 w-5 items-center justify-center rounded-full border-2 transition-colors",
                  isActive
                    ? "border-orange-500 bg-white"
                    : isDone
                    ? "border-orange-500 bg-orange-500 text-white"
                    : "border-zinc-300 bg-white"
                )}
              >
                {isActive && <span className="h-1.5 w-1.5 rounded-full bg-orange-500" />}
                {isDone && <Check className="h-3 w-3" />}
              </button>
              {i < STEP_DEFS.length - 1 && (
                <div
                  className={cn(
                    "w-0.5 my-1 rounded-full transition-colors",
                    isDone ? "bg-orange-500" : "bg-zinc-200"
                  )}
                  style={{ height: 60 }}
                />
              )}
            </div>
            <button
              type="button"
              onClick={() => onJump(s.id)}
              className={cn(
                "ml-3 -mt-0.5 text-left transition-colors",
                isActive ? "text-orange-500 font-semibold"
                  : isDone ? "text-zinc-700"
                  : "text-zinc-400"
              )}
            >
              <p className="text-xs leading-tight">{s.label.split(" ")[0]}</p>
              <p className="text-xs leading-tight">{s.label.split(" ").slice(1).join(" ")}</p>
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ─── Image grid (8 slots, Jumia-style) ────────────────────────────────────────

function ImageGrid({
  images,
  onAdd,
  onRemove,
  busy,
}: {
  images:    string[];
  onAdd?:    (file: File, slotIdx: number) => void;
  onRemove?: (url: string) => void;
  busy?:     boolean;
}) {
  const slots = Array.from({ length: 8 }, (_, i) => images[i] ?? null);
  const fileRefs = useRef<(HTMLInputElement | null)[]>([]);

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-4 gap-3 sm:grid-cols-8">
        {slots.map((url, i) => (
          <div key={i} className="relative">
            {/* Hidden file picker per empty slot. Clicking the tile
                triggers it; only renders for slots without a URL. */}
            {!url && onAdd && (
              <input
                ref={(el) => { fileRefs.current[i] = el; }}
                type="file"
                accept="image/jpeg,image/png"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onAdd(f, i);
                  e.target.value = ""; // reset so re-picking the same file works
                }}
              />
            )}
            <button
              type="button"
              disabled={busy || !onAdd && !url}
              onClick={() => { if (!url && onAdd) fileRefs.current[i]?.click(); }}
              className={cn(
                "group relative flex aspect-square w-full flex-col items-center justify-center gap-1 rounded-md border-2 overflow-hidden transition-colors",
                url
                  ? "border-solid border-zinc-200 bg-white cursor-default"
                  : onAdd
                  ? "border-dashed border-orange-300 bg-white hover:bg-orange-50 cursor-pointer"
                  : "border-dashed border-zinc-200 bg-zinc-50 cursor-not-allowed",
                busy && "opacity-60",
              )}
            >
              {url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={url} alt="" className="h-full w-full object-cover" />
              ) : (
                <>
                  <Plus className="h-5 w-5 text-orange-400" />
                  <span className="text-[10px] font-medium text-zinc-500">
                    {i === 0 ? "Main Image" : "Image"}
                  </span>
                </>
              )}
            </button>
            {url && onRemove && (
              <button
                type="button"
                onClick={() => onRemove(url)}
                disabled={busy}
                className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-500 shadow-sm hover:bg-red-50 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="Remove image"
                title="Remove this image from the listing"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        ))}
      </div>
      <p className="text-xs text-zinc-400">
        Image needs to be between 500×500 and 2000×2000 pixels. White backgrounds are recommended. No watermarks. Maximum image size 2Mb.
      </p>
    </div>
  );
}

// ─── Category attributes loader ──────────────────────────────────────────────

// Attribute names that already have first-class UI in the review form.
// CategoryDynamicFields filters these out so we don't render duplicates of
// fields like Brand, Color, Description that the seller is already filling
// in the static layout.
const HANDLED_ATTR_NAMES = new Set<string>([
  // Product Information (top of form)
  "name", "title", "product_name",
  "brand",
  "color", "colour",
  "color_family", "colour_family",
  "weight_kg", "weight", "product_weight",
  "description", "product_description",
  "highlights",
  // Product Specification (static spec fields)
  "certifications", "certification",
  "main_material", "material",
  "material_family",
  "model", "model_number",
  "note", "notes",
  "production_country", "country_of_origin",
  "product_line",
  "size", "size_l", "size_w", "size_h", "product_size", "product_measures",
  "warranty_duration",
  "warranty_type",
  "warranty_address",
  "product_warranty", "warranty_text", "warranty",
  "youtube_id", "video", "youtube",
  "fda",
  "from_the_manufacturer", "manufacturer",
  "whats_in_the_box", "box_contents", "in_the_box",
  // Price / stock / SKU / GTIN — never AI-fillable anyway
  "selling_price", "price", "global_price", "sale_price",
  "quantity", "stock",
  "sku", "seller_sku", "parent_sku",
  "gtin", "gtin_barcode", "barcode_ean", "ean", "upc",
]);

function CategoryDynamicFields({
  categoryCode,
  values,
  onChange,
}: {
  categoryCode: string | null;
  values:       Record<string, string>;
  onChange:     (key: string, val: string) => void;
}) {
  const [schema,  setSchema]  = useState<AttrSchema[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  const loadAttributes = useCallback(async () => {
    if (!categoryCode || isNaN(Number(categoryCode)) || Number(categoryCode) === 0) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const r = await fetch(`/api/jumia/categories/${categoryCode}/attributes`);
      const d = await r.json();
      // Filter out attrs that already have first-class UI elsewhere in the
      // form — this is what makes the dynamic section TRULY category-specific
      // (Equipment Type / Voltage / RAM / etc.) instead of duplicating Brand,
      // Color, etc.
      const all = ((d.attributes ?? []) as AttrSchema[]).filter(
        (a) => !HANDLED_ATTR_NAMES.has(a.name.toLowerCase())
      );
      setSchema(all);
    } catch {
      setSchema([]);
    } finally {
      setLoading(false);
    }
  }, [categoryCode]);

  useEffect(() => { loadAttributes(); }, [loadAttributes]);

  const handleSyncNow = async () => {
    setSyncing(true);
    setSyncError(null);
    try {
      const r = await fetch("/api/jumia/sync-categories", { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Sync failed");
      await new Promise((res) => setTimeout(res, 600));
      await loadAttributes();
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  if (!categoryCode) return null;

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-zinc-400">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading category-specific fields…
      </div>
    );
  }

  if (!schema.length) {
    return (
      <div className="rounded-md border border-dashed border-zinc-300 bg-zinc-50/50 p-4 text-center space-y-2">
        <p className="text-xs text-zinc-500">
          No category-specific fields cached. Pull them from Jumia now.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleSyncNow}
          disabled={syncing}
          className="h-8 gap-1.5 text-xs"
        >
          {syncing
            ? <><Loader2 className="h-3 w-3 animate-spin" /> Fetching…</>
            : <><RefreshCw className="h-3 w-3" /> Fetch fields from Jumia</>}
        </Button>
        {syncError && <p className="text-xs text-red-500">{syncError}</p>}
      </div>
    );
  }

  const renderField = (attr: AttrSchema) => {
    const val = values[attr.name] ?? "";

    // BOOLEAN
    if (attr.type === "boolean") {
      return (
        <Select value={val} onValueChange={(v) => onChange(attr.name, v)}>
          <SelectTrigger className="h-10 text-sm">
            <SelectValue placeholder={`Ex: Yes [${attr.label}]`} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="true">Yes</SelectItem>
            <SelectItem value="false">No</SelectItem>
          </SelectContent>
        </Select>
      );
    }

    // SELECTION
    if (attr.type === "enum" && attr.allowed_values.length > 0) {
      return (
        <Select value={val} onValueChange={(v) => onChange(attr.name, v)}>
          <SelectTrigger className="h-10 text-sm">
            <SelectValue placeholder={`Ex: ${attr.allowed_values[0]} [${attr.label}]`} />
          </SelectTrigger>
          <SelectContent>
            {attr.allowed_values.map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
          </SelectContent>
        </Select>
      );
    }

    // MULTI_SELECTION — checkbox dropdown (Jumia-style)
    if (attr.type === "multi" && attr.allowed_values.length > 0) {
      return (
        <MultiSelectDropdown
          options={attr.allowed_values}
          value={val}
          onChange={(v) => onChange(attr.name, v)}
          placeholder={`Pick one or more · ${attr.label}`}
        />
      );
    }

    // DATE
    if (attr.type === "date") {
      return (
        <Input
          type="date"
          value={val}
          onChange={(e) => onChange(attr.name, e.target.value)}
          className="h-10 text-sm"
        />
      );
    }

    // DATE_TIME
    if (attr.type === "datetime") {
      return (
        <Input
          type="datetime-local"
          value={val}
          onChange={(e) => onChange(attr.name, e.target.value)}
          className="h-10 text-sm"
        />
      );
    }

    // TEXT_AREA
    if (attr.type === "textarea") {
      return (
        <Textarea
          value={val}
          rows={3}
          placeholder={`Ex: [${attr.label}]`}
          onChange={(e) => onChange(attr.name, e.target.value)}
          className="text-sm"
        />
      );
    }

    // TEXT / NUMBER (default)
    return (
      <Input
        value={val}
        type={attr.type === "number" ? "number" : "text"}
        placeholder={`Ex: [${attr.label}]`}
        onChange={(e) => onChange(attr.name, e.target.value)}
        className="h-10 text-sm"
      />
    );
  };

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {schema.map((attr) => {
        const val = values[attr.name] ?? "";
        const hasMin = typeof attr.min_length === "number" && attr.min_length > 0;
        const hasMax = typeof attr.max_length === "number" && attr.max_length > 0;
        const len = val.length;
        const tooShort = hasMin && len > 0 && len < attr.min_length!;
        const tooLong  = hasMax && len > attr.max_length!;
        const isText   = ["string", "textarea", "number"].includes(attr.type);

        return (
          <div key={attr.name} className="space-y-1.5">
            <Label className="text-xs font-semibold text-zinc-700 flex items-center gap-1.5">
              <span>{attr.label}</span>
              {attr.required && <Required />}
              {attr.is_variant && (
                <span className="text-[9px] rounded-full bg-violet-100 text-violet-600 px-1.5 py-0.5 font-semibold">variant</span>
              )}
            </Label>
            {renderField(attr)}
            {isText && (hasMin || hasMax) && (
              <p className={cn(
                "text-[11px]",
                tooShort || tooLong ? "text-red-500" :
                len > 0             ? "text-emerald-600" :
                                      "text-zinc-400"
              )}>
                {len}{hasMax ? `/${attr.max_length}` : ""} characters
                {hasMin && len < attr.min_length! && ` · min ${attr.min_length}`}
              </p>
            )}
            {attr.required && !(hasMin || hasMax) && (
              <p className="text-[11px] text-orange-600">Required to increase listing quality</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── AI confidence banner ─────────────────────────────────────────────────────
//
// Surfaces two pieces of info from the AI run:
//   1. How many fields were auto-filled vs need seller attention.
//   2. If the model wasn't confident about the category, offers the top-2
//      alternates as quick-switch buttons (per PDF spec: needs_user_confirmation).

// ─────────────────────────────────────────────────────────────────────────
// AI Assist card — ONE place for every AI-remediation action on this page.
// Used to be three separate components scattered across the page (a banner
// near the top, a card inside Product Information, a button in the Submit
// footer) — collapsed into one, since two of the three already hit the
// EXACT SAME backend endpoint: /api/listings/[id]/resolve-rejection's own
// doc comment describes its "Two trigger modes" (jumia_rejection /
// quality_score). The split was purely a frontend/placement choice, not a
// backend one, so consolidating costs nothing there.
//
// Picks exactly one state, in priority order, so the seller never sees more
// than one "ask the AI to help" surface at once:
//   1. Jumia rejected this listing — most urgent, a real submission failure.
//      (mode: jumia_rejection, no body — the route reads listing.jumia_error)
//   2. The listing has real content but its quality score is below the
//      publish threshold. (mode: quality_score, reason = the issues list)
//   3. No AI content yet (or the seller just wants to re-run/improve) —
//      the original one-click full-pipeline analyze.
// ─────────────────────────────────────────────────────────────────────────

function AiAssistCard({
  listing,
  router,
  qualityScore,
  qualityIssues,
  qualityThreshold,
  analyzeStep,
  analyzeError,
  analyzeResult,
  analyzePrompt,
  onAnalyzePromptChange,
  onAnalyzeStart,
}: {
  listing:          ListingRow;
  router:           ReturnType<typeof useRouter>;
  qualityScore:     number;
  qualityIssues:    string[];
  qualityThreshold: number;
  analyzeStep:      AnalyzeStep;
  analyzeError:     string | null;
  analyzeResult:    { title?: string; categoryPath?: string; confidence?: number; attributesFilled?: number; totalMs?: number } | null;
  analyzePrompt:    string;
  onAnalyzePromptChange: (v: string) => void;
  onAnalyzeStart:   () => void;
}) {
  const [working,    setWorking]    = useState(false);
  const [fixError,   setFixError]   = useState<string | null>(null);
  const [resolution, setResolution] = useState<{
    summary:   string;
    reasoning: string;
    updates:   Record<string, unknown>;
  } | null>(null);

  const rejected  = listing.status === "failed" && Boolean(listing.jumia_error);
  const hasContent = Boolean(listing.title?.trim());
  const qualityLow = hasContent && qualityScore < qualityThreshold;

  const resolve = async (mode: "jumia_rejection" | "quality_score") => {
    setWorking(true);
    setFixError(null);
    setResolution(null);
    try {
      const body = mode === "quality_score"
        ? {
            mode,
            reason: `The seller's quality score is below the publish threshold. Issues flagged by our checker:\n${qualityIssues.map((i) => `- ${i}`).join("\n")}\n\nPropose specific field changes that address these issues directly.`,
          }
        : undefined;
      const res = await fetch(`/api/listings/${listing.id}/resolve-rejection`, {
        method:  "POST",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body:    body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "AI fix failed");
      setResolution({
        summary:   String(data.summary   ?? ""),
        reasoning: String(data.reasoning ?? ""),
        updates:   (data.updates as Record<string, unknown>) ?? {},
      });
      // Refresh server data so the form picks up the new field values.
      router.refresh();
    } catch (e) {
      setFixError(e instanceof Error ? e.message : "AI fix failed");
    } finally {
      setWorking(false);
    }
  };

  // ── Case 1 & 2 success state: the AI fixed the listing. Show the diff +
  // a hint to push again. The seller still has to click the regular Submit
  // button (we don't auto-push — gives them a chance to verify the work).
  if (resolution) {
    const changedKeys = Object.keys(resolution.updates);
    return (
      <div className="rounded-md border border-emerald-200 bg-emerald-50 p-4 space-y-2">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
          <p className="text-sm font-semibold text-emerald-900">
            AI updated {changedKeys.length} field{changedKeys.length === 1 ? "" : "s"}.
          </p>
        </div>
        <p className="text-xs text-emerald-800">{resolution.summary}</p>
        {resolution.reasoning && (
          <p className="text-[11px] text-emerald-700/80">{resolution.reasoning}</p>
        )}
        {changedKeys.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-1">
            {changedKeys.map((k) => (
              <span
                key={k}
                className="rounded-full bg-white border border-emerald-200 px-2 py-0.5 text-[10px] font-medium text-emerald-700"
              >
                {k}
              </span>
            ))}
          </div>
        )}
        <p className="text-[11px] text-emerald-700 pt-1">
          Review the changes, then click <span className="font-semibold">Submit</span> below to re-push.
        </p>
      </div>
    );
  }

  // ── Case 1: Jumia rejected this listing ──────────────────────────────────
  if (rejected) {
    // Parse the rejection — Supabase stores it as a JSON-stringified Jumia
    // error object. Display the human-readable message; fall back to raw.
    const rejectionText = (() => {
      try {
        const parsed = JSON.parse(listing.jumia_error as string);
        if (typeof parsed === "string") return parsed;
        const candidates = [
          parsed?.message,
          parsed?.errorMessage,
          parsed?.error,
          Array.isArray(parsed?.errors) && parsed.errors[0],
        ].filter((x) => typeof x === "string" || typeof x === "object");
        if (typeof candidates[0] === "string") return candidates[0] as string;
        return JSON.stringify(parsed);
      } catch {
        return listing.jumia_error as string;
      }
    })();

    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-4 space-y-3">
        <div className="flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-red-500 mt-0.5 shrink-0" />
          <div className="flex-1 space-y-1">
            <p className="text-sm font-semibold text-red-900">
              Jumia rejected this listing
            </p>
            <p className="text-xs text-red-800 break-words">{rejectionText}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 pl-8">
          <button
            type="button"
            onClick={() => resolve("jumia_rejection")}
            disabled={working}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors",
              working
                ? "bg-red-300 cursor-not-allowed"
                : "bg-red-600 hover:bg-red-700"
            )}
          >
            {working
              ? <><Loader2 className="h-3 w-3 animate-spin" /> Resolving with AI…</>
              : <><Sparkles className="h-3 w-3" /> Resolve with AI</>}
          </button>
          <span className="text-[11px] text-red-700/80">
            AI reads the rejection, updates the fields, and resets the listing to draft.
          </span>
        </div>
        {fixError && (
          <p className="pl-8 text-[11px] text-red-700">⚠ {fixError}</p>
        )}
      </div>
    );
  }

  // ── Case 2: quality score below the publish threshold ────────────────────
  if (qualityLow) {
    return (
      <div className="rounded-md border border-violet-200 bg-violet-50 p-4 space-y-2">
        <div className="flex items-start gap-3">
          <ShieldAlert className="h-5 w-5 text-violet-500 mt-0.5 shrink-0" />
          <div className="flex-1 space-y-1">
            <p className="text-sm font-semibold text-violet-900">
              Quality score {qualityScore}/{qualityThreshold} — below the publish threshold
            </p>
            <ul className="text-xs text-violet-800 space-y-0.5">
              {qualityIssues.slice(0, 4).map((iss, i) => (
                <li key={i}>• {iss}</li>
              ))}
              {qualityIssues.length > 4 && (
                <li className="text-violet-500">+{qualityIssues.length - 4} more…</li>
              )}
            </ul>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 pl-8">
          <button
            type="button"
            onClick={() => resolve("quality_score")}
            disabled={working || qualityIssues.length === 0}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors",
              working
                ? "bg-violet-300 cursor-not-allowed"
                : "bg-violet-600 hover:bg-violet-700"
            )}
          >
            {working
              ? <><Loader2 className="h-3 w-3 animate-spin" /> Fixing…</>
              : <><Sparkles className="h-3 w-3" /> Fix with AI</>}
          </button>
        </div>
        {fixError && <p className="pl-8 text-[11px] text-red-600">{fixError}</p>}
      </div>
    );
  }

  // ── Case 3: no AI content yet, or the seller wants to re-run/improve ─────
  if ((listing.images?.length ?? 0) === 0) return null;
  return (
    <AnalyzeWithAICard
      step={analyzeStep}
      error={analyzeError}
      result={analyzeResult}
      prompt={analyzePrompt}
      onPromptChange={onAnalyzePromptChange}
      onStart={onAnalyzeStart}
    />
  );
}

function AIConfidenceBanner({
  listing,
  currentCategoryCode,
  onSwitchCategory,
}: {
  listing:             ListingRow;
  currentCategoryCode: string | null;
  onSwitchCategory:    (cat: { code: number; name: string; path: string }) => void;
}) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  const sources    = (listing.field_sources    ?? {}) as Record<string, string>;
  const confidence = (listing.field_confidence ?? {}) as Record<string, { confidence: number; source: string }>;
  const alternates = (listing.category_alternates ?? []) as Array<{ code: number; name: string; path: string; confidence: number }>;

  const aiFieldCount = Object.values(sources).filter((s) => s === "ai").length;
  const sellerRequiredCount = Object.values(confidence).filter((c) => c.source === "seller-required").length;

  // Show category-confidence prompt when the AI flagged it OR if the primary
  // pick has < 0.75 confidence (recomputed from alternates).
  const primaryConf = alternates.find((a) => String(a.code) === currentCategoryCode)?.confidence ?? 0;
  const otherAlternates = alternates.filter((a) => String(a.code) !== currentCategoryCode).slice(0, 2);
  const needsCategoryConfirmation = primaryConf > 0 && primaryConf < 0.75 && otherAlternates.length > 0;

  // Only show the banner if we have anything meaningful to surface
  if (aiFieldCount === 0 && !needsCategoryConfirmation) return null;

  return (
    <div className="rounded-md border border-violet-200 bg-gradient-to-r from-violet-50 to-fuchsia-50 px-4 py-3 text-sm space-y-2">
      <div className="flex items-start gap-3">
        <Sparkles className="h-4 w-4 text-violet-600 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0 space-y-1">
          {aiFieldCount > 0 && (
            <p className="text-violet-900">
              <span className="font-semibold">Complete! Review and submit to Jumia.</span>
              {sellerRequiredCount > 0 && (
                <span className="text-violet-600"> ({sellerRequiredCount} need your input.)</span>
              )}
            </p>
          )}
          {needsCategoryConfirmation && (
            <div className="pt-1">
              <p className="text-xs font-semibold text-violet-800">
                Not sure about the category ({Math.round(primaryConf * 100)}% confident). Pick the right one:
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {otherAlternates.map((a) => (
                  <button
                    key={a.code}
                    type="button"
                    onClick={() => onSwitchCategory({ code: a.code, name: a.name, path: a.path })}
                    className="rounded-full border border-violet-300 bg-white px-2.5 py-1 text-xs font-medium text-violet-700 hover:bg-violet-100 transition-colors"
                  >
                    <span className="opacity-70">{Math.round(a.confidence * 100)}%</span>{" "}
                    {a.path}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="shrink-0 text-violet-400 hover:text-violet-700"
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

// ─── Per-field confidence dot ─────────────────────────────────────────────────
//
// Tiny coloured pill next to a field's label that reflects how it was filled.
// Per PDF spec:
//   green = high confidence (>= 0.9)
//   yellow = inferred (0 < confidence < 0.9, source = image/inferred/ocr)
//   gray   = seller-required (AI deliberately left empty)

export function ConfidenceDot({
  source,
  confidence,
}: {
  source?:     "image" | "ocr" | "inferred" | "seller-required";
  confidence?: number;
}) {
  if (!source) return null;
  if (source === "seller-required") {
    return (
      <span
        className="ml-1.5 inline-flex items-center gap-1 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[9px] font-semibold text-zinc-500"
        title="You fill this in — AI cannot infer it from images."
      >
        <span className="h-1.5 w-1.5 rounded-full bg-zinc-400" /> you
      </span>
    );
  }
  const high = (confidence ?? 0) >= 0.9;
  return (
    <span
      className={cn(
        "ml-1.5 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold",
        high ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"
      )}
      title={high
        ? `AI is highly confident (${Math.round((confidence ?? 0) * 100)}%) — accept or edit.`
        : `AI inferred from images (${Math.round((confidence ?? 0) * 100)}%) — please verify.`
      }
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", high ? "bg-emerald-500" : "bg-amber-500")} />
      {high ? "AI ✓" : "AI"}
    </span>
  );
}

// ─── Analyze With AI card ────────────────────────────────────────────────────
//
// Single-button auto-analyze CTA. While the pipeline runs it shows a 4-step
// progress checklist so the seller can see momentum (describing → finding
// candidates → ranking → filling fields). The total round trip is ~8–12s.

type AnalyzeStep = "idle" | "describing" | "retrieving" | "ranking" | "filling" | "done" | "error";

const ANALYZE_STEPS: { id: AnalyzeStep; label: string }[] = [
  { id: "describing",  label: "Identifying product from images" },
  { id: "retrieving",  label: "Finding best-matching Jumia categories" },
  { id: "ranking",     label: "Picking the best category" },
  { id: "filling",     label: "Filling category-specific fields" },
];

function AnalyzeWithAICard({
  step,
  error,
  result,
  prompt,
  onPromptChange,
  onStart,
}: {
  step:    AnalyzeStep;
  error:   string | null;
  result:  { title?: string; categoryPath?: string; confidence?: number; attributesFilled?: number; totalMs?: number } | null;
  prompt:  string;
  onPromptChange: (v: string) => void;
  onStart: () => void;
}) {
  const running = step !== "idle" && step !== "done" && step !== "error";
  const stepOrder = ["describing", "retrieving", "ranking", "filling", "done"] as const;
  const currentIdx = stepOrder.indexOf(step as typeof stepOrder[number]);

  if (step === "done" && result) {
    return (
      <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 space-y-1.5">
        <div className="flex items-center gap-2 text-sm font-semibold text-emerald-800">
          <CheckCircle2 className="h-4 w-4" />
          AI analysis complete
          {result.totalMs && (
            <span className="ml-auto text-[11px] font-normal text-emerald-700">
              {(result.totalMs / 1000).toFixed(1)}s
            </span>
          )}
        </div>
        <p className="text-xs text-emerald-700">
          Category: <span className="font-semibold">{result.categoryPath}</span>
          {typeof result.confidence === "number" && (
            <span className="ml-1">({Math.round(result.confidence * 100)}% confident)</span>
          )}
        </p>
        <p className="text-xs text-emerald-700">
          {result.attributesFilled ?? 0} fields auto-filled · review below before submitting.
        </p>
        <button
          type="button"
          onClick={onStart}
          className="text-[11px] font-medium text-emerald-600 hover:text-emerald-800 underline"
        >
          Re-run analysis
        </button>
      </div>
    );
  }

  if (running) {
    return (
      <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-3 space-y-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-blue-900">
          <Loader2 className="h-4 w-4 animate-spin" />
          Analysing with AI…
        </div>
        <ul className="space-y-1 text-xs">
          {ANALYZE_STEPS.map((s, i) => {
            const done    = i < currentIdx;
            const active  = i === currentIdx;
            return (
              <li
                key={s.id}
                className={cn(
                  "flex items-center gap-2 transition-opacity",
                  done   ? "text-emerald-700" :
                  active ? "text-blue-800 font-medium" :
                           "text-zinc-400"
                )}
              >
                <span className="w-4 inline-flex justify-center">
                  {done   ? <CheckCircle2 className="h-3 w-3" /> :
                   active ? <Loader2 className="h-3 w-3 animate-spin" /> :
                            <span className="h-1.5 w-1.5 rounded-full bg-zinc-300" />}
                </span>
                {s.label}
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  // Idle / error state — show the prompt textarea + CTA button
  return (
    <div className="rounded-md border border-orange-200 bg-gradient-to-r from-orange-50 to-amber-50 px-4 py-3 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-orange-900">
            <Sparkles className="h-4 w-4 text-orange-500" />
            What do you want in the listing
          </div>
          <p className="text-[11px] text-orange-700 mt-0.5">
            Optional: tell the AI anything the images don&apos;t show.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={onStart}
          className="shrink-0 bg-orange-500 hover:bg-orange-600 text-white gap-1.5"
        >
          <Sparkles className="h-3.5 w-3.5" />
          {error ? "Try again" : "Analyze"}
        </Button>
      </div>

      {/* Optional context for the AI — anything the images don't show */}
      <div className="space-y-1">
        <textarea
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          rows={2}
          maxLength={1000}
          placeholder="E.g. 'this is a pack of 6', 'the colour is teal not blue', 'specify it's wireless'."
          className="w-full rounded-md border border-orange-200 bg-white/70 px-2.5 py-1.5 text-xs text-zinc-700 placeholder:text-zinc-400 focus:outline-none focus:ring-1 focus:ring-orange-300 resize-none"
        />
        <p className="text-[10px] text-orange-600">
          {prompt.length > 0 && `${prompt.length}/1000 · `}
          AI can make mistakes, please double check.
        </p>
      </div>

      {error && (
        <p className="text-[11px] text-red-600 flex items-start gap-1">
          <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" /> {error}
        </p>
      )}
    </div>
  );
}

// ─── Main review client ───────────────────────────────────────────────────────

const PUBLISH_THRESHOLD = typeof process !== "undefined"
  ? parseInt(process.env.NEXT_PUBLIC_QUALITY_THRESHOLD ?? String(DEFAULT_THRESHOLD), 10)
  : DEFAULT_THRESHOLD;

/**
 * Attribute names that belong in the Product Information section (top of the
 * page — brand, colour, basic description, etc.) rather than the Product
 * Specification section (technical details, dimensions, materials).
 *
 * Both sections render via the same schema-driven SchemaForm. We split the
 * Jumia schema between them using includeNames here and excludeNames in the
 * Product Specification slot, so a field never renders twice.
 *
 * Aliases (color / colour, weight / weight_kg) are included so the case-
 * insensitive matcher in SchemaForm picks up either form Jumia uses.
 *
 * Material fields live in Product Specification (matches Jumia VC's layout)
 * — do NOT add them here.
 */
const PRODUCT_INFO_FIELDS = [
  "brand",
  "color", "colour",
  "color_family", "colour_family",
  "weight", "weight_kg", "product_weight",
  "description", "product_description",
  "highlights", "short_description",
];

/**
 * Schema-attribute names that the Variants tab handles instead. We hide
 * these from both Product Information and Product Specification grids
 * so the seller doesn't see a duplicate "Variation" input that competes
 * with the per-variant labels in the Variants tab.
 *
 * On push, the variation value is injected into each product's attributes
 * array from the matching variant row (see lib/jumia/api.ts:
 * PER_VARIANT_ATTRIBUTE_NAMES + mapListingToJumiaProducts).
 */
const VARIANT_ATTRIBUTE_FIELDS = ["variation"];

export function ReviewClient({
  listing,
  initialVariants = [],
}: {
  listing:          ListingRow;
  initialVariants?: VariantRowDB[];
}) {
  const router       = useRouter();
  const searchParams = useSearchParams();

  // ── Batch mode: switcher between sibling products ────────────────────────
  // When the seller created N products in the batch flow, the URL contains
  // ?batch=id1,id2,id3 so we can render prdt1 / prdt2 / prdt3 tabs at the
  // top of the review page — same affordance as the upload step.
  const batchIds = (searchParams.get("batch") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const inBatch = batchIds.length > 1 && batchIds.includes(listing.id);

  type BatchSibling = {
    id:        string;
    title:     string;
    sku:       string;
    status:    string;
    thumbnail: string | null;
  };
  const [batchSiblings, setBatchSiblings] = useState<BatchSibling[]>([]);

  useEffect(() => {
    if (!inBatch) return;
    fetch(`/api/listings/batch?ids=${batchIds.join(",")}`)
      .then((r) => r.json())
      .then((d) => setBatchSiblings(d.listings ?? []))
      .catch(() => setBatchSiblings([]));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inBatch, batchIds.join(",")]);

  const batchQuery = batchIds.length > 0 ? `?batch=${batchIds.join(",")}` : "";
  const currentBatchIdx = batchIds.indexOf(listing.id);
  const formRef = useRef<HTMLFormElement>(null);

  // ── Section refs for scroll-spy + jump ────────────────────────────────────
  const infoRef     = useRef<HTMLDivElement>(null);
  const variantsRef = useRef<HTMLDivElement>(null);
  const specRef     = useRef<HTMLDivElement>(null);
  const [activeStep, setActiveStep] = useState<StepId>("info");

  // ── Top-level controlled state ────────────────────────────────────────────
  //
  // Only fields that need character-count validation in the header UI or
  // that drive the Quality Score get their own controlled state. Everything
  // else flows through columnOverrides + dynAttrs (single source of truth,
  // populated by the schema-driven SchemaForm via handleSchemaFieldChange).
  //
  // Jumia enforces strict min/max lengths and rejects feeds that violate
  // them — we mirror those limits in the input components below so Submit
  // is gated until everything is valid.
  const [titleValue,       setTitleValue]       = useState(listing.title ?? "");
  const [descriptionValue, setDescriptionValue] = useState(listing.description ?? "");
  const [highlightsValue,  setHighlightsValue]  = useState(listing.highlights ?? "");
  const [brandValue,       setBrandValue]       = useState(listing.brand ?? "");

  // ── Category ──────────────────────────────────────────────────────────────
  const [categoryCode, setCategoryCode] = useState<string | null>(listing.category_code);
  const [categoryPath, setCategoryPath] = useState<string | null>(listing.category_path);
  const [categoryName, setCategoryName] = useState<string>(
    listing.category_path?.split("/").pop()?.trim() ?? ""
  );
  const [showCategoryPicker, setShowCategoryPicker] = useState(false);

  // AI re-fill state — runs when the user changes category so attributes
  // appear pre-filled per the PDF spec ("when selected, its attributes
  // should show up for filling by the AI").
  const [refillingAttributes, setRefillingAttributes] = useState(false);
  // Success messages clear when a fresh refill starts. Errors PERSIST until
  // explicitly dismissed or a subsequent refill succeeds — sellers must see
  // when the AI fill failed silently.
  const [refillSuccess, setRefillSuccess] = useState<string | null>(null);
  const [refillError,   setRefillError]   = useState<string | null>(null);

  // Drawer pick → straight to a full AI refill for the new category — one
  // action instead of two. This used to be schema-only (empty fields,
  // requiring a separate "Fill empty fields with AI" click to populate
  // them) — collapsing the two into the pick itself matches how a
  // category correction is meant to feel: pick the right one, get a
  // filled-in listing back, done. "Fill with AI" (handleFillWithAI below)
  // stays available for re-running the fill later without touching
  // category (e.g. after manually clearing a field).
  const handleCategoryChange = async (cat: { code: number; name: string; path: string }) => {
    const previousCode = categoryCode;

    // Optimistic UI update
    setCategoryCode(String(cat.code));
    setCategoryPath(cat.path);
    setCategoryName(cat.name);

    // If the seller re-picked the same category, nothing to do.
    if (String(cat.code) === previousCode) return;

    setRefillingAttributes(true);
    setRefillSuccess(null);
    setRefillError(null);
    try {
      const res = await fetch(
        `/api/listings/${listing.id}/refill-attributes`,
        {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ categoryCode: cat.code, categoryPath: cat.path }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        setRefillError(data.error ?? "Couldn't fetch category fields from Jumia.");
        return;
      }
      // Clear stale values from the previous category. Server-side merge
      // already preserves user-edited keys that survive the new schema —
      // pull those back from the response.
      if (data.dynamic_attributes) {
        setDynAttrs(data.dynamic_attributes as Record<string, string>);
      } else {
        setDynAttrs({});
      }
      setColumnOverrides({});
      setRefillSuccess(
        data.attributesSchema > 0
          ? `Category set — AI filled ${data.aiFilled} of ${data.attributesSchema} field${data.attributesSchema === 1 ? "" : "s"}.`
          : `Category set. No category-specific fields needed.`
      );
      router.refresh();
    } catch (e) {
      setRefillError(e instanceof Error ? e.message : "Couldn't fetch category fields.");
    } finally {
      setRefillingAttributes(false);
    }
  };

  // Opt-in AI fill — triggered by the "Fill empty fields with AI" button
  // on the schema form. Same merge semantics as the auto-analyze pipeline:
  // user-edited keys are preserved, AI only fills empty slots.
  const handleFillWithAI = async () => {
    if (!categoryCode) return;
    setRefillingAttributes(true);
    setRefillSuccess(null);
    setRefillError(null);
    try {
      const res = await fetch(`/api/listings/${listing.id}/refill-attributes`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          categoryCode: Number(categoryCode),
          categoryPath: categoryPath,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRefillError(data.error ?? "AI fill failed.");
        return;
      }
      if (data.dynamic_attributes) {
        setDynAttrs(data.dynamic_attributes as Record<string, string>);
      }
      setRefillSuccess(
        `AI filled ${data.aiFilled} of ${data.attributesSchema} field${data.attributesSchema === 1 ? "" : "s"}.`
      );
      router.refresh();
    } catch (e) {
      setRefillError(e instanceof Error ? e.message : "AI fill failed.");
    } finally {
      setRefillingAttributes(false);
    }
  };

  // ── Schema-form state model ───────────────────────────────────────────────
  //
  // The schema-driven SchemaForm is the SOLE editor for every field on the
  // page except the four top-level controlled inputs above (title, brand,
  // description, highlights — which need character-count UI and feed the
  // Quality Score).
  //
  // Two state containers carry edits:
  //   - dynAttrs:        for fields stored in listing.dynamic_attributes
  //                      (anything Jumia returns that doesn't map to a
  //                      first-class column)
  //   - columnOverrides: for fields that DO map to a first-class column
  //                      (color, weight_kg, main_material, warranty_*, etc.)
  //
  // No mirror states, no FormData reads, no display:none fallbacks. Every
  // edit from SchemaForm lands in exactly one of these two stores; save
  // reads from both. What the seller types is what gets pushed.
  const [dynAttrs, setDynAttrs] = useState<Record<string, string>>(
    (listing.dynamic_attributes ?? {}) as Record<string, string>
  );
  const [columnOverrides, setColumnOverrides] = useState<Record<string, string>>({});

  // Routes every SchemaForm edit to the correct store. The four top-level
  // controlled fields mirror via a small switch so their character-count
  // UI stays in sync; everything else is pure columnOverrides / dynAttrs.
  const handleSchemaFieldChange = useCallback((attributeName: string, value: string) => {
    const col = columnFor(attributeName);

    // Mirror the four header-driven fields to their controlled state.
    switch (col) {
      case "title":       setTitleValue(value);       break;
      case "description": setDescriptionValue(value); break;
      case "highlights":  setHighlightsValue(value);  break;
      case "brand":       setBrandValue(value);       break;
      default: /* SchemaForm + columnOverrides/dynAttrs handles the rest */
    }

    if (col) {
      setColumnOverrides((prev) => ({ ...prev, [attributeName]: value }));
    } else {
      setDynAttrs((prev) => ({ ...prev, [attributeName]: value }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Overrides map fed to SchemaForm. Order matters: dynAttrs first
  // (live dyn edits), then columnOverrides (live column edits), then the
  // four controlled mirrors so character-count edits in the header take
  // precedence over a stale schema render of the same field.
  const schemaFormOverrides: Record<string, string> = {
    ...dynAttrs,
    ...columnOverrides,
    name:                titleValue,
    title:               titleValue,
    description:         descriptionValue,
    product_description: descriptionValue,
    highlights:          highlightsValue,
    short_description:   highlightsValue,
    brand:               brandValue,
  };

  // ── Variant matrix state ──────────────────────────────────────────────────
  const commissionRate    = listing.commission_rate ?? 0.1;
  const commissionPercent = Math.round(commissionRate * 100);

  // Hydrate from persisted variant rows (set by auto-analyze when the AI
  // detected variations, or by the seller's previous save). When no rows
  // are persisted yet — first review pass of a simple product the AI
  // didn't split into variants — seed a single synthetic row with
  // variation = "Default". Jumia requires a non-empty variation even for
  // simple products, and "Default" is the boring-but-correct value that
  // ships immediately if the seller doesn't override it.
  //
  // Variation is NOT pre-derived from colour. The user's actual listings
  // on Jumia have variations like "3 Set (Trowel, Fork & Cultivator)",
  // "Hoe only", "Pack of 6" — anything that distinguishes one variant
  // from another. The AI fills these during analyse if it sees them;
  // otherwise the seller types them in, or "Default" stays.
  const [variants, setVariants] = useState<VariantRow[]>(() => {
    if (initialVariants.length > 0) {
      return initialVariants.map((v, i) => ({
        id:            `v-db-${i}`,
        axes:          {},
        variation:     v.variation        ?? "",
        sellerSku:     v.seller_sku       ?? `${listing.sku}-${i + 1}`,
        gtin:          v.gtin             ?? "",
        quantity:      String(v.quantity ?? 1),
        globalPrice:   v.global_price != null ? String(v.global_price) : "",
        salePrice:     v.sale_price   != null ? String(v.sale_price)   : "",
        saleStartDate: v.sale_start_date  ?? "",
        saleEndDate:   v.sale_end_date    ?? "",
      }));
    }
    return [{
      id: "v1", axes: {}, variation: "Default", sellerSku: listing.sku,
      gtin: "", quantity: "1",
      globalPrice: listing.selling_price ? String(listing.selling_price) : "",
      salePrice: "", saleStartDate: "", saleEndDate: "",
    }];
  });
  const [axesDef, setAxesDef] = useState<AxisDef[]>([]);
  const [selectedVariants, setSelectedVariants] = useState<Set<string>>(new Set());
  const [collapsedVariants, setCollapsedVariants] = useState<Set<string>>(new Set());

  const [schemaAxes, setSchemaAxes] = useState<JumiaCategoryAttribute[]>([]);
  useEffect(() => {
    if (!categoryCode || isNaN(Number(categoryCode))) return;
    fetch(`/api/jumia/categories/${categoryCode}/attributes`)
      .then((r) => r.json())
      .then((d) => {
        const all = (d.attributes ?? []) as JumiaCategoryAttribute[];
        setSchemaAxes(all.filter((a) => a.is_variant));
      })
      .catch(() => setSchemaAxes([]));
  }, [categoryCode]);

  // Rebuild variant rows from variant axes (Color, Size, etc.).
  // When axesDef is empty we LEAVE variants alone — they were either
  // hydrated from persisted DB rows (AI-detected variations or previous
  // saves) or the seller is editing them manually. Auto-collapsing to
  // a single row here would silently destroy multi-variant lists the
  // AI just detected (e.g. "Hoe only / Fork only / Trowel only").
  useEffect(() => {
    if (axesDef.length === 0) return;
    const combos = buildAxisCombos(axesDef);
    if (combos.length === 0) return;
    setVariants((prev) =>
      combos.map((combo) => {
        const key = Object.values(combo).map((v) => abbr(v)).join("-");
        const existing = prev.find((p) => JSON.stringify(p.axes) === JSON.stringify(combo));
        return existing ?? {
          id: `v-${key}-${Math.random().toString(36).slice(2, 6)}`,
          axes: combo,
          variation: Object.values(combo).filter(Boolean).join(" / "),
          sellerSku: `${listing.sku}-${key}`,
          gtin: "", quantity: "1",
          globalPrice: prev[0]?.globalPrice ?? "",
          salePrice: "", saleStartDate: "", saleEndDate: "",
        };
      })
    );
  }, [axesDef, listing.sku, listing.selling_price]);

  // ── Save / publish state ──────────────────────────────────────────────────
  const [saving,      setSaving]      = useState(false);
  // Phase of the publishing loader: "pushing" while POST /api/jumia/push
  // is in flight, "settling" while we hold for Jumia's feed to digest
  // before navigating to the diagnose modal, or null when not publishing.
  const [publishingPhase, setPublishingPhase] =
    useState<"pushing" | "settling" | null>(null);
  const [saveError,   setSaveError]   = useState<string | null>(null);
  const [jumiaNotConnected, setJumiaNotConnected] = useState(false);
  const [publishedRef, setPublishedRef] = useState<string | null>(null);
  // Tracks the SKU Jumia actually accepted — on retry pushes the server
  // auto-appends a -RXXXX suffix to dodge duplicate-SKU rejections, so the
  // seller's UI may now show a different value than what they typed.
  const [publishedSku, setPublishedSku] = useState<{ sku: string; changed: boolean } | null>(null);
  const [syncStatus, setSyncStatus]   = useState<"idle" | "saving" | "done" | "error">("idle");

  // ── Auto-analyze state (one-click category detection + attribute fill) ────
  type AnalyzeStep = "idle" | "describing" | "retrieving" | "ranking" | "filling" | "done" | "error";
  const [analyzeStep,   setAnalyzeStep]   = useState<AnalyzeStep>("idle");
  const [analyzeError,  setAnalyzeError]  = useState<string | null>(null);
  // Pre-fill from the listing's persisted user_prompt so re-runs default
  // to the prompt the seller used on the add page. Empty if first visit
  // or if no prompt was ever stored. Editable — seller can clear / change
  // it before clicking Analyze again.
  const [analyzePrompt, setAnalyzePrompt] = useState<string>(
    (listing as { user_prompt?: string | null }).user_prompt ?? "",
  );
  const [analyzeResult, setAnalyzeResult] = useState<{
    title?:               string;
    categoryPath?:        string;
    confidence?:          number;
    attributesFilled?:    number;
    totalMs?:             number;
  } | null>(null);

  async function handleAutoAnalyze() {
    if ((listing.images ?? []).length === 0) {
      setAnalyzeError("Upload at least one image first.");
      return;
    }
    // Debounce concurrent runs. Without this, a second click while the
    // first run is in flight kicks off a parallel AI pipeline and the
    // results race each other (second often wins, clobbering the first).
    const inFlight =
      analyzeStep === "describing" ||
      analyzeStep === "retrieving" ||
      analyzeStep === "ranking" ||
      analyzeStep === "filling";
    if (inFlight) return;

    setAnalyzeError(null);
    setAnalyzeResult(null);

    // Visual progress — these are estimates; the real timing comes back in the response
    setAnalyzeStep("describing");
    // Best-effort UI rhythm: bump through the steps even before the response
    // arrives so the user sees momentum.
    const stepTimers: ReturnType<typeof setTimeout>[] = [];
    stepTimers.push(setTimeout(() => setAnalyzeStep("retrieving"), 1500));
    stepTimers.push(setTimeout(() => setAnalyzeStep("ranking"),    3500));
    stepTimers.push(setTimeout(() => setAnalyzeStep("filling"),    6500));

    try {
      const res = await fetch(`/api/listings/${listing.id}/auto-analyze`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ userPrompt: analyzePrompt.trim() || undefined }),
      });
      const data = await res.json();
      stepTimers.forEach(clearTimeout);

      if (!res.ok || !data.success) {
        setAnalyzeStep("error");
        setAnalyzeError(data.error ?? "AI analysis failed.");
        return;
      }

      setAnalyzeStep("done");
      setAnalyzeResult({
        title:            data.title,
        categoryPath:     data.category?.path,
        confidence:       data.category?.confidence,
        attributesFilled: data.attributes_filled,
        totalMs:          data.timings?.total_ms,
      });

      // Server has already persisted — reflect in client state
      if (data.category) {
        setCategoryCode(String(data.category.code));
        setCategoryPath(data.category.path);
        setCategoryName(data.category.name);
      }
      if (data.title) setTitleValue(data.title);
      // Refresh to pull updated dynamic_attributes, field_sources, etc.
      router.refresh();
    } catch (e) {
      stepTimers.forEach(clearTimeout);
      setAnalyzeStep("error");
      setAnalyzeError(e instanceof Error ? e.message : "Network error.");
    }
  }

  // ── Gemini image-enhancement modal state ─────────────────────────────────
  //
  // Single-mode AI enhancement via the EnhanceModal: "rebuild" re-renders
  // each image as a clean studio shot. Hits /api/enhance-images; the
  // modal shows before/after per image and the seller picks which
  // version applies. Final picks are persisted via PATCH /api/listings/[id]
  // with a new images array, then router.refresh() so the rest of the
  // page sees the new URLs.
  //
  // Polish mode was removed from the UI in May 2026 because users found
  // the difference confusing; lib/gemini-image.ts still supports it for
  // future direct API use.
  const [enhanceMode, setEnhanceMode] = useState<EnhanceMode | null>(null);

  // If the user arrived from the Add-Product picker with ?enhance=rebuild,
  // auto-open the rebuild modal once images have settled. Only fires
  // once per mount — refreshes don't re-trigger.
  const autoEnhanceFired = useRef(false);
  useEffect(() => {
    if (autoEnhanceFired.current) return;
    if (searchParams.get("enhance") !== "rebuild") return;
    if ((listing.images?.length ?? 0) === 0) return;
    autoEnhanceFired.current = true;
    setEnhanceMode("rebuild");
  }, [listing.images, searchParams]);

  // ── Imagen 3 generate-from-scratch modal state (Business-only) ──────────
  //
  // Different from the enhance modal: this generates a brand-new
  // product photo from a text prompt via Google Imagen 3. Server
  // enforces Business-tier gate; we ask the quota engine here just to
  // decide whether to render the button at all (a Free user hitting
  // the button would just see an error toast — better to hide it).
  const [showGenerateImage, setShowGenerateImage] = useState(false);
  const [canGenerateImages, setCanGenerateImages] = useState(false);
  useEffect(() => {
    getQuotaSummaryForCurrentUser().then((q) => {
      if (!q) return;
      // Business + Admin only — mirrors canGenerateImagesFromScratch
      // in lib/billing/ai-models.ts.
      setCanGenerateImages(q.is_admin || q.plan === "business");
    });
  }, []);

  // ── Manual image upload / remove on the review page ────────────────────
  //
  // Sellers can add MORE photos after AI analysis (e.g. they only had one
  // shot at create-time, now they want to add another angle). The "+"
  // tiles in the 8-slot grid POST a file to /api/listings/[id]/images
  // which appends to listing.images and returns the new full array.
  const [imageBusy, setImageBusy] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);

  async function handleAddImage(file: File) {
    setImageBusy(true);
    setImageError(null);
    try {
      const fd = new FormData();
      fd.append("files", file);
      const res = await fetch(`/api/listings/${listing.id}/images`, {
        method: "POST",
        body:   fd,
      });
      const data = await res.json();
      if (!res.ok) {
        setImageError(data.error ?? `Upload failed (HTTP ${res.status})`);
        return;
      }
      // Server returned the new full array — push it back to the listing
      // row by routing-refresh. The server is the source of truth.
      router.refresh();
    } catch (e) {
      setImageError(e instanceof Error ? e.message : "Network error");
    } finally {
      setImageBusy(false);
    }
  }

  async function handleRemoveImage(url: string) {
    setImageBusy(true);
    setImageError(null);
    try {
      const res = await fetch(
        `/api/listings/${listing.id}/images?url=${encodeURIComponent(url)}`,
        { method: "DELETE" },
      );
      const data = await res.json();
      if (!res.ok) {
        setImageError(data.error ?? `Remove failed (HTTP ${res.status})`);
        return;
      }
      router.refresh();
    } catch (e) {
      setImageError(e instanceof Error ? e.message : "Network error");
    } finally {
      setImageBusy(false);
    }
  }

  async function handleApplyEnhancedImages(chosenUrls: string[]) {
    const res = await fetch(`/api/listings/${listing.id}`, {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ images: chosenUrls }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error((data as { error?: string }).error ?? "Couldn't apply image changes");
    }
    router.refresh();
  }

  // ── Quality score ─────────────────────────────────────────────────────────
  const [qualityResult, setQualityResult] = useState(() =>
    calculateQualityScore(listing, [], variants)
  );

  useEffect(() => {
    setQualityResult(calculateQualityScore(
      { ...listing, dynamic_attributes: dynAttrs },
      [],
      variants.map((v) => ({ globalPrice: v.globalPrice, quantity: v.quantity }))
    ));
  }, [dynAttrs, variants, listing]);

  // ── Scroll spy ────────────────────────────────────────────────────────────
  useEffect(() => {
    const sections: { id: StepId; ref: React.RefObject<HTMLDivElement> }[] = [
      { id: "info",     ref: infoRef },
      { id: "variants", ref: variantsRef },
      { id: "spec",     ref: specRef },
    ];
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length > 0) {
          // pick the topmost visible
          const top = visible.sort((a, b) =>
            a.boundingClientRect.top - b.boundingClientRect.top
          )[0];
          const id = sections.find((s) => s.ref.current === top.target)?.id;
          if (id) setActiveStep(id);
        }
      },
      { rootMargin: "-30% 0px -60% 0px" }
    );
    sections.forEach((s) => { if (s.ref.current) observer.observe(s.ref.current); });
    return () => observer.disconnect();
  }, []);

  const jumpTo = (id: StepId) => {
    const map = { info: infoRef, variants: variantsRef, spec: specRef };
    const el = map[id].current;
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // ── Save handler ──────────────────────────────────────────────────────────
  // Field-level validation matching Jumia API constraints — every check here
  // mirrors a known Jumia rejection reason. We surface them BEFORE submitting
  // instead of getting a 400 back from /feeds/products/create.
  const validationErrors: string[] = [];
  if (titleValue.length < 15)        validationErrors.push("Name must be at least 15 characters.");
  // Removed hard max — Jumia's spec doesn't enforce one and we don't want
  // to artificially gate Submit. Seller can write long descriptive names.
  // Description is now rich text (HTML); validate against the visible
  // body, not the markup, so wrapping a single short sentence in <p>…</p>
  // doesn't pass the 50-char minimum just because of tag bytes.
  const descriptionTextLength = stripHtml(descriptionValue).length;
  if (descriptionTextLength < 50)  validationErrors.push("Description must be at least 50 characters (Jumia hard limit).");
  if (descriptionTextLength > 9000) validationErrors.push("Description must be 9,000 characters or fewer.");
  if (!categoryCode)                 validationErrors.push("Pick a category.");
  if (!brandValue.trim())            validationErrors.push("Brand is required.");
  if ((listing.images ?? []).length === 0) validationErrors.push("At least 1 product image is required.");
  const canPublish = validationErrors.length === 0;

  async function handleSave(publish: boolean, opts?: { skipRedirect?: boolean }) {
    if (!formRef.current) return;
    if (publish && !canPublish) {
      setSaveError(validationErrors.join(" "));
      return;
    }
    if (publish && qualityResult.score < PUBLISH_THRESHOLD) {
      setSaveError(`Quality score ${qualityResult.score}/100 is below the minimum threshold of ${PUBLISH_THRESHOLD}.`);
      return;
    }

    setSaving(true);
    setSaveError(null);
    setJumiaNotConnected(false);
    // Publish-only: show the fullscreen panda loader while the POST is in
    // flight. Drafts save in the background — no overlay.
    if (publish) setPublishingPhase("pushing");

    // Single source of truth for the save payload:
    //   1. Four header-controlled fields (title / description / highlights / brand)
    //      → read directly from their useState values above.
    //   2. dynAttrs                  → fields stored in dynamic_attributes JSON.
    //   3. columnOverrides           → fields that map to first-class columns,
    //                                  routed through fieldChangeToUpdate() to
    //                                  pick up type coercion (numbers, arrays).
    // No FormData reads, no legacy mirror states. What the seller typed via
    // SchemaForm is exactly what gets persisted.
    const mergedDyn: Record<string, string> = { ...dynAttrs };

    const sellingPrice = variants[0]?.globalPrice
      ? parseFloat(variants[0].globalPrice)
      : (listing.selling_price ?? 0);

    // Walk every columnOverride through fieldChangeToUpdate so the column
    // gets the correct coerced value (e.g. weight_kg as number, not string;
    // certifications as string[] not "a, b").
    const overrideColumnUpdates: Record<string, unknown> = {};
    for (const [attr, val] of Object.entries(columnOverrides)) {
      const { columnUpdate } = fieldChangeToUpdate(attr, val);
      if (columnUpdate) Object.assign(overrideColumnUpdates, columnUpdate);
    }

    try {
      await updateListing(listing.id, {
        // Header-controlled (always set from controlled state)
        title:              titleValue.trim() || null,
        description:        descriptionValue.trim() || null,
        highlights:         highlightsValue.trim() || null,
        brand:              brandValue || null,
        // Category metadata
        category_code:      categoryCode,
        category_path:      categoryPath,
        // Variants-derived
        selling_price:      sellingPrice > 0 ? sellingPrice : null,
        ...(axesDef.length === 0 ? {
          quantity: Math.max(0, parseInt(variants[0]?.quantity ?? "1") || 1),
        } : {}),
        // Dynamic attributes (everything not column-mapped)
        dynamic_attributes: mergedDyn,
        // Quality + status
        quality_score:      qualityResult.score,
        status:             listing.status === "live" ? "live" : "draft",
        // Column-backed schema edits (winning spread — applies to color,
        // weight_kg, main_material, material_family, production_country,
        // warranty_*, model, product_line, certifications, youtube_id, etc.)
        ...overrideColumnUpdates,
      });

      // Persist the variants table from the UI's variant state. Surface
      // any failure to the seller instead of silently swallowing it — a
      // partial save here used to mean stale rows would get pushed to
      // Jumia in place of what was typed.
      try {
        await replaceVariantsForListing(
          listing.id,
          variants.map((v) => ({
            variation:       v.variation?.trim() || null,
            seller_sku:      v.sellerSku?.trim()  || null,
            gtin:            v.gtin?.trim()       || null,
            quantity:        Math.max(0, parseInt(v.quantity || "1") || 1),
            global_price:    v.globalPrice ? parseFloat(v.globalPrice) : null,
            sale_price:      v.salePrice   ? parseFloat(v.salePrice)   : null,
            sale_start_date: v.saleStartDate || null,
            sale_end_date:   v.saleEndDate   || null,
          })),
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Variant save failed";
        setSaveError(`Couldn't save variants: ${msg}. Please try again.`);
        return;
      }

      if (!publish) {
        if (!opts?.skipRedirect) router.push("/listings");
        return;
      }

      // Send variants in the push body FROM LOCAL UI STATE. The push API
      // uses these directly, bypassing the variants table — so whatever
      // the seller sees on screen at click time is literally what reaches
      // Jumia, regardless of any DB persistence timing. This is the core
      // guarantee: "what you see is what gets pushed."
      //
      // No filtering of empty rows here — the push API validates and
      // returns a clear "Variant N has no Variation label" error that
      // we surface verbatim in setSaveError below. That's better than
      // silently dropping rows the seller can see on screen.
      const pushVariants = variants.map((v) => ({
        variation:     v.variation?.trim()  || "",
        sellerSku:     v.sellerSku?.trim()  || `${listing.sku}-${v.id.slice(0, 4)}`,
        gtin:          v.gtin?.trim()       || null,
        quantity:      Math.max(0, parseInt(v.quantity || "1") || 1),
        globalPrice:   v.globalPrice ? parseFloat(v.globalPrice) : null,
        salePrice:     v.salePrice   ? parseFloat(v.salePrice)   : null,
        saleStartDate: v.saleStartDate || null,
        saleEndDate:   v.saleEndDate   || null,
      }));

      const pushRes = await fetch("/api/jumia/push", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          listingId: listing.id,
          variants:  pushVariants,
        }),
      });
      const pushData = await pushRes.json() as {
        success?:     boolean;
        error?:       string;
        jumia_ref?:   string;
        sku?:         string;
        sku_changed?: boolean;
      };

      if (pushRes.ok && pushData.success) {
        setPublishedRef(pushData.jumia_ref ?? null);
        if (pushData.sku) {
          setPublishedSku({ sku: pushData.sku, changed: Boolean(pushData.sku_changed) });
        }
        // Hold the panda loader for a few seconds before opening the
        // diagnose modal. Jumia's /feeds/{id} endpoint returns "queued"
        // for the first ~5-8s after a push — landing on the status modal
        // any sooner means the seller sees a useless "still processing"
        // panel, then has to click again to refresh. The settle phase
        // bridges that gap with a friendlier caption while we wait.
        setPublishingPhase("settling");
        await new Promise((r) => setTimeout(r, 8_000));
        // Auto-open the Jumia status modal on the listings page so the
        // seller sees the diagnosis result without an extra click.
        router.push(`/listings?diagnose=${listing.id}`);
      } else if (pushData.error?.includes("not connected") || pushRes.status === 403) {
        setJumiaNotConnected(true);
        setSaveError(pushData.error ?? "Jumia not connected");
        setPublishingPhase(null);
      } else {
        setSaveError(pushData.error ?? "Jumia submission failed.");
        setPublishingPhase(null);
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed.");
      // Errors during save/push: surface the message immediately, drop
      // the panda loader so the seller can fix things. router.push is
      // the only path that keeps the loader visible (it's about to
      // unmount this component anyway).
      setPublishingPhase(null);
    } finally {
      setSaving(false);
    }
  }

  // Variants helpers
  const updateVariant = (id: string, field: keyof VariantRow, value: string) => {
    setVariants((prev) => prev.map((v) => (v.id === id ? { ...v, [field]: value } : v)));
  };
  const toggleSelectVariant = (id: string) => {
    setSelectedVariants((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleCollapse = (id: string) => {
    setCollapsedVariants((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const collapseAll = () => setCollapsedVariants(new Set(variants.map((v) => v.id)));
  const selectAll   = () => setSelectedVariants(new Set(variants.map((v) => v.id)));
  const deleteVariant = (id: string) => {
    if (variants.length === 1) return;
    setVariants((p) => p.filter((v) => v.id !== id));
  };

  const completedSteps = new Set<StepId>();
  if (categoryCode) completedSteps.add("info");
  if (variants[0]?.globalPrice) completedSteps.add("variants");

  const sellingPrice = variants[0]?.globalPrice
    ? parseFloat(variants[0].globalPrice)
    : (listing.selling_price ?? 0);
  const netPayout = sellingPrice > 0 ? calcNetPayout(sellingPrice, commissionRate) : 0;

  // Active variant axes
  const addAxis = (attr: JumiaCategoryAttribute | { name: string; label: string; allowedValues: string[] }) => {
    const name = "name" in attr ? attr.name : (attr as { name: string }).name;
    if (axesDef.find((a) => a.name === name)) return;
    setAxesDef((p) => [...p, {
      name,
      label: "label" in attr ? attr.label : name,
      values: [],
      allowedValues: "allowed_values" in attr ? (attr as JumiaCategoryAttribute).allowed_values : [],
    }]);
  };
  const removeAxis = (name: string) => setAxesDef((p) => p.filter((a) => a.name !== name));
  const toggleAxisValue = (axisName: string, value: string) =>
    setAxesDef((p) => p.map((a) =>
      a.name === axisName
        ? { ...a, values: a.values.includes(value) ? a.values.filter((v) => v !== value) : [...a.values, value] }
        : a
    ));

  return (
    <div className="-m-4 sm:-m-6 lg:-m-8 min-h-[calc(100vh-3.5rem)] lg:min-h-screen bg-zinc-50 flex flex-col">
      {/* Full-screen publishing overlay. Shown only on publish flows —
          drafts save silently in the background. Two phases:
          - "pushing":   POST /api/jumia/push is in flight
          - "settling":  push succeeded, we're holding for Jumia's feed
                         to digest before navigating to the diagnose modal */}
      {publishingPhase && (
        <PublishingLoader
          // Same brand message for both pushing + settling phases —
          // sellers don't care about the internal handoff between
          // "POST in flight" vs "waiting for Jumia's feed to digest",
          // they care that PandaWorld is doing the work.
          caption="Automate your listings to Jumia With PandaWorld"
          subCaption=""
        />
      )}
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="bg-white border-b border-zinc-200 sticky top-0 z-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 py-3 space-y-2">
          {/* Breadcrumb */}
          <div className="flex items-center gap-1.5 text-xs text-zinc-500">
            <Link href="/listings" className="hover:text-zinc-700">Products</Link>
            <ChevronRight className="h-3 w-3" />
            <span>Add</span>
            <ChevronRight className="h-3 w-3" />
            {inBatch ? (
              <>
                <span>Batch</span>
                <ChevronRight className="h-3 w-3" />
                <span className="font-semibold text-orange-500">
                  prdt{currentBatchIdx + 1} of {batchIds.length}
                </span>
              </>
            ) : (
              <span className="font-semibold text-orange-500">Single Product</span>
            )}
          </div>
          {/* Title row */}
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" className="h-8 w-8 -ml-2" asChild>
              <Link href="/listings"><ArrowLeft className="h-4 w-4" /></Link>
            </Button>
            <h1 className="text-xl font-bold text-zinc-900 flex-1">
              {inBatch ? `Review prdt${currentBatchIdx + 1}` : "Add Products"}
            </h1>
            <QualityScoreBadge score={qualityResult.score} threshold={PUBLISH_THRESHOLD} issues={qualityResult.issues} />
          </div>

          {/* Batch product switcher — only when this listing came from a batch */}
          {inBatch && (
            <div className="flex items-center gap-1.5 overflow-x-auto -mx-1 px-1 pb-1">
              {batchIds.map((id, i) => {
                const isCurrent = id === listing.id;
                const sibling = batchSiblings.find((s) => s.id === id);
                // Status colour pill for at-a-glance progress
                const status   = sibling?.status ?? "draft";
                const statusOk = status === "live" || status === "pending_approval";
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      if (isCurrent) return;
                      router.push(`/listings/${id}/review${batchQuery}`);
                    }}
                    className={cn(
                      "shrink-0 inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                      isCurrent
                        ? "border-orange-500 bg-orange-50 text-orange-700"
                        : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50"
                    )}
                    title={sibling?.title || `Product ${i + 1}`}
                  >
                    <span className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      statusOk         ? "bg-emerald-500" :
                      status === "failed" ? "bg-red-500" :
                                           "bg-zinc-300"
                    )} />
                    prdt{i + 1}
                    {sibling?.title && !isCurrent && (
                      <span className="max-w-[120px] truncate text-zinc-400">
                        — {sibling.title}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Body ──────────────────────────────────────────────────────────── */}
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-6">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[180px_1fr]">

          {/* Sticky left rail */}
          <div className="hidden lg:block">
            <div className="sticky top-6">
              <StepRail active={activeStep} completed={completedSteps} onJump={jumpTo} />
            </div>
          </div>

          {/* Form */}
          <form ref={formRef} onSubmit={(e) => e.preventDefault()} className="space-y-8 pb-32">

            {/* Mobile step pills */}
            <div className="lg:hidden flex gap-2 overflow-x-auto -mx-4 px-4 pb-1">
              {STEP_DEFS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => jumpTo(s.id)}
                  className={cn(
                    "shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                    activeStep === s.id
                      ? "border-orange-500 bg-orange-50 text-orange-600"
                      : "border-zinc-200 bg-white text-zinc-500"
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>

            {/* Banners */}
            <AiAssistCard
              listing={listing}
              router={router}
              qualityScore={qualityResult.score}
              qualityIssues={qualityResult.issues}
              qualityThreshold={PUBLISH_THRESHOLD}
              analyzeStep={analyzeStep}
              analyzeError={analyzeError}
              analyzeResult={analyzeResult}
              analyzePrompt={analyzePrompt}
              onAnalyzePromptChange={setAnalyzePrompt}
              onAnalyzeStart={handleAutoAnalyze}
            />
            {publishedRef && (
              <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 space-y-1">
                <div className="flex items-center gap-3">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  Submitted to Jumia (feed ID: <code className="font-mono text-xs">{publishedRef}</code>).
                </div>
                {publishedSku?.changed && (
                  <p className="pl-7 text-[11px] text-emerald-700/80">
                    Note: this push was a retry, so we auto-bumped the seller SKU to{" "}
                    <code className="font-mono text-emerald-800">{publishedSku.sku}</code>{" "}
                    to avoid Jumia&apos;s duplicate-SKU check. This is the SKU Jumia knows.
                  </p>
                )}
              </div>
            )}
            {jumiaNotConnected && (
              <div className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="font-semibold">Jumia account not connected</p>
                  <Link href="/settings/integrations" className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-amber-800 hover:underline">
                    Connect now <ChevronRight className="h-3 w-3" />
                  </Link>
                </div>
              </div>
            )}

            {/* AI confidence banner + category alternates */}
            <AIConfidenceBanner
              listing={listing}
              currentCategoryCode={categoryCode}
              onSwitchCategory={handleCategoryChange}
            />

            {/* ────────────── Section 1: Product Information ────────────── */}
            <section ref={infoRef} className="bg-white rounded-md border border-zinc-200 p-6 space-y-5 scroll-mt-6">
              <h2 className="text-lg font-bold text-zinc-900">Product Information</h2>

              {/* Image grid — clickable "+" tiles upload to /api/listings/[id]/images */}
              <ImageGrid
                images={listing.images ?? []}
                onAdd={(file) => handleAddImage(file)}
                onRemove={(url) => handleRemoveImage(url)}
                busy={imageBusy}
              />
              {imageError && (
                <p className="text-xs text-red-600 -mt-1">{imageError}</p>
              )}

              {/* AI image features — TEMPORARILY DISABLED (May 2026).
                  Both "Rebuild as studio shot" (image-edit) and
                  "Generate from description" (text-to-image) panels
                  have been removed pending a model upgrade. They lived
                  in this block previously; restoring them is a single
                  revert when the better image model ships.

                  Modal mounts further down are kept conditionally so
                  the existing state hooks don't error — they're just
                  unreachable without the trigger buttons. */}

              {/* Name + Category */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="name" className="text-xs font-semibold text-zinc-700 flex items-center">
                    Name<Required />
                    <ConfidenceDot
                      source={listing.field_confidence?.["title"]?.source}
                      confidence={listing.field_confidence?.["title"]?.confidence}
                    />
                  </Label>
                  <Input
                    id="name"
                    name="name"
                    value={titleValue}
                    onChange={(e) => setTitleValue(e.target.value)}
                    placeholder="Ex: Wireless Noise-Cancelling Headphones [Clear product name for a better c..."
                    className={cn(
                      "h-10 text-sm",
                      titleValue.length > 0 && titleValue.length < 15 && "border-red-300 focus-visible:ring-red-300"
                    )}
                  />
                  <p className={cn(
                    "text-[11px]",
                    titleValue.length === 0 ? "text-zinc-400" :
                    titleValue.length < 15  ? "text-red-500"  :
                                              "text-emerald-600"
                  )}>
                    {titleValue.length} characters · min 15
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold text-zinc-700 flex items-center gap-2">
                    Category<Required />
                    {refillingAttributes && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-medium text-violet-700">
                        <Loader2 className="h-2.5 w-2.5 animate-spin" />
                        AI filling fields…
                      </span>
                    )}
                  </Label>
                  <button
                    type="button"
                    onClick={() => setShowCategoryPicker(true)}
                    disabled={refillingAttributes}
                    className={cn(
                      "flex h-10 w-full items-center justify-between rounded-md border bg-white px-3 text-sm text-left transition-colors",
                      categoryName
                        ? "border-orange-500 text-zinc-800"
                        : "border-zinc-200 text-zinc-400 hover:border-zinc-300",
                      refillingAttributes && "opacity-60 cursor-not-allowed"
                    )}
                  >
                    <span className="truncate">{categoryName || "Category"}</span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-zinc-400" />
                  </button>
                  {refillSuccess && !refillingAttributes && !refillError && (
                    <p className="text-[11px] text-emerald-600">{refillSuccess}</p>
                  )}
                  {refillError && (
                    <div className="flex items-start gap-1.5 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] text-red-700">
                      <AlertCircle className="h-3 w-3 shrink-0 mt-0.5" />
                      <div className="flex-1 break-words">
                        <span className="font-medium">AI fill failed:</span> {refillError}
                      </div>
                      <button
                        type="button"
                        onClick={() => setRefillError(null)}
                        className="text-red-500 hover:text-red-700 font-bold leading-none"
                        aria-label="Dismiss"
                      >
                        ×
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Schema-driven Product Information body. Renders the exact
                  fields Jumia's schema returns for the chosen category,
                  plus three guaranteed-universal fallbacks (brand,
                  description, highlights) for categories whose schemas
                  omit them. Matches Vendor Center 1:1. */}
              {categoryCode && (
                <SchemaForm
                  categoryCode={categoryCode}
                  listing={listing}
                  overrideValues={schemaFormOverrides}
                  onFieldChange={handleSchemaFieldChange}
                  fieldSources={listing.field_sources ?? undefined}
                  fieldConfidence={listing.field_confidence ?? undefined}
                  includeNames={PRODUCT_INFO_FIELDS}
                  excludeNames={[...STATIC_FIELDS, ...VARIANT_ATTRIBUTE_FIELDS]}
                  extraFields={universalInfoFields()}
                  excludeVariants
                  hideGroupHeadings
                  cols={4}
                  renderConfidenceDot={({ source, confidence }) =>
                    source ? (
                      <ConfidenceDot
                        source={source as "image" | "ocr" | "inferred" | "seller-required"}
                        confidence={confidence}
                      />
                    ) : null
                  }
                />
              )}

            </section>

            {/* ────────────── Section 2: Variants ────────────────────────── */}
            <section ref={variantsRef} className="bg-white rounded-md border border-zinc-200 p-6 space-y-4 scroll-mt-6">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-lg font-bold text-zinc-900">Variants</h2>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button type="button" size="sm" variant="outline" onClick={collapseAll} className="h-8 text-xs gap-1">
                    <ChevronDown className="h-3 w-3" /> Collapse All
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={selectAll} className="h-8 text-xs gap-1">
                    <ListChecks className="h-3 w-3" /> Select All
                  </Button>
                  <Button type="button" size="sm" variant="outline" disabled={selectedVariants.size === 0} className="h-8 text-xs gap-1">
                    <Clock className="h-3 w-3" /> Edit Date
                  </Button>
                  <Button type="button" size="sm" variant="outline" disabled={selectedVariants.size === 0} className="h-8 text-xs gap-1">
                    <Pencil className="h-3 w-3" /> Bulk Edit
                  </Button>
                </div>
              </div>

              {/* Variant axis selector */}
              {schemaAxes.length > 0 && (
                <div className="rounded-md border border-zinc-200 bg-zinc-50/50 p-3 space-y-2">
                  <p className="text-xs font-semibold text-zinc-600">Variant axes</p>
                  <div className="flex flex-wrap gap-1.5">
                    {schemaAxes.map((a) => {
                      const active = !!axesDef.find((x) => x.name === a.name);
                      return (
                        <button
                          key={a.name}
                          type="button"
                          onClick={() => active ? removeAxis(a.name) : addAxis(a)}
                          className={cn(
                            "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                            active
                              ? "border-orange-500 bg-orange-500 text-white"
                              : "border-zinc-200 bg-white text-zinc-600 hover:border-orange-300"
                          )}
                        >
                          {active && <Check className="inline h-3 w-3 mr-1" />}
                          {a.label}
                        </button>
                      );
                    })}
                  </div>
                  {axesDef.map((axis) => (
                    <div key={axis.name} className="space-y-1">
                      <p className="text-[11px] font-medium text-zinc-500">{axis.label} values</p>
                      <div className="flex flex-wrap gap-1">
                        {axis.allowedValues.map((v) => {
                          const sel = axis.values.includes(v);
                          return (
                            <button
                              key={v}
                              type="button"
                              onClick={() => toggleAxisValue(axis.name, v)}
                              className={cn(
                                "rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                                sel
                                  ? "border-orange-300 bg-orange-50 text-orange-700"
                                  : "border-zinc-200 bg-white text-zinc-500 hover:border-zinc-300"
                              )}
                            >
                              {sel && "✓ "}{v}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Variant cards */}
              <div className="space-y-3">
                {variants.map((v) => (
                  <VariantCard
                    key={v.id}
                    variant={v}
                    selected={selectedVariants.has(v.id)}
                    collapsed={collapsedVariants.has(v.id)}
                    onUpdate={(field, value) => updateVariant(v.id, field, value)}
                    onToggleSelect={() => toggleSelectVariant(v.id)}
                    onToggleCollapse={() => toggleCollapse(v.id)}
                    onDelete={() => deleteVariant(v.id)}
                  />
                ))}
              </div>

              <button
                type="button"
                onClick={() => {
                  // Add a new empty variant card. SKU auto-numbered. User
                  // fills the variation label themselves (e.g. "Black /
                  // 64GB"). Inherits Global Price from the first variant so
                  // they don't have to re-type it.
                  const newId = `v-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
                  const suffix = String(variants.length + 1).padStart(2, "0");
                  setVariants((prev) => [
                    ...prev,
                    {
                      id:            newId,
                      axes:          {},
                      variation:     "",
                      sellerSku:     `${listing.sku}-${suffix}`,
                      gtin:          "",
                      quantity:      "1",
                      globalPrice:   prev[0]?.globalPrice ?? "",
                      salePrice:     "",
                      saleStartDate: "",
                      saleEndDate:   "",
                    },
                  ]);
                }}
                className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-zinc-300 bg-white py-3 text-xs font-semibold text-orange-500 hover:border-orange-300 hover:bg-orange-50 transition-colors"
              >
                <Plus className="h-3.5 w-3.5" /> ADD VARIATION
              </button>

            </section>

            {/* ────────────── Section 3: Product Specification ──────────────
                100% driven by Jumia's category schema. The SchemaForm
                component fetches GET /api/jumia/categories/{code}/attributes
                and renders every field with the correct type (text, number,
                date, multi-select, etc.). Backing store is decided per-field
                by lib/jumia/attribute-mapping — universal fields land in
                their first-class column; category-specific ones go into
                dynamic_attributes.
            */}
            <section ref={specRef} className="bg-white rounded-md border border-zinc-200 p-6 space-y-5 scroll-mt-6">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-lg font-bold text-zinc-900">Product Specification</h2>
                <span className="text-[10px] uppercase tracking-wider text-zinc-400">
                  Live from Jumia
                </span>
              </div>

              <SchemaForm
                categoryCode={categoryCode}
                listing={listing}
                overrideValues={schemaFormOverrides}
                onFieldChange={handleSchemaFieldChange}
                fieldSources={listing.field_sources ?? undefined}
                fieldConfidence={listing.field_confidence ?? undefined}
                excludeNames={[...PRODUCT_INFO_FIELDS, ...STATIC_FIELDS, ...VARIANT_ATTRIBUTE_FIELDS]}
                excludeVariants
                onFillWithAI={handleFillWithAI}
                fillWithAILoading={refillingAttributes}
                collapseHighConfidence
                renderConfidenceDot={({ source, confidence }) =>
                  source ? (
                    <ConfidenceDot
                      source={source as "image" | "ocr" | "inferred" | "seller-required"}
                      confidence={confidence}
                    />
                  ) : null
                }
              />
            </section>


            {/* Inline error */}
            {saveError && !jumiaNotConnected && (
              <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                {saveError}
              </div>
            )}
          </form>
        </div>
      </div>

      {/* ── Floating Submit (bottom-right) ─────────────────────────────────── */}
      <div className="fixed bottom-6 right-6 z-30 flex flex-col items-end gap-2">
        {/* Field-level validation chip — only shown when blocking publish */}
        {!canPublish && (
          <div className="max-w-sm rounded-md bg-white border border-red-200 px-3 py-2 text-[11px] text-red-700 shadow-sm space-y-1">
            <p className="font-semibold flex items-center gap-1">
              <AlertCircle className="h-3 w-3" /> {validationErrors.length} issue{validationErrors.length === 1 ? "" : "s"} to fix
            </p>
            <ul className="space-y-0.5 pl-1">
              {validationErrors.slice(0, 3).map((e, i) => (
                <li key={i}>• {e}</li>
              ))}
              {validationErrors.length > 3 && (
                <li className="text-red-500">+{validationErrors.length - 3} more</li>
              )}
            </ul>
          </div>
        )}

        <div className="flex items-center gap-2">
          {syncStatus === "done"  && <span className="rounded-md bg-white border px-3 py-1 text-xs text-emerald-600 shadow-sm">✓ Submitted</span>}
          {canPublish && qualityResult.score < PUBLISH_THRESHOLD && (
            <span className="rounded-md bg-white border border-amber-200 px-3 py-1.5 text-[11px] text-amber-700 shadow-sm">
              Quality {qualityResult.score}/{PUBLISH_THRESHOLD} — see Fix with AI above
            </span>
          )}
          <Button
            type="button"
            size="lg"
            onClick={() => handleSave(true)}
            disabled={saving || !canPublish || qualityResult.score < PUBLISH_THRESHOLD}
            className="bg-orange-500 hover:bg-orange-600 text-white shadow-lg shadow-orange-500/30 disabled:bg-zinc-200 disabled:text-zinc-400 disabled:shadow-none gap-2 px-8"
            title={!canPublish ? validationErrors.join(" • ") : ""}
          >
            {saving
              ? <><Loader2 className="h-4 w-4 animate-spin" /> Submitting…</>
              : "Submit"}
          </Button>
        </div>
      </div>

      {/* Category drawer (Jumia-style slide-in) */}
      <CategoryDrawer
        open={showCategoryPicker}
        onClose={() => setShowCategoryPicker(false)}
        onSelect={handleCategoryChange}
        initialPath={categoryPath ?? undefined}
      />

      {/* Gemini image-enhancement modal — opens from the Polish / Rebuild
          buttons above the image grid. Renders before/after pairs and
          calls onApply with the seller's per-image picks. */}
      {enhanceMode && (
        <EnhanceModal
          open={true}
          mode={enhanceMode}
          listingId={listing.id}
          onClose={() => setEnhanceMode(null)}
          onApply={handleApplyEnhancedImages}
        />
      )}

      {/* Imagen 3 — generate a product photo from text. Business-only.
          Server enforces the tier gate so non-Business users hitting
          this would just see an error; we hide the trigger entirely. */}
      {showGenerateImage && (
        <GenerateImageModal
          listingId={listing.id}
          onApplied={() => { /* router.refresh() runs inside the modal */ }}
          onClose={() => setShowGenerateImage(false)}
        />
      )}
    </div>
  );
}
