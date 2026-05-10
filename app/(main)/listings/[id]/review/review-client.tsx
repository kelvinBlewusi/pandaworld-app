"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Sparkles,
  Check,
  Save,
  RefreshCw,
  ChevronRight,
  Plus,
  Trash2,
  CalendarIcon,
  Star,
  Loader2,
  AlertCircle,
  Tag,
  Search,
  X,
  ShieldAlert,
  CheckCircle2,
  Info,
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
import { StatusPill } from "@/components/ui/status-pill";
import { MarketplaceBadge } from "@/components/ui/marketplace-badge";
import {
  mockCategories,
  colorFamilies,
  warrantyTypes,
  warrantyDurations,
  materialFamilies,
  certifications,
  productionCountries,
  calcNetPayout,
} from "@/lib/mock/categories";
import { formatGHS, cn } from "@/lib/utils";
import { motion } from "framer-motion";
import type { ListingRow } from "@/lib/supabase/types";
import { updateListing } from "@/lib/actions/listings";
import { calculateQualityScore, scoreLabel, scoreColor, DEFAULT_THRESHOLD } from "@/lib/quality-score";
import { isValidGTIN } from "@/lib/utils/gtin";
import type { JumiaCategoryAttribute } from "@/lib/jumia/categories";

// ─── Auto-SKU ─────────────────────────────────────────────────────────────────

function abbr(v: string, n = 4) {
  return v.replace(/\s+/g, "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, n);
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface VariantRow {
  id: string;
  axes: Record<string, string>;  // e.g. { color: "Black", ram: "8GB" }
  sellerSku: string;
  gtin: string;
  quantity: string;
  globalPrice: string;
  salePrice: string;
  saleStartDate: string;
  saleEndDate: string;
}

// ─── Quality score badge ──────────────────────────────────────────────────────

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

// ─── Field badges ─────────────────────────────────────────────────────────────

function RequiredBadge() {
  return <span className="ml-1 text-red-500">*</span>;
}

function QualityBadge() {
  return (
    <span className="ml-1.5 inline-flex items-center gap-0.5 rounded-full bg-amber-50 px-1.5 py-0.5 text-[9px] font-semibold text-amber-600 border border-amber-200">
      <Star className="h-2.5 w-2.5" /> quality
    </span>
  );
}

function AIBadge({ onRegenerate }: { onRegenerate?: () => void }) {
  return (
    <span className="ml-1.5 inline-flex items-center gap-0.5 rounded-full bg-blue-50 px-1.5 py-0.5 text-[9px] font-semibold text-blue-600 border border-blue-200">
      <Sparkles className="h-2.5 w-2.5" /> AI
      {onRegenerate && (
        <button
          type="button"
          onClick={onRegenerate}
          className="ml-0.5 rounded hover:text-blue-800"
          title="Regenerate this field"
        >
          <RefreshCw className="h-2.5 w-2.5" />
        </button>
      )}
    </span>
  );
}

// ─── Brand combobox ───────────────────────────────────────────────────────────

function BrandCombobox({
  value,
  onChange,
  isAI,
  onMarkEdited,
}: {
  value: string;
  onChange: (v: string) => void;
  isAI?: boolean;
  onMarkEdited?: () => void;
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
        const res = await fetch(`/api/jumia/brands?q=${encodeURIComponent(q)}`);
        const data = await res.json() as { brands: { code: number; name: string }[] };
        setResults(data.brands ?? []);
        setOpen(true);
      } catch { setResults([]); }
      finally { setLoading(false); }
    }, 300);
  }, []);

  return (
    <div className="relative space-y-1.5">
      <Label className="flex items-center">
        Brand
        {isAI && <AIBadge />}
      </Label>
      <div className="relative">
        <Input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            onChange(e.target.value);
            onMarkEdited?.();
            search(e.target.value);
          }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="Brand name (type to search Jumia catalog)"
          className="pr-7"
        />
        {loading && (
          <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 animate-spin text-zinc-400" />
        )}
      </div>
      {open && results.length > 0 && (
        <div className="absolute z-10 w-full rounded-lg border bg-white shadow-lg max-h-48 overflow-y-auto">
          {results.map((b) => (
            <button
              key={b.code}
              type="button"
              className="w-full px-3 py-2 text-left text-sm hover:bg-zinc-50 border-b last:border-b-0"
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(b.name);
                setQuery(b.name);
                setOpen(false);
                onMarkEdited?.();
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

// ─── Category picker modal ────────────────────────────────────────────────────

interface CategoryItem {
  code: number;
  name: string;
  path: string;
}

function CategoryPickerModal({
  onSelect,
  onClose,
}: {
  onSelect: (cat: CategoryItem) => void;
  onClose: () => void;
}) {
  const [categories, setCategories] = useState<CategoryItem[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/jumia/categories")
      .then((r) => r.json())
      .then((d) => setCategories(d.categories ?? []))
      .catch(() => setCategories([]))
      .finally(() => setLoading(false));
  }, []);

  const filtered = query
    ? categories.filter(
        (c) =>
          c.name.toLowerCase().includes(query.toLowerCase()) ||
          c.path.toLowerCase().includes(query.toLowerCase())
      )
    : categories;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="mx-4 w-full max-w-lg rounded-2xl border bg-white shadow-xl flex flex-col max-h-[80vh]">
        <div className="flex items-center justify-between p-4 border-b">
          <p className="font-semibold text-zinc-900">Change category</p>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-3 border-b">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
            <Input
              autoFocus
              placeholder="Search categories…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-9"
            />
          </div>
        </div>
        <div className="overflow-y-auto flex-1">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-zinc-400">
              <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading…
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-10 text-center text-sm text-zinc-400">
              {categories.length === 0
                ? "No categories synced yet. Go to Settings → Integrations → Sync now."
                : "No results for that query."}
            </div>
          ) : (
            filtered.map((cat) => (
              <button
                key={cat.code}
                type="button"
                onClick={() => { onSelect(cat); onClose(); }}
                className="w-full px-4 py-3 text-left border-b last:border-b-0 hover:bg-orange-50 transition-colors"
              >
                <p className="text-sm font-medium text-zinc-800">{cat.name}</p>
                <p className="text-xs text-zinc-400 mt-0.5">{cat.path}</p>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Rich-text field ─────────────────────────────────────────────────────────

function RichTextField({
  id,
  label,
  placeholder,
  defaultValue,
  required,
  quality,
  isAI,
  hint,
  rows = 4,
  onMarkEdited,
}: {
  id: string;
  label: string;
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
  quality?: boolean;
  isAI?: boolean;
  hint?: string;
  rows?: number;
  onMarkEdited?: () => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="flex items-center">
        {label}
        {required && <RequiredBadge />}
        {quality && <QualityBadge />}
        {isAI && <AIBadge />}
      </Label>
      <div className="flex items-center gap-1 rounded-t-lg border border-b-0 bg-zinc-50 px-2 py-1.5">
        {["B", "I", "•", "⁋"].map((t) => (
          <button
            key={t}
            type="button"
            className="rounded px-1.5 py-0.5 text-[11px] font-bold text-zinc-500 hover:bg-zinc-200"
          >
            {t}
          </button>
        ))}
        <span className="ml-1 text-[10px] text-zinc-400">(Rich text — Phase 2)</span>
      </div>
      <Textarea
        id={id}
        name={id}
        placeholder={placeholder}
        defaultValue={defaultValue}
        rows={rows}
        className="rounded-t-none"
        onChange={onMarkEdited}
      />
      {hint && <p className="text-[11px] text-zinc-400">{hint}</p>}
    </div>
  );
}

// ─── Step 1 — Product Information ─────────────────────────────────────────────

function ProductInformationStep({
  listing,
  colorFamily,
  setColorFamily,
  fieldSources,
  onMarkEdited,
  brandValue,
  onBrandChange,
  onCategoryChange,
}: {
  listing: ListingRow;
  colorFamily: string;
  setColorFamily: (v: string) => void;
  fieldSources: Record<string, string>;
  onMarkEdited: (field: string) => void;
  brandValue: string;
  onBrandChange: (v: string) => void;
  onCategoryChange: (cat: { code: number; name: string; path: string }) => void;
}) {
  const [showCategoryPicker, setShowCategoryPicker] = useState(false);
  const images = listing.images ?? [];
  const imageSlots = Array.from({ length: 8 }, (_, i) => images[i] ?? null);

  return (
    <div className="space-y-6">
      {/* Image grid */}
      <div className="space-y-2">
        <Label className="flex items-center">
          Product Images <RequiredBadge />
        </Label>
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
          {imageSlots.map((imgUrl, idx) => (
            <div
              key={idx}
              className={cn(
                "group relative flex aspect-square cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border-2 transition-all overflow-hidden",
                imgUrl
                  ? "border-solid border-zinc-200 bg-zinc-50"
                  : idx === 0
                  ? "border-dashed border-orange-300 bg-orange-50 hover:bg-orange-100"
                  : "border-dashed border-zinc-200 bg-zinc-50 hover:border-zinc-300 hover:bg-zinc-100"
              )}
            >
              {imgUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={imgUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <>
                  <Plus className={cn("h-5 w-5", idx === 0 ? "text-orange-400" : "text-zinc-400")} />
                  <span className={cn("text-[9px] font-medium", idx === 0 ? "text-orange-500" : "text-zinc-400")}>
                    {idx === 0 ? "Main Image" : "Image"}
                  </span>
                </>
              )}
            </div>
          ))}
        </div>
        <p className="text-[11px] text-zinc-400">
          500×500 – 2000×2000 px · white background · no watermarks · max 2MB · JPG/PNG/WEBP
        </p>
      </div>

      {/* Basic fields */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="name" className="flex items-center">
            Product Name <RequiredBadge />
            {fieldSources["title"] === "ai" && <AIBadge />}
          </Label>
          <Input
            id="name"
            name="name"
            defaultValue={listing.title ?? ""}
            placeholder="Ex: Wireless Noise-Cancelling Headphones"
            maxLength={70}
            onChange={() => onMarkEdited("title")}
          />
          <p className="text-[11px] text-zinc-400">
            15–70 characters · Currently {(listing.title ?? "").length} chars
          </p>
        </div>

        <div className="space-y-1.5">
          <Label className="flex items-center">Category <RequiredBadge /></Label>
          <div className="flex gap-2">
            <div className="flex-1 rounded-lg border bg-zinc-50 px-3 py-2 text-sm text-zinc-700 truncate">
              {listing.category_path ?? listing.category_id ?? "Uncategorised"}
            </div>
            <button
              type="button"
              onClick={() => setShowCategoryPicker(true)}
              className="flex items-center gap-1 rounded-lg border px-3 py-2 text-xs font-medium text-blue-600 hover:bg-blue-50"
            >
              Change <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
          <p className="text-[11px] text-zinc-400">{listing.category_path ?? ""}</p>
        </div>

        <BrandCombobox
          value={brandValue}
          onChange={onBrandChange}
          isAI={fieldSources["brand"] === "ai"}
          onMarkEdited={() => onMarkEdited("brand")}
        />

        <div className="space-y-1.5">
          <Label htmlFor="color" className="flex items-center">
            Color <RequiredBadge />
            {fieldSources["color"] === "ai" && <AIBadge />}
          </Label>
          <Input
            id="color"
            name="color"
            defaultValue={listing.color ?? ""}
            placeholder="Main color of product"
            onChange={() => onMarkEdited("color")}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="color-family" className="flex items-center">
            Color Family <QualityBadge />
            {fieldSources["color_family"] === "ai" && <AIBadge />}
          </Label>
          <Select value={colorFamily} onValueChange={(v) => { setColorFamily(v); onMarkEdited("color_family"); }}>
            <SelectTrigger id="color-family">
              <SelectValue placeholder="Ex: Black" />
            </SelectTrigger>
            <SelectContent>
              {colorFamilies.map((c) => (
                <SelectItem key={c} value={c}>{c}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-amber-600">Required to increase listing quality</p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="weight" className="flex items-center">
            Weight (kg) <QualityBadge />
            {fieldSources["weight_kg"] === "ai" && <AIBadge />}
          </Label>
          <Input
            id="weight"
            name="weight"
            type="number"
            step="0.01"
            min="0"
            defaultValue={listing.weight_kg?.toString() ?? ""}
            placeholder="Ex: 1.2"
            onChange={() => onMarkEdited("weight_kg")}
          />
        </div>
      </div>

      <RichTextField
        id="description"
        label="Product Description"
        required
        isAI={fieldSources["description"] === "ai"}
        placeholder="Include only product-related information. Write clearly and concisely."
        defaultValue={listing.description ?? ""}
        rows={5}
        hint="Minimum 80 characters. Aim for 200+ for a good quality score."
        onMarkEdited={() => onMarkEdited("description")}
      />

      <RichTextField
        id="highlights"
        label="Highlights"
        quality
        isAI={fieldSources["highlights"] === "ai"}
        placeholder="Key features in bullet points. Ex: • Lightweight design • Noise cancellation"
        defaultValue={listing.highlights ?? ""}
        rows={4}
        hint="At least 4 bullets starting with • for a good content score."
        onMarkEdited={() => onMarkEdited("highlights")}
      />

      {showCategoryPicker && (
        <CategoryPickerModal
          onSelect={onCategoryChange}
          onClose={() => setShowCategoryPicker(false)}
        />
      )}
    </div>
  );
}

// ─── Step 2 — Variant Matrix ──────────────────────────────────────────────────

interface AxisDef {
  name: string;
  label: string;
  values: string[];        // selected values for this axis
  allowedValues: string[]; // from attribute schema
}

function VariantMatrixStep({
  baseSku,
  categoryCode,
  variants,
  setVariants,
  axesDef,
  setAxesDef,
  commissionRate,
  commissionPercent,
}: {
  baseSku: string;
  categoryCode: string | null;
  variants: VariantRow[];
  setVariants: React.Dispatch<React.SetStateAction<VariantRow[]>>;
  axesDef: AxisDef[];
  setAxesDef: React.Dispatch<React.SetStateAction<AxisDef[]>>;
  commissionRate: number;
  commissionPercent: number;
}) {
  const [schemaAxes, setSchemaAxes] = useState<JumiaCategoryAttribute[]>([]);
  const [loadingAxes, setLoadingAxes] = useState(false);
  const [customAxisInput, setCustomAxisInput] = useState("");

  // Load variant axes from category schema
  useEffect(() => {
    if (!categoryCode || isNaN(Number(categoryCode))) return;
    setLoadingAxes(true);
    fetch(`/api/jumia/categories/${categoryCode}/attributes`)
      .then((r) => r.json())
      .then((d) => {
        const all = (d.attributes ?? []) as JumiaCategoryAttribute[];
        setSchemaAxes(all.filter((a) => a.is_variant));
      })
      .catch(() => setSchemaAxes([]))
      .finally(() => setLoadingAxes(false));
  }, [categoryCode]);

  // Rebuild variant matrix whenever axes definitions change
  useEffect(() => {
    if (axesDef.length === 0) {
      setVariants([{
        id: "v1", axes: {}, sellerSku: baseSku,
        gtin: "", quantity: "1", globalPrice: "", salePrice: "",
        saleStartDate: "", saleEndDate: "",
      }]);
      return;
    }

    // Compute cartesian product of selected values
    const combinations = axesDef.reduce<Record<string, string>[]>(
      (acc, axis) => {
        if (!axis.values.length) return acc;
        return acc.flatMap((combo) =>
          axis.values.map((v) => ({ ...combo, [axis.name]: v }))
        );
      },
      [{}]
    );

    if (combinations.length === 0) return;

    setVariants((prev) =>
      combinations.map((combo) => {
        const key = Object.values(combo).map((v) => abbr(v)).join("-");
        const existing = prev.find(
          (p) => JSON.stringify(p.axes) === JSON.stringify(combo)
        );
        return existing ?? {
          id: `v-${key}-${Math.random().toString(36).slice(2, 6)}`,
          axes: combo,
          sellerSku: `${baseSku}-${key}`,
          gtin: "",
          quantity: "1",
          globalPrice: prev[0]?.globalPrice ?? "",
          salePrice: "",
          saleStartDate: "",
          saleEndDate: "",
        };
      })
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [axesDef, baseSku]);

  const addAxis = (attr: JumiaCategoryAttribute | { name: string; label: string; allowedValues: string[] }) => {
    const name = "name" in attr ? attr.name : (attr as {name:string}).name;
    if (axesDef.find((a) => a.name === name)) return;
    setAxesDef((prev) => [
      ...prev,
      {
        name,
        label: "label" in attr ? attr.label : name,
        values: [],
        allowedValues: "allowed_values" in attr ? (attr as JumiaCategoryAttribute).allowed_values : [],
      },
    ]);
  };

  const removeAxis = (name: string) => {
    setAxesDef((prev) => prev.filter((a) => a.name !== name));
  };

  const toggleValue = (axisName: string, value: string) => {
    setAxesDef((prev) =>
      prev.map((a) =>
        a.name === axisName
          ? {
              ...a,
              values: a.values.includes(value)
                ? a.values.filter((v) => v !== value)
                : [...a.values, value],
            }
          : a
      )
    );
  };

  const updateVariant = (id: string, field: keyof VariantRow, value: string) => {
    setVariants((prev) => prev.map((v) => (v.id === id ? { ...v, [field]: value } : v)));
  };

  return (
    <div className="space-y-6">
      {/* Axis selector */}
      <div className="space-y-3">
        <p className="text-xs font-semibold uppercase tracking-widest text-zinc-400">Variant dimensions</p>

        {loadingAxes ? (
          <div className="flex items-center gap-2 text-sm text-zinc-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading variant axes…
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {schemaAxes.map((attr) => {
              const active = !!axesDef.find((a) => a.name === attr.name);
              return (
                <button
                  key={attr.name}
                  type="button"
                  onClick={() => active ? removeAxis(attr.name) : addAxis(attr)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                    active
                      ? "bg-orange-500 border-orange-500 text-white"
                      : "border-zinc-200 text-zinc-500 hover:border-orange-300 hover:text-orange-600"
                  )}
                >
                  {active && <Check className="inline h-3 w-3 mr-1" />}
                  {attr.label}
                </button>
              );
            })}

            {/* Custom axis input */}
            <div className="flex items-center gap-1">
              <Input
                value={customAxisInput}
                onChange={(e) => setCustomAxisInput(e.target.value)}
                placeholder="Custom axis…"
                className="h-7 w-28 text-xs"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && customAxisInput.trim()) {
                    addAxis({ name: customAxisInput.toLowerCase().replace(/\s+/g, "_"), label: customAxisInput, allowedValues: [] });
                    setCustomAxisInput("");
                  }
                }}
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-xs px-2"
                onClick={() => {
                  if (customAxisInput.trim()) {
                    addAxis({ name: customAxisInput.toLowerCase().replace(/\s+/g, "_"), label: customAxisInput, allowedValues: [] });
                    setCustomAxisInput("");
                  }
                }}
              >
                <Plus className="h-3 w-3" />
              </Button>
            </div>
          </div>
        )}

        {/* Value pickers for each selected axis */}
        {axesDef.map((axis) => (
          <div key={axis.name} className="rounded-xl border bg-zinc-50/50 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-zinc-600">{axis.label} values</p>
              <button type="button" onClick={() => removeAxis(axis.name)} className="text-zinc-400 hover:text-red-500">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {axis.allowedValues.map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => toggleValue(axis.name, v)}
                  className={cn(
                    "rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors",
                    axis.values.includes(v)
                      ? "bg-orange-100 border-orange-300 text-orange-700"
                      : "bg-white border-zinc-200 text-zinc-500 hover:border-zinc-300"
                  )}
                >
                  {axis.values.includes(v) && "✓ "}
                  {v}
                </button>
              ))}
              {/* Free-text value input when no allowed_values */}
              {axis.allowedValues.length === 0 && (
                <FreeValueInput
                  values={axis.values}
                  onAdd={(v) => toggleValue(axis.name, v)}
                  onRemove={(v) => toggleValue(axis.name, v)}
                />
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Variant grid */}
      {variants.length > 0 && axesDef.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-widest text-zinc-400">
            {variants.length} combination{variants.length !== 1 ? "s" : ""}
          </p>
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full text-xs">
              <thead className="bg-zinc-50 border-b">
                <tr>
                  {axesDef.map((a) => (
                    <th key={a.name} className="px-3 py-2 text-left font-semibold text-zinc-600">{a.label}</th>
                  ))}
                  <th className="px-3 py-2 text-left font-semibold text-zinc-600">Seller SKU</th>
                  <th className="px-3 py-2 text-left font-semibold text-zinc-600">GTIN</th>
                  <th className="px-3 py-2 text-left font-semibold text-zinc-600">Qty</th>
                  <th className="px-3 py-2 text-left font-semibold text-zinc-600">Price (GHS)</th>
                  <th className="px-3 py-2 text-left font-semibold text-zinc-600">Sale Price</th>
                  <th className="px-3 py-2 text-left font-semibold text-zinc-600">Net Payout</th>
                </tr>
              </thead>
              <tbody>
                {variants.map((v) => {
                  const net = v.globalPrice ? calcNetPayout(parseFloat(v.globalPrice), commissionRate) : null;
                  const gtinOk = !v.gtin || isValidGTIN(v.gtin);
                  return (
                    <tr key={v.id} className="border-b last:border-b-0 hover:bg-zinc-50/50">
                      {axesDef.map((a) => (
                        <td key={a.name} className="px-3 py-2 font-medium text-zinc-700">
                          {v.axes[a.name] ?? "—"}
                        </td>
                      ))}
                      <td className="px-3 py-2">
                        <Input
                          value={v.sellerSku}
                          onChange={(e) => updateVariant(v.id, "sellerSku", e.target.value)}
                          className="h-7 w-32 text-xs font-mono"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <div className="relative">
                          <Input
                            value={v.gtin}
                            onChange={(e) => updateVariant(v.id, "gtin", e.target.value)}
                            placeholder="EAN/UPC"
                            className={cn("h-7 w-32 text-xs", v.gtin && !gtinOk && "border-red-300 focus-visible:ring-red-300")}
                          />
                          {v.gtin && !gtinOk && (
                            <AlertCircle className="absolute right-1.5 top-1/2 -translate-y-1/2 h-3 w-3 text-red-400" />
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <Input
                          type="number"
                          min="0"
                          value={v.quantity}
                          onChange={(e) => updateVariant(v.id, "quantity", e.target.value)}
                          className="h-7 w-16 text-xs"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          value={v.globalPrice}
                          onChange={(e) => updateVariant(v.id, "globalPrice", e.target.value)}
                          className="h-7 w-24 text-xs"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          value={v.salePrice}
                          onChange={(e) => updateVariant(v.id, "salePrice", e.target.value)}
                          className="h-7 w-24 text-xs"
                          placeholder="optional"
                        />
                      </td>
                      <td className="px-3 py-2 text-emerald-600 font-semibold whitespace-nowrap">
                        {net != null ? formatGHS(net) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Simple listing: price + stock (no variant axes) */}
      {axesDef.length === 0 && (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="simple-price" className="flex items-center">
                Selling Price (GHS) <span className="ml-1 text-[10px] font-semibold text-rose-500">*</span>
              </Label>
              <Input
                id="simple-price"
                type="number"
                min="0"
                step="0.01"
                value={variants[0]?.globalPrice ?? ""}
                onChange={(e) => updateVariant(variants[0]?.id ?? "v1", "globalPrice", e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="simple-qty">Stock Quantity</Label>
              <Input
                id="simple-qty"
                type="number"
                min="0"
                value={variants[0]?.quantity ?? "1"}
                onChange={(e) => updateVariant(variants[0]?.id ?? "v1", "quantity", e.target.value)}
                placeholder="1"
              />
              <p className="text-[11px] text-zinc-400">Units available to sell on Jumia</p>
            </div>
          </div>
          <div className="rounded-xl border border-dashed border-zinc-200 p-4 text-center space-y-1">
            <p className="text-xs text-zinc-400">
              {schemaAxes.length > 0
                ? `${schemaAxes.length} variant attribute${schemaAxes.length !== 1 ? "s" : ""} available — add a variant axis above to create combinations.`
                : categoryCode
                ? "No variant axes in the category schema. You can add a custom axis above."
                : "Category not set — select a category first to see variant options."}
            </p>
          </div>
        </div>
      )}

      <p className="text-xs text-zinc-400 flex items-start gap-1">
        <Info className="h-3 w-3 shrink-0 mt-0.5" />
        Commission shown at {commissionPercent}% (incl. VAT). GTIN must be a valid EAN-8/13, UPC-12, or GTIN-14.
      </p>
    </div>
  );
}

// Small helper: free-text value chip input
function FreeValueInput({
  values,
  onAdd,
  onRemove,
}: {
  values: string[];
  onAdd: (v: string) => void;
  onRemove: (v: string) => void;
}) {
  const [input, setInput] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-1">
      {values.map((v) => (
        <span key={v} className="flex items-center gap-0.5 rounded-full bg-orange-100 border border-orange-300 px-2 py-0.5 text-[11px] text-orange-700">
          {v}
          <button type="button" onClick={() => onRemove(v)} className="ml-0.5"><X className="h-2.5 w-2.5" /></button>
        </span>
      ))}
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Add value…"
        className="h-6 w-24 rounded border border-zinc-200 px-2 text-[11px] focus:outline-none focus:ring-1 focus:ring-orange-300"
        onKeyDown={(e) => {
          if (e.key === "Enter" && input.trim()) {
            onAdd(input.trim());
            setInput("");
          }
        }}
      />
    </div>
  );
}

// ─── Step 3 — Product Specification ──────────────────────────────────────────

function ProductSpecificationStep({
  listing,
  certification,
  setCertification,
  materialFamily,
  setMaterialFamily,
  productionCountry,
  setProductionCountry,
  warrantyDuration,
  setWarrantyDuration,
  warrantyType,
  setWarrantyType,
  fieldSources,
  onMarkEdited,
}: {
  listing: ListingRow;
  certification: string;
  setCertification: (v: string) => void;
  materialFamily: string;
  setMaterialFamily: (v: string) => void;
  productionCountry: string;
  setProductionCountry: (v: string) => void;
  warrantyDuration: string;
  setWarrantyDuration: (v: string) => void;
  warrantyType: string;
  setWarrantyType: (v: string) => void;
  fieldSources: Record<string, string>;
  onMarkEdited: (field: string) => void;
}) {
  return (
    <div className="space-y-5">
      <div>
        <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-zinc-400">Material & Construction</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="material" className="flex items-center">
              Main Material <QualityBadge />
              {fieldSources["main_material"] === "ai" && <AIBadge />}
            </Label>
            <Input
              id="material" name="material"
              defaultValue={listing.main_material ?? ""}
              placeholder="Ex: Stainless Steel"
              onChange={() => onMarkEdited("main_material")}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="material-family" className="flex items-center">
              Material Family <QualityBadge />
              {fieldSources["material_family"] === "ai" && <AIBadge />}
            </Label>
            <Select value={materialFamily} onValueChange={(v) => { setMaterialFamily(v); onMarkEdited("material_family"); }}>
              <SelectTrigger id="material-family"><SelectValue placeholder="Ex: Metal" /></SelectTrigger>
              <SelectContent>
                {materialFamilies.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="size">Size (L × W × H cm)</Label>
            <Input
              id="size" name="size"
              defaultValue={
                listing.size_l && listing.size_w && listing.size_h
                  ? `${listing.size_l} × ${listing.size_w} × ${listing.size_h}` : ""
              }
              placeholder="Ex: 30 × 20 × 5"
              onChange={() => onMarkEdited("size")}
            />
          </div>
        </div>
      </div>

      <div>
        <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-zinc-400">Product Identity</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="model" className="flex items-center">
              Model
              {fieldSources["model"] === "ai" && <AIBadge />}
            </Label>
            <Input id="model" name="model" defaultValue={listing.model ?? ""} placeholder="Model ID" onChange={() => onMarkEdited("model")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="product-line">Product Line</Label>
            <Input id="product-line" name="product-line" defaultValue={listing.product_line ?? ""} placeholder="Ex: Alpha Series" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="production-country">Production Country</Label>
            <Select value={productionCountry} onValueChange={setProductionCountry}>
              <SelectTrigger id="production-country"><SelectValue placeholder="Select country" /></SelectTrigger>
              <SelectContent>
                {productionCountries.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cert">Certifications</Label>
            <Select value={certification} onValueChange={setCertification}>
              <SelectTrigger id="cert"><SelectValue placeholder="Ex: ISO 9001" /></SelectTrigger>
              <SelectContent>
                {certifications.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div>
        <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-zinc-400">Warranty</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="warranty-duration" className="flex items-center">Warranty Duration <QualityBadge /></Label>
            <Select value={warrantyDuration} onValueChange={(v) => { setWarrantyDuration(v); onMarkEdited("warranty_duration"); }}>
              <SelectTrigger id="warranty-duration"><SelectValue placeholder="Ex: 2 years" /></SelectTrigger>
              <SelectContent>{warrantyDurations.map((w) => <SelectItem key={w} value={w}>{w}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="warranty-type">Warranty Type</Label>
            <Select value={warrantyType} onValueChange={setWarrantyType}>
              <SelectTrigger id="warranty-type"><SelectValue placeholder="Ex: Service Center" /></SelectTrigger>
              <SelectContent>{warrantyTypes.map((w) => <SelectItem key={w} value={w}>{w}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
        <div className="mt-4 grid gap-4">
          <RichTextField id="product-warranty" label="Product Warranty" defaultValue={listing.warranty_text ?? ""} placeholder="Detailed warranty terms…" rows={3} />
          <RichTextField id="warranty-address" label="Warranty Address" defaultValue={listing.warranty_address ?? ""} placeholder="Service center name and address…" rows={2} />
        </div>
      </div>

      <div>
        <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-zinc-400">Additional</p>
        <Input id="youtube-id" name="youtube-id" defaultValue={listing.youtube_id ?? ""} placeholder="YouTube Video ID (optional)" />
      </div>
    </div>
  );
}

// ─── Step 4 — Category-specific Jumia Attributes ──────────────────────────────

interface AttrSchema {
  name:           string;
  label:          string;
  type:           "enum" | "string" | "number" | "boolean" | "multi";
  allowed_values: string[];
  required:       boolean;
  is_variant:     boolean;
}

function CategoryAttributesStep({
  categoryCode,
  values,
  onChange,
  fieldSources,
  onMarkEdited,
}: {
  categoryCode: string | null;
  values:       Record<string, string>;
  onChange:     (key: string, val: string) => void;
  fieldSources: Record<string, string>;
  onMarkEdited: (field: string) => void;
}) {
  const [schema,    setSchema]    = useState<AttrSchema[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [syncing,   setSyncing]   = useState(false);
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
      setSchema(d.attributes ?? []);
    } catch {
      setSchema([]);
    } finally {
      setLoading(false);
    }
  }, [categoryCode]);

  useEffect(() => { loadAttributes(); }, [loadAttributes]);

  // If the cache is empty, kick off a sync from Jumia and reload
  const handleSyncNow = useCallback(async () => {
    setSyncing(true);
    setSyncError(null);
    try {
      const r = await fetch("/api/jumia/sync-categories", { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Sync failed");
      // Wait a moment for upstream to settle, then reload
      await new Promise((res) => setTimeout(res, 600));
      await loadAttributes();
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }, [loadAttributes]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-zinc-400">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading category fields…
      </div>
    );
  }

  if (!schema.length) {
    return (
      <div className="rounded-xl border border-dashed border-zinc-200 py-8 px-5 text-center space-y-3">
        <Tag className="h-6 w-6 text-zinc-300 mx-auto" />
        <div className="space-y-1">
          <p className="text-sm font-medium text-zinc-600">No fields cached for this category yet</p>
          <p className="text-xs text-zinc-400">
            We&apos;ll fetch the live Jumia field schema for this category. This usually takes 10–20 seconds.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleSyncNow}
          disabled={syncing}
          className="gap-1.5"
        >
          {syncing ? (
            <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Fetching from Jumia…</>
          ) : (
            <><RefreshCw className="h-3.5 w-3.5" /> Fetch fields from Jumia</>
          )}
        </Button>
        {syncError && (
          <p className="text-xs text-red-500">{syncError}</p>
        )}
      </div>
    );
  }

  const required = schema.filter((a) => a.required);
  const optional = schema.filter((a) => !a.required);

  const renderField = (attr: AttrSchema) => {
    const val = values[attr.name] ?? "";
    const sourceKey = `dynamic_attributes.${attr.name}`;

    if (attr.type === "boolean") {
      return (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => { onChange(attr.name, val === "true" ? "false" : "true"); onMarkEdited(sourceKey); }}
            className={cn(
              "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors",
              val === "true" ? "bg-orange-500" : "bg-zinc-200"
            )}
          >
            <span className={cn(
              "pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow ring-0 transition-transform",
              val === "true" ? "translate-x-4" : "translate-x-0"
            )} />
          </button>
          <span className="text-xs text-zinc-500">{val === "true" ? "Yes" : "No"}</span>
        </div>
      );
    }

    if (attr.type === "enum" && attr.allowed_values.length > 0) {
      return (
        <Select value={val} onValueChange={(v) => { onChange(attr.name, v); onMarkEdited(sourceKey); }}>
          <SelectTrigger className="h-9 text-sm">
            <SelectValue placeholder={`Select ${attr.label}`} />
          </SelectTrigger>
          <SelectContent>
            {attr.allowed_values.map((v) => (
              <SelectItem key={v} value={v}>{v}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }

    if (attr.type === "multi" && attr.allowed_values.length > 0) {
      const selected = val ? val.split(",").map((s) => s.trim()).filter(Boolean) : [];
      return (
        <div className="flex flex-wrap gap-1.5">
          {attr.allowed_values.map((v) => {
            const active = selected.includes(v);
            return (
              <button
                key={v}
                type="button"
                onClick={() => {
                  const next = active ? selected.filter((s) => s !== v) : [...selected, v];
                  onChange(attr.name, next.join(", "));
                  onMarkEdited(sourceKey);
                }}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                  active
                    ? "border-orange-400 bg-orange-50 text-orange-700"
                    : "border-zinc-200 bg-white text-zinc-500 hover:border-zinc-300"
                )}
              >
                {v}
              </button>
            );
          })}
        </div>
      );
    }

    return (
      <Input
        value={val}
        type={attr.type === "number" ? "number" : "text"}
        placeholder={`Enter ${attr.label}`}
        onChange={(e) => { onChange(attr.name, e.target.value); onMarkEdited(sourceKey); }}
        className="h-9 text-sm"
      />
    );
  };

  const renderGroup = (attrs: AttrSchema[], groupLabel: string, labelColor: string) => (
    <div className="space-y-4">
      <p className={cn("text-xs font-semibold uppercase tracking-widest", labelColor)}>{groupLabel}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        {attrs.map((attr) => (
          <div key={attr.name} className="space-y-1.5">
            <Label className="flex items-center text-sm">
              {attr.label}
              {attr.required && <RequiredBadge />}
              {attr.is_variant && (
                <span className="ml-1.5 rounded-full bg-violet-50 border border-violet-200 px-1.5 py-0.5 text-[9px] font-semibold text-violet-600">variant</span>
              )}
              {fieldSources[`dynamic_attributes.${attr.name}`] === "ai" && <AIBadge />}
            </Label>
            {renderField(attr)}
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 rounded-xl border border-orange-100 bg-orange-50 px-4 py-3 text-xs text-orange-700">
        <Tag className="h-3.5 w-3.5 shrink-0" />
        These are the exact fields Jumia requires for this category. Fields marked <span className="text-red-500 font-bold mx-0.5">*</span> are required.
        Fields marked <span className="text-violet-600 font-bold mx-0.5">variant</span> are used as variant axes in the Variants tab.
      </div>
      {required.length > 0 && renderGroup(required, "Required fields", "text-red-500")}
      {optional.length > 0 && renderGroup(optional, "Optional fields", "text-zinc-400")}
    </div>
  );
}

// ─── Main review client ────────────────────────────────────────────────────────

// 3-step structure matching Jumia Vendor Center
const formSteps = [
  { id: 1, label: "Product Information", sub: "Images, name & description"  },
  { id: 2, label: "Variants",            sub: "Pricing & combinations"       },
  { id: 3, label: "Product Specification", sub: "Materials, warranty & more" },
];

const PUBLISH_THRESHOLD = typeof process !== "undefined"
  ? parseInt(process.env.NEXT_PUBLIC_QUALITY_THRESHOLD ?? String(DEFAULT_THRESHOLD), 10)
  : DEFAULT_THRESHOLD;

export function ReviewClient({ listing }: { listing: ListingRow }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [formStep, setFormStep] = useState(1);

  // ── Controlled state ──────────────────────────────────────────────────────
  const [colorFamily,       setColorFamily]       = useState(listing.color_family ?? "");
  const [certification,     setCertification]     = useState(listing.certifications?.[0] ?? "");
  const [materialFamily,    setMaterialFamily]    = useState(listing.material_family ?? "");
  const [productionCountry, setProductionCountry] = useState(listing.production_country ?? "");
  const [warrantyDuration,  setWarrantyDuration]  = useState(listing.warranty_duration ?? "");
  const [warrantyType,      setWarrantyType]      = useState(listing.warranty_type ?? "");
  const [brandValue,        setBrandValue]        = useState(listing.brand ?? "");

  // ── Category (can be changed via picker) ──────────────────────────────────
  const [categoryCode, setCategoryCode] = useState<string | null>(listing.category_code);
  const [categoryPath, setCategoryPath] = useState<string | null>(listing.category_path);

  const handleCategoryChange = (cat: { code: number; name: string; path: string }) => {
    setCategoryCode(String(cat.code));
    setCategoryPath(cat.path);
  };

  // ── Field sources (ai vs user) ────────────────────────────────────────────
  const [fieldSources, setFieldSources] = useState<Record<string, string>>(
    (listing.field_sources ?? {}) as Record<string, string>
  );

  const markEdited = useCallback((field: string) => {
    setFieldSources((prev) => ({ ...prev, [field]: "user" }));
  }, []);

  // ── Dynamic attributes ────────────────────────────────────────────────────
  const [dynAttrs, setDynAttrs] = useState<Record<string, string>>(
    (listing.dynamic_attributes ?? {}) as Record<string, string>
  );

  // ── Variant matrix ────────────────────────────────────────────────────────
  const commissionRate    = listing.commission_rate ?? 0.1;
  const commissionPercent = Math.round(commissionRate * 100);

  const [variants, setVariants] = useState<VariantRow[]>([{
    id: "v1", axes: {}, sellerSku: listing.sku,
    gtin: "", quantity: "1",
    globalPrice: listing.selling_price ? String(listing.selling_price) : "",
    salePrice: "", saleStartDate: "", saleEndDate: "",
  }]);
  const [axesDef, setAxesDef] = useState<AxisDef[]>([]);

  // ── Save + publish state ──────────────────────────────────────────────────
  const [saving,      setSaving]      = useState(false);
  const [saveError,   setSaveError]   = useState<string | null>(null);
  const [jumiaNotConnected, setJumiaNotConnected] = useState(false);
  const [publishedRef, setPublishedRef] = useState<string | null>(null);
  const [syncStatus, setSyncStatus]   = useState<"idle" | "saving" | "done" | "error">("idle");

  // ── PhotoRoom polish state ────────────────────────────────────────────────
  const [polishing, setPolishing] = useState(false);
  const [polishMsg, setPolishMsg] = useState<string | null>(null);
  const [polishedImages, setPolishedImages] = useState<string[] | null>(null);

  async function handlePolishImages() {
    setPolishing(true);
    setPolishMsg(null);
    try {
      const res = await fetch("/api/polish-images", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ listingId: listing.id, background: "white" }),
      });
      const data = await res.json() as { polished?: string[]; replaced?: number; total?: number; error?: string };
      if (!res.ok) {
        setPolishMsg(data.error ?? "Polish failed");
        return;
      }
      setPolishedImages(data.polished ?? null);
      setPolishMsg(`Polished ${data.replaced ?? 0} of ${data.total ?? 0} images.`);
      // Refresh server data so the form sees the new image URLs
      router.refresh();
    } catch (e) {
      setPolishMsg(e instanceof Error ? e.message : "Polish failed");
    } finally {
      setPolishing(false);
    }
  }

  // ── Quality score ─────────────────────────────────────────────────────────
  const [qualityResult, setQualityResult] = useState(() =>
    calculateQualityScore(listing, [], variants)
  );

  // Recalculate when variants or category attributes change
  useEffect(() => {
    setQualityResult(calculateQualityScore(
      { ...listing, dynamic_attributes: dynAttrs },
      [],
      variants.map((v) => ({ globalPrice: v.globalPrice, quantity: v.quantity }))
    ));
  }, [dynAttrs, variants, listing]);

  // ── Derived ───────────────────────────────────────────────────────────────
  const cat = mockCategories.find((c) => c.id === listing.category_id);
  const sellingPrice = variants[0]?.globalPrice
    ? parseFloat(variants[0].globalPrice)
    : (listing.selling_price ?? 0);
  const netPayout   = sellingPrice > 0 ? calcNetPayout(sellingPrice, commissionRate) : 0;
  const thumbnail   = listing.images?.[0] ?? null;
  const titleDisplay = listing.title ?? "Untitled listing";
  const categoryLabel = categoryPath ?? listing.category_path ?? listing.category_id ?? "Uncategorised";

  // ── Save handler ──────────────────────────────────────────────────────────
  async function handleSave(publish: boolean, opts?: { skipRedirect?: boolean }) {
    if (!formRef.current) return;

    if (publish && qualityResult.score < PUBLISH_THRESHOLD) {
      setSaveError(
        `Quality score ${qualityResult.score}/100 is below the minimum threshold of ${PUBLISH_THRESHOLD}. Fix the highlighted issues before publishing.`
      );
      return;
    }

    setSaving(true);
    setSaveError(null);
    setJumiaNotConnected(false);

    const fd  = new FormData(formRef.current);
    const str = (key: string) => (fd.get(key) as string | null)?.trim() || null;
    const num = (key: string) => {
      const v = (fd.get(key) as string | null)?.trim();
      return v ? parseFloat(v) : null;
    };

    try {
      await updateListing(listing.id, {
        title:              str("name"),
        description:        str("description"),
        highlights:         str("highlights"),
        brand:              brandValue || null,
        color:              str("color"),
        color_family:       colorFamily || null,
        weight_kg:          num("weight"),
        selling_price:      sellingPrice > 0 ? sellingPrice : null,
        main_material:      str("material"),
        material_family:    materialFamily || null,
        model:              str("model"),
        product_line:       str("product-line"),
        production_country: productionCountry || null,
        certifications:     certification ? [certification] : [],
        warranty_duration:  warrantyDuration || null,
        warranty_type:      warrantyType || null,
        warranty_text:      str("product-warranty"),
        warranty_address:   str("warranty-address"),
        youtube_id:         str("youtube-id"),
        category_code:      categoryCode,
        category_path:      categoryPath,
        dynamic_attributes: dynAttrs,
        field_sources:      fieldSources as Record<string, "ai" | "user">,
        quality_score:      qualityResult.score,
        status:             listing.status === "live" ? "live" : "draft",
        // Persist stock for simple (non-variant) listings
        ...(axesDef.length === 0 ? {
          quantity: Math.max(0, parseInt(variants[0]?.quantity ?? "1") || 1),
        } : {}),
      });

      if (!publish) {
        if (!opts?.skipRedirect) router.push("/listings");
        return;
      }

      // Push to Jumia
      const pushRes = await fetch("/api/jumia/push", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ listingId: listing.id }),
      });
      const pushData = await pushRes.json() as { success?: boolean; error?: string; jumia_ref?: string };

      if (pushRes.ok && pushData.success) {
        setPublishedRef(pushData.jumia_ref ?? null);
        router.push("/listings");
      } else if (pushData.error?.includes("not connected") || pushRes.status === 403) {
        setJumiaNotConnected(true);
        setSaveError(pushData.error ?? "Jumia not connected");
      } else {
        setSaveError(pushData.error ?? "Jumia submission failed. Try again or check Settings → Integrations.");
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleSyncToJumia() {
    setSyncStatus("saving");
    setSaveError(null);
    try {
      // Persist latest form state first (skip the /listings redirect)
      await handleSave(false, { skipRedirect: true });
    } catch {
      setSyncStatus("error");
      return;
    }
    try {
      const res = await fetch("/api/jumia/update", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ listingId: listing.id }),
      });
      const data = await res.json() as { success?: boolean; error?: string };
      if (res.ok && data.success) {
        setSyncStatus("done");
        router.refresh();
      } else {
        setSyncStatus("error");
        setSaveError(data.error ?? "Jumia update failed. Try again.");
      }
    } catch {
      setSyncStatus("error");
      setSaveError("Network error. Please try again.");
    }
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" asChild>
          <Link href="/listings"><ArrowLeft className="h-4 w-4" /></Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-bold text-zinc-900">Review listing</h1>
          <p className="text-xs text-zinc-400">{listing.sku}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <QualityScoreBadge
            score={qualityResult.score}
            threshold={PUBLISH_THRESHOLD}
            issues={qualityResult.issues}
          />
          <StatusPill status={listing.status} />
          <MarketplaceBadge marketplace="jumia" />
        </div>
      </div>

      {/* Category path banner */}
      {cat && (
        <div className="flex items-center gap-2 rounded-xl border bg-zinc-50 px-4 py-2.5 text-xs text-zinc-500">
          <span className="shrink-0 font-semibold text-zinc-700">Category:</span>
          <span className="truncate">{categoryPath ?? cat.path}</span>
          {categoryCode && (
            <span className="shrink-0 rounded-full bg-zinc-200 px-1.5 py-0.5 text-[10px] font-mono text-zinc-500">{categoryCode}</span>
          )}
        </div>
      )}

      {/* Published success banner */}
      {publishedRef && (
        <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          Submitted to Jumia (feed ID: <code className="font-mono text-xs">{publishedRef}</code>). Status will update within a few minutes.
        </div>
      )}

      {/* Jumia not connected banner */}
      {jumiaNotConnected && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">Jumia account not connected</p>
            <p className="text-xs mt-0.5">Go to Settings → Integrations to connect your Jumia seller account.</p>
            <Link href="/settings/integrations" className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-amber-800 hover:underline">
              Connect now <ChevronRight className="h-3 w-3" />
            </Link>
          </div>
        </div>
      )}

      {/* Two-column layout */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[360px_1fr]">

        {/* ── LEFT — AI Preview (sticky) ────────────────────────────────── */}
        <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          <div className="rounded-2xl border bg-white p-5 shadow-sm space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-blue-500" />
                <span className="text-sm font-semibold text-zinc-700">AI preview</span>
              </div>
              <Button variant="ghost" size="sm" type="button" className="h-7 gap-1 text-xs text-blue-500 hover:text-blue-600">
                <RefreshCw className="h-3 w-3" /> Regenerate all
              </Button>
            </div>

            {/* Image gallery */}
            <div className="space-y-2">
              <div className="aspect-square overflow-hidden rounded-xl border bg-zinc-50 flex items-center justify-center">
                {thumbnail ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={thumbnail} alt={titleDisplay} className="h-full w-full object-cover" />
                ) : (
                  <span className="text-xs text-zinc-400">No image</span>
                )}
              </div>
              <div className="grid grid-cols-7 gap-1">
                {Array.from({ length: 7 }, (_, i) => {
                  const src = listing.images?.[i + 1] ?? null;
                  return (
                    <div key={i} className="aspect-square overflow-hidden rounded-md border-2 border-dashed border-zinc-200 bg-zinc-50 flex items-center justify-center">
                      {src
                        ? <img src={src} alt="" className="h-full w-full object-cover" /> // eslint-disable-line @next/next/no-img-element
                        : <Plus className="h-3 w-3 text-zinc-300" />}
                    </div>
                  );
                })}
              </div>

              {/* Polish images CTA */}
              {(listing.images?.length ?? 0) > 0 && (
                <div className="rounded-xl border border-violet-100 bg-gradient-to-br from-violet-50 to-fuchsia-50 p-3 space-y-2">
                  <div className="flex items-start gap-2">
                    <Sparkles className="h-3.5 w-3.5 mt-0.5 shrink-0 text-violet-500" />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold text-zinc-800">Marketplace-ready photos</p>
                      <p className="text-[11px] text-zinc-500 leading-snug mt-0.5">
                        Remove background, add white BG + soft shadow, resize to 2000×2000 — Jumia-compliant in one click.
                      </p>
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    onClick={handlePolishImages}
                    disabled={polishing}
                    className="w-full h-8 text-xs gap-1.5 bg-violet-500 hover:bg-violet-600 text-white"
                  >
                    {polishing ? (
                      <><Loader2 className="h-3 w-3 animate-spin" /> Polishing {listing.images?.length} images…</>
                    ) : polishedImages ? (
                      <><CheckCircle2 className="h-3 w-3" /> Polish again</>
                    ) : (
                      <><Sparkles className="h-3 w-3" /> Polish all {listing.images?.length} images</>
                    )}
                  </Button>
                  {polishMsg && (
                    <p className="text-[11px] text-center text-emerald-600 font-medium">{polishMsg}</p>
                  )}
                </div>
              )}
            </div>

            {/* Breadcrumb */}
            <div className="flex items-center gap-1 text-[11px] text-zinc-400 flex-wrap">
              <span>Jumia GH</span>
              <ChevronRight className="h-3 w-3" />
              <span>{categoryLabel}</span>
              <ChevronRight className="h-3 w-3" />
              <span className="font-medium text-zinc-600 truncate max-w-[120px]">{titleDisplay}</span>
            </div>

            {/* AI Title */}
            <div className="rounded-xl border bg-gradient-to-br from-blue-50/60 to-violet-50/60 p-3 space-y-1.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1">
                  <Sparkles className="h-3 w-3 text-blue-500" />
                  <span className="text-[10px] font-semibold text-zinc-500">Title</span>
                  {fieldSources["title"] === "ai" && (
                    <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[9px] font-bold text-blue-600">AI</span>
                  )}
                </div>
                <button type="button" className="rounded p-0.5 text-zinc-400 hover:text-blue-500">
                  <RefreshCw className="h-3 w-3" />
                </button>
              </div>
              <p className="text-xs font-semibold text-zinc-800 leading-snug">{titleDisplay}</p>
            </div>

            {/* AI Description */}
            <div className="rounded-xl border bg-gradient-to-br from-blue-50/60 to-violet-50/60 p-3 space-y-1.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1">
                  <Sparkles className="h-3 w-3 text-blue-500" />
                  <span className="text-[10px] font-semibold text-zinc-500">Description</span>
                  {fieldSources["description"] === "ai" && (
                    <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[9px] font-bold text-blue-600">AI</span>
                  )}
                </div>
                <button type="button" className="rounded p-0.5 text-zinc-400 hover:text-blue-500">
                  <RefreshCw className="h-3 w-3" />
                </button>
              </div>
              <p className="text-[11px] text-zinc-600 leading-relaxed line-clamp-4">
                {listing.description ?? `This is a high-quality ${titleDisplay}.`}
              </p>
            </div>

            {/* Price breakdown */}
            <div className="rounded-xl border p-3 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-zinc-500">Selling price</span>
                <span className="font-bold text-zinc-900">
                  {sellingPrice > 0 ? formatGHS(sellingPrice) : "—"}
                </span>
              </div>
              {sellingPrice > 0 && (
                <>
                  <div className="flex justify-between text-xs">
                    <span className="text-zinc-400">Commission ({commissionPercent}% · incl. VAT)</span>
                    <span className="text-red-500">− {formatGHS(sellingPrice * commissionRate)}</span>
                  </div>
                  <div className="border-t pt-2 flex justify-between">
                    <span className="text-xs font-semibold text-zinc-600">Net payout to you</span>
                    <span className="text-sm font-bold text-emerald-600">{formatGHS(netPayout)}</span>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* ── RIGHT — Jumia Vendor Center–style form ────────────────────── */}
        <div className="space-y-4">
          <div className="rounded-2xl border bg-white shadow-sm overflow-hidden">
            <div className="flex" style={{ minHeight: 560 }}>

              {/* ── Left vertical step indicator ── */}
              <div className="hidden sm:flex w-48 shrink-0 flex-col border-r bg-zinc-50/80 pt-8 pb-6 px-5">
                {formSteps.map((step, i) => {
                  const isActive = formStep === step.id;
                  const isDone   = formStep > step.id;
                  return (
                    <div key={step.id}>
                      <button
                        type="button"
                        onClick={() => setFormStep(step.id)}
                        className="flex items-start gap-3 w-full text-left group"
                      >
                        {/* Dot */}
                        <div className="flex shrink-0 flex-col items-center">
                          <div
                            className={cn(
                              "flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-bold transition-all",
                              isActive
                                ? "text-white shadow-sm"
                                : isDone
                                ? "bg-emerald-500 text-white"
                                : "bg-zinc-200 text-zinc-500 group-hover:bg-zinc-300"
                            )}
                            style={isActive ? { background: "#F68B1E", boxShadow: "0 2px 8px rgba(246,139,30,0.35)" } : undefined}
                          >
                            {isDone ? <Check className="h-3.5 w-3.5" /> : step.id}
                          </div>
                          {/* Connector line */}
                          {i < formSteps.length - 1 && (
                            <div
                              className={cn("w-0.5 my-2 rounded-full transition-colors", isDone ? "bg-emerald-400" : "bg-zinc-200")}
                              style={{ height: 48 }}
                            />
                          )}
                        </div>
                        {/* Labels */}
                        <div className="pt-0.5 min-w-0">
                          <p
                            className={cn("text-xs font-semibold leading-tight transition-colors",
                              isActive ? "text-[#F68B1E]" : isDone ? "text-zinc-600" : "text-zinc-500"
                            )}
                          >
                            {step.label}
                          </p>
                          <p className="mt-0.5 text-[10px] leading-tight text-zinc-400">{step.sub}</p>
                        </div>
                      </button>
                    </div>
                  );
                })}
              </div>

              {/* ── Right: scrollable form content ── */}
              <div className="flex flex-1 flex-col overflow-hidden">

                {/* Mobile step tabs (shown on small screens only) */}
                <div className="flex border-b overflow-x-auto sm:hidden">
                  {formSteps.map((s) => {
                    const isActive = formStep === s.id;
                    const isDone   = formStep > s.id;
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setFormStep(s.id)}
                        className={cn(
                          "flex flex-none items-center gap-1.5 border-r px-4 py-3 text-xs font-medium whitespace-nowrap last:border-r-0",
                          isActive ? "border-b-2 border-b-[#F68B1E] bg-orange-50 text-[#F68B1E]"
                            : isDone ? "bg-zinc-50 text-zinc-400"
                            : "text-zinc-400"
                        )}
                      >
                        <span className={cn(
                          "flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold",
                          isActive ? "text-white" : isDone ? "bg-emerald-500 text-white" : "bg-zinc-200 text-zinc-500"
                        )}
                          style={isActive ? { background: "#F68B1E" } : undefined}
                        >
                          {isDone ? <Check className="h-2.5 w-2.5" /> : s.id}
                        </span>
                        {s.label}
                      </button>
                    );
                  })}
                </div>

                {/* Form — all steps stay mounted so FormData captures all inputs */}
                <form ref={formRef} onSubmit={(e) => e.preventDefault()} className="flex flex-1 flex-col">
                  <div className="flex-1 overflow-y-auto p-5 sm:p-6">
                    <motion.div
                      key={formStep}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.15 }}
                    >
                      {/* Step 1 — Product Information + Category-specific attributes */}
                      <div className={formStep !== 1 ? "hidden" : "space-y-8"}>
                        <ProductInformationStep
                          listing={{ ...listing, category_code: categoryCode, category_path: categoryPath }}
                          colorFamily={colorFamily}
                          setColorFamily={setColorFamily}
                          fieldSources={fieldSources}
                          onMarkEdited={markEdited}
                          brandValue={brandValue}
                          onBrandChange={setBrandValue}
                          onCategoryChange={handleCategoryChange}
                        />
                        {/* Category-specific Jumia attributes directly below product info */}
                        <div className="border-t pt-6">
                          <p className="mb-4 text-sm font-semibold text-zinc-700">Product Specification</p>
                          <CategoryAttributesStep
                            categoryCode={categoryCode}
                            values={dynAttrs}
                            onChange={(k, v) => setDynAttrs((prev) => ({ ...prev, [k]: v }))}
                            fieldSources={fieldSources}
                            onMarkEdited={markEdited}
                          />
                        </div>
                      </div>

                      {/* Step 2 — Variants & pricing */}
                      <div className={formStep !== 2 ? "hidden" : ""}>
                        <VariantMatrixStep
                          baseSku={listing.sku}
                          categoryCode={categoryCode}
                          variants={variants}
                          setVariants={setVariants}
                          axesDef={axesDef}
                          setAxesDef={setAxesDef}
                          commissionRate={commissionRate}
                          commissionPercent={commissionPercent}
                        />
                      </div>

                      {/* Step 3 — Product Specification */}
                      <div className={formStep !== 3 ? "hidden" : ""}>
                        <ProductSpecificationStep
                          listing={listing}
                          certification={certification}
                          setCertification={setCertification}
                          materialFamily={materialFamily}
                          setMaterialFamily={setMaterialFamily}
                          productionCountry={productionCountry}
                          setProductionCountry={setProductionCountry}
                          warrantyDuration={warrantyDuration}
                          setWarrantyDuration={setWarrantyDuration}
                          warrantyType={warrantyType}
                          setWarrantyType={setWarrantyType}
                          fieldSources={fieldSources}
                          onMarkEdited={markEdited}
                        />
                      </div>
                    </motion.div>
                  </div>

                  {/* Inline banners (above footer) */}
                  <div className="px-5 sm:px-6 space-y-2">
                    {saveError && !jumiaNotConnected && (
                      <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700">
                        <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                        {saveError}
                      </div>
                    )}
                    {qualityResult.score < PUBLISH_THRESHOLD && (
                      <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-700">
                        <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
                        Quality score {qualityResult.score}/100 — minimum to publish is {PUBLISH_THRESHOLD}.
                      </div>
                    )}
                    {listing.status === "live" && listing.update_feed_status === "pending" && (
                      <div className="rounded-xl bg-amber-50 border border-amber-100 px-4 py-2.5 text-xs text-amber-700 flex items-center gap-2">
                        <Loader2 className="h-3 w-3 animate-spin shrink-0" />
                        Jumia is processing your update — this usually takes under a minute.
                      </div>
                    )}
                  </div>

                  {/* ── Sticky bottom bar — Jumia style ── */}
                  <div className="mt-2 flex items-center justify-between gap-3 border-t bg-white px-5 py-3.5 sm:px-6">
                    {/* Left: View drafts */}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="gap-1.5 text-zinc-600"
                      onClick={() => router.push("/listings")}
                    >
                      View drafts
                    </Button>

                    {/* Right: context-aware action */}
                    <div className="flex items-center gap-2">
                      {/* Previous step pill */}
                      {formStep > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="text-zinc-400"
                          onClick={() => setFormStep((s) => Math.max(1, s - 1))}
                          disabled={saving}
                        >
                          <ArrowLeft className="h-3.5 w-3.5 mr-1" /> Back
                        </Button>
                      )}

                      {listing.status === "live" ? (
                        <>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="gap-1"
                            disabled={saving || syncStatus === "saving"}
                            onClick={() => handleSave(false, { skipRedirect: true })}
                          >
                            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                            Save
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            className="gap-1.5 text-white disabled:opacity-50"
                            style={{ background: "linear-gradient(to right, #F68B1E, #e8710a)" }}
                            onClick={handleSyncToJumia}
                            disabled={syncStatus === "saving"}
                          >
                            {syncStatus === "saving"
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              : <RefreshCw className="h-3.5 w-3.5" />}
                            Sync to Jumia
                          </Button>
                          {syncStatus === "done"  && <span className="text-xs text-emerald-600">✓ Submitted</span>}
                          {syncStatus === "error" && <span className="text-xs text-red-500">Failed — retry</span>}
                        </>
                      ) : formStep < formSteps.length ? (
                        <Button
                          type="button"
                          size="sm"
                          className="gap-1.5 text-white"
                          style={{ background: "linear-gradient(to right, #F68B1E, #e8710a)" }}
                          onClick={() => setFormStep((s) => Math.min(formSteps.length, s + 1))}
                          disabled={saving}
                        >
                          Next <ChevronRight className="h-3.5 w-3.5" />
                        </Button>
                      ) : (
                        <>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="gap-1"
                            disabled={saving}
                            onClick={() => handleSave(false)}
                          >
                            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                            Save draft
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            className="gap-1.5 text-white disabled:opacity-50"
                            style={{ background: "linear-gradient(to right, #F68B1E, #e8710a)" }}
                            disabled={saving || qualityResult.score < PUBLISH_THRESHOLD}
                            onClick={() => handleSave(true)}
                            title={qualityResult.score < PUBLISH_THRESHOLD
                              ? `Quality score too low (${qualityResult.score}/${PUBLISH_THRESHOLD})`
                              : "Review & publish to Jumia"}
                          >
                            {saving
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              : <Sparkles className="h-3.5 w-3.5" />}
                            Review &amp; publish
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                </form>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
