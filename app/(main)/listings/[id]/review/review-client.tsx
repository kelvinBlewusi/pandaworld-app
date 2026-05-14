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
  ChevronUp,
  Plus,
  Trash2,
  Calendar as CalendarIcon,
  Star,
  Loader2,
  AlertCircle,
  Tag,
  Search,
  X,
  ShieldAlert,
  CheckCircle2,
  Info,
  ListChecks,
  Pencil,
  Clock,
  Bold,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Image as ImageIcon,
  Quote,
  Table as TableIcon,
  Video,
  Undo2,
  Redo2,
  IndentIncrease,
  IndentDecrease,
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
import type { ListingRow } from "@/lib/supabase/types";
import { updateListing } from "@/lib/actions/listings";
import { calculateQualityScore, scoreLabel, scoreColor, DEFAULT_THRESHOLD } from "@/lib/quality-score";
import { isValidGTIN } from "@/lib/utils/gtin";
import type { JumiaCategoryAttribute } from "@/lib/jumia/categories";
import { CategoryDrawer } from "@/components/ui/category-drawer";
import { MultiSelectDropdown } from "@/components/ui/multi-select";
import { SchemaForm } from "@/components/jumia/SchemaForm";
import {
  columnFor,
  fieldChangeToUpdate,
  type MappedColumn,
} from "@/lib/jumia/attribute-mapping";

// ─── Auto-SKU helper ──────────────────────────────────────────────────────────

function abbr(v: string, n = 4) {
  return v.replace(/\s+/g, "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, n);
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface VariantRow {
  id: string;
  axes: Record<string, string>;
  /**
   * User-facing variation label. Pre-filled from axes (e.g. "Black / 64GB")
   * but freely editable for sellers who don't use axes — they can type
   * "Pack of 6" or "Large" directly.
   */
  variation: string;
  sellerSku: string;
  gtin: string;
  quantity: string;
  globalPrice: string;
  salePrice: string;
  saleStartDate: string;
  saleEndDate: string;
}

interface AxisDef {
  name: string;
  label: string;
  values: string[];
  allowedValues: string[];
}

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

interface CategoryItem {
  code: number;
  name: string;
  path: string;
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

// ─── Rich-text editor (Jumia-style toolbar, plain textarea underneath) ────────

function RichTextField({
  id,
  defaultValue,
  placeholder,
  rows = 3,
  onChange,
  value,
}: {
  id: string;
  defaultValue?: string;
  value?: string;
  placeholder?: string;
  rows?: number;
  onChange?: (v: string) => void;
}) {
  return (
    <div className="rounded-md border border-zinc-200 bg-white overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 border-b border-zinc-200 bg-zinc-50/50 px-2 py-1.5">
        <select className="rounded border border-zinc-200 bg-white px-1.5 py-0.5 text-[11px] text-zinc-600 focus:outline-none">
          <option>Paragraph</option>
        </select>
        {[
          { Icon: Bold,            title: "Bold" },
          { Icon: Italic,          title: "Italic" },
          { Icon: LinkIcon,        title: "Link" },
          { Icon: List,            title: "Bulleted list" },
          { Icon: ListOrdered,     title: "Numbered list" },
          { Icon: IndentDecrease,  title: "Decrease indent" },
          { Icon: IndentIncrease,  title: "Increase indent" },
          { Icon: ImageIcon,       title: "Image" },
          { Icon: Quote,           title: "Quote" },
          { Icon: TableIcon,       title: "Table" },
          { Icon: Video,           title: "Video" },
          { Icon: Undo2,           title: "Undo" },
          { Icon: Redo2,           title: "Redo" },
        ].map(({ Icon, title }) => (
          <button
            key={title}
            type="button"
            title={title}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-700"
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        ))}
      </div>
      <Textarea
        id={id}
        name={id}
        rows={rows}
        defaultValue={defaultValue}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange?.(e.target.value)}
        className="border-0 rounded-none focus-visible:ring-0 text-sm"
      />
    </div>
  );
}

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

// ─── Category picker modal ────────────────────────────────────────────────────

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
          <p className="font-semibold text-zinc-900">Select a category</p>
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
                ? "No categories synced yet. Connect Jumia in Settings → Integrations."
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

function ImageGrid({ images }: { images: string[] }) {
  const slots = Array.from({ length: 8 }, (_, i) => images[i] ?? null);
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-4 gap-3 sm:grid-cols-8">
        {slots.map((url, i) => (
          <div
            key={i}
            className={cn(
              "group relative flex aspect-square cursor-pointer flex-col items-center justify-center gap-1 rounded-md border-2 overflow-hidden transition-colors",
              url
                ? "border-solid border-zinc-200 bg-white"
                : "border-dashed border-orange-300 bg-white hover:bg-orange-50",
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
          </div>
        ))}
      </div>
      <p className="text-xs text-zinc-400">
        Image needs to be between 500×500 and 2000×2000 pixels. White backgrounds are recommended. No watermarks. Maximum image size 2Mb.
      </p>
    </div>
  );
}

// ─── Variant card (matches Jumia layout) ──────────────────────────────────────

function VariantCard({
  variant,
  axes,
  selected,
  collapsed,
  onUpdate,
  onToggleSelect,
  onToggleCollapse,
  onDelete,
}: {
  variant:  VariantRow;
  axes:     AxisDef[];
  selected: boolean;
  collapsed: boolean;
  onUpdate: (field: keyof VariantRow, value: string) => void;
  onToggleSelect: () => void;
  onToggleCollapse: () => void;
  onDelete: () => void;
}) {
  const variationLabel =
    variant.variation?.trim() ||
    Object.values(variant.axes ?? {}).filter(Boolean).join(" / ") ||
    "...";
  const qty = parseInt(variant.quantity || "0", 10) || 0;
  const gtinOk = !variant.gtin || isValidGTIN(variant.gtin);

  return (
    <div className="rounded-md border border-zinc-200 bg-white overflow-hidden">
      {/* Card header */}
      <button
        type="button"
        onClick={onToggleCollapse}
        className="flex w-full items-center justify-between gap-3 border-b border-zinc-100 bg-white px-4 py-3 text-left hover:bg-zinc-50/50"
      >
        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            onClick={(e) => e.stopPropagation()}
            className="h-4 w-4 rounded border-zinc-300 text-orange-500 focus:ring-orange-500"
          />
          <span className="text-sm font-semibold text-zinc-800">
            Variation ({variationLabel}), Quantity ({qty})
          </span>
        </div>
        {collapsed
          ? <ChevronDown className="h-4 w-4 text-zinc-400" />
          : <ChevronUp   className="h-4 w-4 text-zinc-400" />}
      </button>

      {!collapsed && (
        <div className="px-4 pt-4 pb-3 space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-zinc-700">
                Variation<Required />
              </Label>
              <Input
                placeholder={Object.values(variant.axes ?? {}).filter(Boolean).join(" / ") || "Ex: Black, Large, Pack of 6…"}
                value={variant.variation}
                onChange={(e) => onUpdate("variation", e.target.value)}
                className="h-10 text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-zinc-700">
                Seller SKU<Required />
              </Label>
              <Input
                placeholder="Seller SKU"
                value={variant.sellerSku}
                onChange={(e) => onUpdate("sellerSku", e.target.value)}
                className="h-10 text-sm font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-zinc-700">GTIN Barcode</Label>
              <Input
                placeholder="GTIN Barcode"
                value={variant.gtin}
                onChange={(e) => onUpdate("gtin", e.target.value)}
                className={cn("h-10 text-sm", variant.gtin && !gtinOk && "border-red-300")}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-zinc-700">Quantity</Label>
              <Input
                type="number"
                min="0"
                placeholder="Quantity"
                value={variant.quantity}
                onChange={(e) => onUpdate("quantity", e.target.value)}
                className="h-10 text-sm"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-zinc-700">
                Global Price<Required />
              </Label>
              <div className="relative">
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="Global Price"
                  value={variant.globalPrice}
                  onChange={(e) => onUpdate("globalPrice", e.target.value)}
                  className="h-10 text-sm pr-12"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium text-zinc-400">GHS</span>
              </div>
            </div>
            {/* Sale Price + Start/End Date lock behind Global Price per Jumia UX */}
            {(() => {
              const saleEnabled = variant.globalPrice.trim().length > 0;
              const lockTitle   = saleEnabled
                ? undefined
                : "Enter a Global Price first to unlock sale fields";
              return (
                <>
                  <div className="space-y-1.5">
                    <Label className={cn("text-xs font-semibold", saleEnabled ? "text-zinc-700" : "text-zinc-400")}>
                      Sale Price
                    </Label>
                    <div className="relative">
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="Sale Price"
                        value={variant.salePrice}
                        onChange={(e) => onUpdate("salePrice", e.target.value)}
                        disabled={!saleEnabled}
                        title={lockTitle}
                        className={cn("h-10 text-sm pr-12", !saleEnabled && "bg-zinc-50 cursor-not-allowed")}
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium text-zinc-400">GHS</span>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label className={cn("text-xs font-semibold", saleEnabled ? "text-zinc-700" : "text-zinc-400")}>
                      Sale Start Date
                    </Label>
                    <div className="relative">
                      <Input
                        type="date"
                        value={variant.saleStartDate}
                        onChange={(e) => onUpdate("saleStartDate", e.target.value)}
                        disabled={!saleEnabled}
                        title={lockTitle}
                        className={cn("h-10 text-sm pr-9", !saleEnabled && "bg-zinc-50 cursor-not-allowed")}
                      />
                      <CalendarIcon className="absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-400 pointer-events-none" />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label className={cn("text-xs font-semibold", saleEnabled ? "text-zinc-700" : "text-zinc-400")}>
                      Sale End Date
                    </Label>
                    <div className="relative">
                      <Input
                        type="date"
                        value={variant.saleEndDate}
                        onChange={(e) => onUpdate("saleEndDate", e.target.value)}
                        disabled={!saleEnabled}
                        title={lockTitle}
                        className={cn("h-10 text-sm pr-9", !saleEnabled && "bg-zinc-50 cursor-not-allowed")}
                      />
                      <CalendarIcon className="absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-400 pointer-events-none" />
                    </div>
                  </div>
                </>
              );
            })()}
          </div>
          {!variant.globalPrice.trim() && (
            <p className="-mt-2 text-[11px] text-zinc-400 italic">
              Enter a Global Price above to unlock Sale Price and dates.
            </p>
          )}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onDelete}
              className="flex items-center gap-1 text-xs text-zinc-400 hover:text-red-500 transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </button>
          </div>
        </div>
      )}
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
              <span className="font-semibold">AI pre-filled {aiFieldCount} field{aiFieldCount === 1 ? "" : "s"}.</span>{" "}
              <span className="text-violet-700">Review each — yellow = AI inferred, gray = you fill in.</span>
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
            Analyze with AI
          </div>
          <p className="text-[11px] text-orange-700 mt-0.5">
            One click: AI picks the right Jumia category and fills the category-specific fields from your images.
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
          placeholder="Optional: tell the AI anything the images don't show. E.g. 'this is a pack of 6', 'the colour is teal not blue', 'specify it's wireless'."
          className="w-full rounded-md border border-orange-200 bg-white/70 px-2.5 py-1.5 text-xs text-zinc-700 placeholder:text-zinc-400 focus:outline-none focus:ring-1 focus:ring-orange-300 resize-none"
        />
        <p className="text-[10px] text-orange-600">
          {prompt.length > 0 && `${prompt.length}/1000 · `}
          The AI is forbidden from using Jumia-restricted words like &quot;original&quot;, &quot;brand new&quot;, &quot;imported&quot;, etc.
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

export function ReviewClient({ listing }: { listing: ListingRow }) {
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

  // ── Controlled state ──────────────────────────────────────────────────────
  const [colorFamily,       setColorFamily]       = useState(listing.color_family ?? "");
  // Certifications is stored as string[] in the DB but rendered as a
  // multi-select with comma-separated state for the UI.
  const [certification,     setCertification]     = useState(
    Array.isArray(listing.certifications) ? listing.certifications.join(", ") : ""
  );
  const [materialFamily,    setMaterialFamily]    = useState(listing.material_family ?? "");
  const [productionCountry, setProductionCountry] = useState(listing.production_country ?? "");
  const [warrantyDuration,  setWarrantyDuration]  = useState(listing.warranty_duration ?? "");
  const [warrantyType,      setWarrantyType]      = useState(listing.warranty_type ?? "");
  const [brandValue,        setBrandValue]        = useState(listing.brand ?? "");

  // ── Controlled text fields with validation ────────────────────────────────
  // Jumia enforces strict min/max lengths and rejects feeds that violate them.
  // We mirror those limits here so Submit is disabled until everything is
  // valid. The listing also auto-saves to DB on every keystroke (via FormData
  // capture in handleSave) so the AI suggestion is preserved.
  const [titleValue,       setTitleValue]       = useState(listing.title ?? "");
  const [descriptionValue, setDescriptionValue] = useState(listing.description ?? "");
  const [highlightsValue,  setHighlightsValue]  = useState(listing.highlights ?? "");

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
  const [refillMsg,           setRefillMsg]           = useState<string | null>(null);

  const handleCategoryChange = async (cat: { code: number; name: string; path: string }) => {
    const previousCode = categoryCode;

    // Optimistic UI update
    setCategoryCode(String(cat.code));
    setCategoryPath(cat.path);
    setCategoryName(cat.name);

    // If the category actually changed, fire the AI re-fill in the background.
    // First-time picks (no previous category) ALSO trigger it.
    if (String(cat.code) === previousCode) return;

    setRefillingAttributes(true);
    setRefillMsg(null);
    try {
      const res = await fetch(`/api/listings/${listing.id}/refill-attributes`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ categoryCode: cat.code, categoryPath: cat.path }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRefillMsg(data.error ?? "Couldn't fetch category fields from Jumia.");
        return;
      }
      // Merge the new attributes back into local state — no full page reload
      // needed, the form will re-render with the fresh values.
      if (data.dynamic_attributes) {
        setDynAttrs(data.dynamic_attributes as Record<string, string>);
      }
      setRefillMsg(
        `${data.attributesSchema} field${data.attributesSchema === 1 ? "" : "s"} from Jumia · AI filled ${data.aiFilled}.`
      );
      // Trigger a server refresh so listing.field_confidence + field_sources
      // are fresh next render (for the confidence dots).
      router.refresh();
    } catch (e) {
      setRefillMsg(e instanceof Error ? e.message : "AI fill failed.");
    } finally {
      setRefillingAttributes(false);
    }
  };

  // ── Dynamic attributes (category-specific + extra spec fields) ─────────────
  const [dynAttrs, setDynAttrs] = useState<Record<string, string>>(
    (listing.dynamic_attributes ?? {}) as Record<string, string>
  );

  // Spec rich-text fields stored under reserved dynamic_attributes keys
  const [note,             setNote]             = useState(dynAttrs["note"] ?? "");
  const [fda,              setFda]              = useState(dynAttrs["fda"] ?? "");
  const [fromManufacturer, setFromManufacturer] = useState(dynAttrs["from_the_manufacturer"] ?? "");
  const [whatsInTheBox,    setWhatsInTheBox]    = useState(dynAttrs["whats_in_the_box"] ?? "");

  // ── Schema-driven form: column overrides ──────────────────────────────────
  //
  // When the schema-driven SchemaForm edits a field that maps to a
  // first-class column (e.g. "color" → listing.color), we store the override
  // here so the form shows the latest value WITHOUT round-tripping to the
  // DB. Save merges these into the listing update.
  const [columnOverrides, setColumnOverrides] = useState<Record<string, string>>({});

  // Single entry point for ALL field changes from the schema-driven form.
  // Routes to the correct local state based on attribute-mapping rules.
  const handleSchemaFieldChange = useCallback((attributeName: string, value: string) => {
    const col = columnFor(attributeName);

    // Mirror to existing controlled state so the static UI widgets reflect
    // the same value. Columns without controlled state (main_material,
    // model, etc.) are handled via columnOverrides + the save merger.
    switch (col) {
      case "title":              setTitleValue(value); break;
      case "description":        setDescriptionValue(value); break;
      case "highlights":         setHighlightsValue(value); break;
      case "brand":              setBrandValue(value); break;
      case "color_family":       setColorFamily(value); break;
      case "material_family":    setMaterialFamily(value); break;
      case "production_country": setProductionCountry(value); break;
      case "warranty_duration":  setWarrantyDuration(value); break;
      case "warranty_type":      setWarrantyType(value); break;
      case "certifications":     setCertification(value); break;
      default: /* no controlled mirror — handled via columnOverrides */
    }

    if (col) {
      // Column-backed: cache the latest override so SchemaForm reads it
      // back, AND save merges it into the listings update payload.
      setColumnOverrides((prev) => ({ ...prev, [attributeName]: value }));
    } else {
      // Dynamic attribute: update the JSON blob.
      setDynAttrs((prev) => ({ ...prev, [attributeName]: value }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Combined overrides map fed to SchemaForm — wraps current controlled state
  // so re-renders pick it up instantly.
  const schemaFormOverrides: Record<string, string> = {
    ...columnOverrides,
    // Static controlled fields → re-broadcast to the schema renderer
    name:                 titleValue,
    title:                titleValue,
    description:          descriptionValue,
    product_description:  descriptionValue,
    highlights:           highlightsValue,
    brand:                brandValue,
    color_family:         colorFamily,
    material_family:      materialFamily,
    production_country:   productionCountry,
    warranty_duration:    warrantyDuration,
    warranty_type:        warrantyType,
    certifications:       certification,
  };

  // ── Variant matrix state ──────────────────────────────────────────────────
  const commissionRate    = listing.commission_rate ?? 0.1;
  const commissionPercent = Math.round(commissionRate * 100);

  const [variants, setVariants] = useState<VariantRow[]>([{
    id: "v1", axes: {}, variation: "", sellerSku: listing.sku,
    gtin: "", quantity: "1",
    globalPrice: listing.selling_price ? String(listing.selling_price) : "",
    salePrice: "", saleStartDate: "", saleEndDate: "",
  }]);
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

  // Rebuild variant rows from axes
  useEffect(() => {
    if (axesDef.length === 0) {
      setVariants([{
        id: "v1", axes: {}, variation: "", sellerSku: listing.sku,
        gtin: "", quantity: "1",
        globalPrice: listing.selling_price ? String(listing.selling_price) : "",
        salePrice: "", saleStartDate: "", saleEndDate: "",
      }]);
      return;
    }
    const combos = axesDef.reduce<Record<string, string>[]>(
      (acc, axis) => {
        if (!axis.values.length) return acc;
        return acc.flatMap((c) => axis.values.map((v) => ({ ...c, [axis.name]: v })));
      },
      [{}]
    );
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
  const [saveError,   setSaveError]   = useState<string | null>(null);
  const [jumiaNotConnected, setJumiaNotConnected] = useState(false);
  const [publishedRef, setPublishedRef] = useState<string | null>(null);
  const [syncStatus, setSyncStatus]   = useState<"idle" | "saving" | "done" | "error">("idle");

  // ── Auto-analyze state (one-click category detection + attribute fill) ────
  type AnalyzeStep = "idle" | "describing" | "retrieving" | "ranking" | "filling" | "done" | "error";
  const [analyzeStep,   setAnalyzeStep]   = useState<AnalyzeStep>("idle");
  const [analyzeError,  setAnalyzeError]  = useState<string | null>(null);
  const [analyzePrompt, setAnalyzePrompt] = useState<string>("");
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

  // ── Polish state ──────────────────────────────────────────────────────────
  const [polishing, setPolishing] = useState(false);
  const [polishMsg, setPolishMsg] = useState<string | null>(null);

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
      setPolishMsg(`Polished ${data.replaced ?? 0} of ${data.total ?? 0} images.`);
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
  if (descriptionValue.length < 50)  validationErrors.push("Description must be at least 50 characters (Jumia hard limit).");
  if (descriptionValue.length > 9000) validationErrors.push("Description must be 9,000 characters or fewer.");
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

    const fd  = new FormData(formRef.current);
    const str = (key: string) => (fd.get(key) as string | null)?.trim() || null;
    const num = (key: string) => {
      const v = (fd.get(key) as string | null)?.trim();
      return v ? parseFloat(v) : null;
    };

    // Merge spec rich-text fields into dynamic_attributes
    const mergedDyn = {
      ...dynAttrs,
      ...(note             ? { note }                             : {}),
      ...(fda              ? { fda }                              : {}),
      ...(fromManufacturer ? { from_the_manufacturer: fromManufacturer } : {}),
      ...(whatsInTheBox    ? { whats_in_the_box: whatsInTheBox } : {}),
    };

    const sellingPrice = variants[0]?.globalPrice
      ? parseFloat(variants[0].globalPrice)
      : (listing.selling_price ?? 0);

    // Schema-driven form edits cached in columnOverrides override anything
    // typed into the static UI. Walks each override → routes via
    // attribute-mapping → merges into the listing update payload.
    const overrideColumnUpdates: Record<string, unknown> = {};
    for (const [attr, val] of Object.entries(columnOverrides)) {
      const { columnUpdate } = fieldChangeToUpdate(attr, val);
      if (columnUpdate) Object.assign(overrideColumnUpdates, columnUpdate);
    }

    try {
      await updateListing(listing.id, {
        title:              titleValue.trim() || null,
        description:        descriptionValue.trim() || null,
        highlights:         highlightsValue.trim() || null,
        brand:              brandValue || null,
        color:              str("color"),
        color_family:       colorFamily || null,
        weight_kg:          num("weight"),
        selling_price:      sellingPrice > 0 ? sellingPrice : null,
        main_material:      str("main_material"),
        material_family:    materialFamily || null,
        model:              str("model"),
        product_line:       str("product_line"),
        production_country: productionCountry || null,
        certifications:     certification
                              ? certification.split(",").map((s) => s.trim()).filter(Boolean)
                              : [],
        warranty_duration:  warrantyDuration || null,
        warranty_type:      warrantyType || null,
        warranty_text:      str("product_warranty"),
        warranty_address:   str("warranty_address"),
        youtube_id:         str("youtube_id"),
        category_code:      categoryCode,
        category_path:      categoryPath,
        dynamic_attributes: mergedDyn,
        quality_score:      qualityResult.score,
        status:             listing.status === "live" ? "live" : "draft",
        ...(axesDef.length === 0 ? {
          quantity: Math.max(0, parseInt(variants[0]?.quantity ?? "1") || 1),
        } : {}),
        // Schema-driven overrides last → they win over the static UI values.
        ...overrideColumnUpdates,
      });

      if (!publish) {
        if (!opts?.skipRedirect) router.push("/listings");
        return;
      }

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
        setSaveError(pushData.error ?? "Jumia submission failed.");
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed.");
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
            {publishedRef && (
              <div className="flex items-center gap-3 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                Submitted to Jumia (feed ID: <code className="font-mono text-xs">{publishedRef}</code>).
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

              {/* Image grid */}
              <ImageGrid images={listing.images ?? []} />

              {/* One-click Analyze with AI CTA — full pipeline */}
              {(listing.images?.length ?? 0) > 0 && (
                <AnalyzeWithAICard
                  step={analyzeStep}
                  error={analyzeError}
                  result={analyzeResult}
                  prompt={analyzePrompt}
                  onPromptChange={setAnalyzePrompt}
                  onStart={handleAutoAnalyze}
                />
              )}

              {/* Polish CTA — only when images exist */}
              {(listing.images?.length ?? 0) > 0 && (
                <div className="flex items-center justify-between gap-3 rounded-md border border-violet-200 bg-violet-50/60 px-3 py-2">
                  <div className="flex items-center gap-2 text-xs text-violet-700">
                    <Sparkles className="h-3.5 w-3.5" />
                    <span className="font-medium">Polish images</span>
                    <span className="text-violet-500">— remove background, add white BG + soft shadow</span>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    onClick={handlePolishImages}
                    disabled={polishing}
                    className="h-7 text-xs gap-1.5 bg-violet-500 hover:bg-violet-600 text-white"
                  >
                    {polishing
                      ? <><Loader2 className="h-3 w-3 animate-spin" /> Polishing…</>
                      : <><Sparkles className="h-3 w-3" /> Polish all</>}
                  </Button>
                </div>
              )}
              {polishMsg && <p className="text-xs text-emerald-600">{polishMsg}</p>}

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
                  {refillMsg && !refillingAttributes && (
                    <p className="text-[11px] text-emerald-600">{refillMsg}</p>
                  )}
                </div>
              </div>

              {/* Conditional fields — only after category is picked */}
              {categoryCode && (
                <>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    <div className="space-y-1.5">
                      <Label className="text-xs font-semibold text-zinc-700 flex items-center">
                        Brand<Required />
                        <ConfidenceDot
                          source={listing.field_confidence?.["brand"]?.source}
                          confidence={listing.field_confidence?.["brand"]?.confidence}
                        />
                      </Label>
                      <BrandCombobox value={brandValue} onChange={setBrandValue} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="color" className="text-xs font-semibold text-zinc-700 flex items-center">
                        Color
                        <ConfidenceDot
                          source={listing.field_confidence?.["color"]?.source}
                          confidence={listing.field_confidence?.["color"]?.confidence}
                        />
                      </Label>
                      <Input
                        id="color" name="color"
                        defaultValue={listing.color ?? ""}
                        placeholder="Ex: Midnight Black, Navy Blue"
                        className="h-10 text-sm"
                      />
                      <p className="text-[11px] text-zinc-500">
                        Separate multiple colors with commas.
                        <span className="text-orange-600"> Required to increase listing quality.</span>
                      </p>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs font-semibold text-zinc-700 flex items-center">
                        Color family
                        <ConfidenceDot
                          source={listing.field_confidence?.["color_family"]?.source}
                          confidence={listing.field_confidence?.["color_family"]?.confidence}
                        />
                      </Label>
                      <MultiSelectDropdown
                        options={[...colorFamilies]}
                        value={colorFamily}
                        onChange={setColorFamily}
                        placeholder="Ex: Black, Blue [pick one or more]"
                      />
                      <p className="text-[11px] text-orange-600">Required to increase listing quality · select multiple</p>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="weight" className="text-xs font-semibold text-zinc-700">
                        Weight (kg)<Required />
                      </Label>
                      <Input
                        id="weight" name="weight" type="number" step="0.01" min="0"
                        defaultValue={listing.weight_kg?.toString() ?? ""}
                        placeholder="Ex: 1.2 kg [Weight of the product]"
                        className="h-10 text-sm"
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs font-semibold text-zinc-700">
                      Product description<Required />
                    </Label>
                    <RichTextField
                      id="description"
                      value={descriptionValue}
                      onChange={setDescriptionValue}
                      rows={4}
                      placeholder="- Include only product - related information.- Write clearly and concisely.- Make sure the description matches your product images.- Testimonials or quotes of any kind are not allowed - No promotional messages or promoting other products except the product itself."
                    />
                    <p className={cn(
                      "text-[11px]",
                      descriptionValue.length === 0    ? "text-zinc-400" :
                      descriptionValue.length < 50     ? "text-red-500"  :
                      descriptionValue.length < 80     ? "text-amber-600" :
                      descriptionValue.length > 9000   ? "text-red-500"  :
                                                         "text-emerald-600"
                    )}>
                      {descriptionValue.length} characters · Jumia requires 50–9,000 · aim for 200+ for a good quality score
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs font-semibold text-zinc-700">
                      Highlights<Required />
                    </Label>
                    <RichTextField
                      id="highlights"
                      value={highlightsValue}
                      onChange={setHighlightsValue}
                      rows={3}
                      placeholder="[Key features in bullet points, minimum of 4 for a good content score] Ex: - Lightweight design - Noise cancellation - 20 - hour battery life - Wireless connectivity"
                    />
                    <p className={cn(
                      "text-[11px]",
                      highlightsValue.length === 0 ? "text-zinc-400" :
                      highlightsValue.length < 50  ? "text-amber-600" :
                                                     "text-emerald-600"
                    )}>
                      {highlightsValue.length} characters · 4+ bullets starting with • recommended
                    </p>
                  </div>

                  {/* Note: Category-specific attributes render in the Product
                      Specification section below, NOT here — matching Jumia
                      VC's structure where Product Information ends at
                      Highlights and Specification starts at Certifications. */}
                </>
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
                    axes={axesDef}
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

              <p className="text-xs text-zinc-400 flex items-start gap-1">
                <Info className="h-3 w-3 shrink-0 mt-0.5" />
                Commission shown at {commissionPercent}% (incl. VAT). Net payout per unit:{" "}
                <span className="font-semibold text-emerald-600">
                  {sellingPrice > 0 ? formatGHS(netPayout) : "—"}
                </span>
              </p>
            </section>

            {/* ────────────── Section 3: Product Specification ──────────────
                Now 100% driven by Jumia's category schema. The SchemaForm
                component fetches GET /api/jumia/categories/{code}/attributes
                and renders every field with the correct type (text, number,
                date, multi-select, etc.). Backing store is decided per-field
                by lib/jumia/attribute-mapping — most universal fields land
                in their first-class column; truly category-specific ones
                land in dynamic_attributes.

                The legacy static layout is preserved below (kept hidden for
                now) so the existing FormData-based save still works.
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

            {/* ────────────── Legacy static spec section (HIDDEN) ──────────
                Kept in the DOM so the form still works during transition.
                Will be deleted in a follow-up once the schema-driven form
                is verified end-to-end. */}
            <section style={{ display: "none" }} className="bg-white rounded-md border border-zinc-200 p-6 space-y-5 scroll-mt-6">
              <h2 className="text-lg font-bold text-zinc-900">Product Specification</h2>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold text-zinc-700">Certifications</Label>
                  <MultiSelectDropdown
                    options={[...certifications]}
                    value={certification}
                    onChange={setCertification}
                    placeholder="Ex: ISO 9001, CE [pick one or more]"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="main_material" className="text-xs font-semibold text-zinc-700">Main material</Label>
                  <Input
                    id="main_material" name="main_material"
                    defaultValue={listing.main_material ?? ""}
                    placeholder="Ex: Stainless Steel [Main material used in the pr..."
                    className="h-10 text-sm"
                  />
                  <p className="text-[11px] text-orange-600">Required to increase listing quality</p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold text-zinc-700">Material family</Label>
                  <Select value={materialFamily} onValueChange={setMaterialFamily}>
                    <SelectTrigger className="h-10 text-sm">
                      <SelectValue placeholder="Ex: Metal [Broad category of materials that the..." />
                    </SelectTrigger>
                    <SelectContent>
                      {materialFamilies.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-orange-600">Required to increase listing quality</p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="model" className="text-xs font-semibold text-zinc-700">Model</Label>
                  <Input
                    id="model" name="model"
                    defaultValue={listing.model ?? ""}
                    placeholder="Ex: MD-1234 [Model ID or manufacturer part nu..."
                    className="h-10 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="note_field" className="text-xs font-semibold text-zinc-700">Note</Label>
                  <Input
                    id="note_field"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Ex: Limited availability during holiday season [C..."
                    className="h-10 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold text-zinc-700">Production country</Label>
                  <Select value={productionCountry} onValueChange={setProductionCountry}>
                    <SelectTrigger className="h-10 text-sm">
                      <SelectValue placeholder="Ex: China [Country where the product is manuf..." />
                    </SelectTrigger>
                    <SelectContent>
                      {productionCountries.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="product_line" className="text-xs font-semibold text-zinc-700">Product Line</Label>
                  <Input
                    id="product_line" name="product_line"
                    defaultValue={listing.product_line ?? ""}
                    placeholder="Ex: Alpha Series [Line, range, or sub-brand und..."
                    className="h-10 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="size_field" className="text-xs font-semibold text-zinc-700">Size (L x W x H cm)</Label>
                  <Input
                    id="size_field" name="size_field"
                    defaultValue={
                      listing.size_l && listing.size_w && listing.size_h
                        ? `${listing.size_l} × ${listing.size_w} × ${listing.size_h}`
                        : ""
                    }
                    placeholder="Ex: 10 × 8 × 5 cm [Dimensions of the product; C..."
                    className="h-10 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold text-zinc-700">Warranty Duration</Label>
                  <Select value={warrantyDuration} onValueChange={setWarrantyDuration}>
                    <SelectTrigger className="h-10 text-sm">
                      <SelectValue placeholder="Ex: 2 years [Length of warranty coverage for t..." />
                    </SelectTrigger>
                    <SelectContent>
                      {warrantyDurations.map((w) => <SelectItem key={w} value={w}>{w}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-orange-600">Required to increase listing quality</p>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold text-zinc-700">Warranty Type</Label>
                  <Select value={warrantyType} onValueChange={setWarrantyType}>
                    <SelectTrigger className="h-10 text-sm">
                      <SelectValue placeholder="Ex: Service center - Lagos [Type of warranty of..." />
                    </SelectTrigger>
                    <SelectContent>
                      {warrantyTypes.map((w) => <SelectItem key={w} value={w}>{w}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="youtube_id" className="text-xs font-semibold text-zinc-700">Youtube ID</Label>
                  <Input
                    id="youtube_id" name="youtube_id"
                    defaultValue={listing.youtube_id ?? ""}
                    placeholder="Ex: a1b2c3d4 [ID for an associated YouTube vid..."
                    className="h-10 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="fda_field" className="text-xs font-semibold text-zinc-700">FDA</Label>
                  <Input
                    id="fda_field"
                    value={fda}
                    onChange={(e) => setFda(e.target.value)}
                    placeholder="Ex: E1452773G [Indicates FOOD And Drug Agen..."
                    className="h-10 text-sm"
                  />
                </div>
              </div>

              {/* Category-specific dynamic fields — these change PER category.
                  Empty for categories with no extras beyond the static ones
                  above. Auto-loads schema from Jumia when category changes. */}
              {categoryCode && (
                <div className="border-t pt-5">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-3">
                    Category-specific fields
                  </p>
                  <CategoryDynamicFields
                    categoryCode={categoryCode}
                    values={dynAttrs}
                    onChange={(k, v) => setDynAttrs((p) => ({ ...p, [k]: v }))}
                  />
                </div>
              )}

              {/* Rich text spec fields */}
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold text-zinc-700">From the Manufacturer</Label>
                <RichTextField
                  id="from_manufacturer"
                  value={fromManufacturer}
                  onChange={setFromManufacturer}
                  rows={3}
                  placeholder="Ex: Made with high - quality materials for durability and performance.[Text from the manufacturer describing the product]"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs font-semibold text-zinc-700">What&apos;s in the box</Label>
                <RichTextField
                  id="whats_in_the_box"
                  value={whatsInTheBox}
                  onChange={setWhatsInTheBox}
                  rows={3}
                  placeholder="Ex: 1x Headphone, 1x Charging Cable, 1x User Manual [Contents included with the product in the package]"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs font-semibold text-zinc-700">Product warranty</Label>
                <RichTextField
                  id="product_warranty"
                  defaultValue={listing.warranty_text ?? ""}
                  rows={3}
                  placeholder="Ex: 1 year limited warranty [Warranty terms covering the product]"
                />
                <p className="text-[11px] text-orange-600">Required to increase listing quality</p>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs font-semibold text-zinc-700">Warranty Address</Label>
                <RichTextField
                  id="warranty_address"
                  defaultValue={listing.warranty_address ?? ""}
                  rows={3}
                  placeholder="Ex: 123 Service St, City [Address for warranty-related services]"
                />
              </div>
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
              Quality {qualityResult.score}/{PUBLISH_THRESHOLD}
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
    </div>
  );
}
