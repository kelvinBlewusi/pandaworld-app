"use client";

import { useState, useRef, useEffect } from "react";
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

// ─── Types ────────────────────────────────────────────────────────────────────

interface Variant {
  id: string;
  variation: string;
  sellerSku: string;
  gtin: string;
  quantity: string;
  globalPrice: string;
  salePrice: string;
  saleStartDate: string;
  saleEndDate: string;
}

// ─── Field quality badges ─────────────────────────────────────────────────────

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

// ─── Rich-text field ─────────────────────────────────────────────────────────

function RichTextField({
  id,
  label,
  placeholder,
  defaultValue,
  required,
  quality,
  hint,
  rows = 4,
}: {
  id: string;
  label: string;
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
  quality?: boolean;
  hint?: string;
  rows?: number;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="flex items-center">
        {label}
        {required && <RequiredBadge />}
        {quality && <QualityBadge />}
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
      />
      {hint && <p className="text-[11px] text-zinc-400">{hint}</p>}
    </div>
  );
}

// ─── Step 1 — Product Information ────────────────────────────────────────────

function ProductInformationStep({
  listing,
  colorFamily,
  setColorFamily,
}: {
  listing: ListingRow;
  colorFamily: string;
  setColorFamily: (v: string) => void;
}) {
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
          Image must be between 500×500 and 2000×2000 pixels. White backgrounds recommended. No watermarks. Max 2MB.
        </p>
      </div>

      {/* Basic fields */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="name" className="flex items-center">
            Product Name <RequiredBadge />
          </Label>
          <Input
            id="name"
            name="name"
            defaultValue={listing.title ?? ""}
            placeholder="Ex: Wireless Noise-Cancelling Headphones"
            maxLength={70}
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
            <button type="button" className="flex items-center gap-1 rounded-lg border px-3 py-2 text-xs font-medium text-blue-600 hover:bg-blue-50">
              Change <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
          <p className="text-[11px] text-zinc-400">{listing.category_path ?? ""}</p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="brand">Brand</Label>
          <Input id="brand" name="brand" defaultValue={listing.brand ?? ""} placeholder="Brand name" />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="color" className="flex items-center">Color <RequiredBadge /></Label>
          <Input id="color" name="color" defaultValue={listing.color ?? ""} placeholder="Main color of product" />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="color-family" className="flex items-center">
            Color Family <QualityBadge />
          </Label>
          <Select value={colorFamily} onValueChange={setColorFamily}>
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
          <Label htmlFor="weight" className="flex items-center">Weight (kg) <QualityBadge /></Label>
          <Input
            id="weight"
            name="weight"
            type="number"
            step="0.01"
            min="0"
            defaultValue={listing.weight_kg?.toString() ?? ""}
            placeholder="Ex: 1.2"
          />
        </div>
      </div>

      <RichTextField
        id="description"
        label="Product Description"
        required
        placeholder="Include only product-related information. Write clearly and concisely."
        defaultValue={listing.description ?? ""}
        rows={5}
        hint="Minimum content required for a good score."
      />

      <RichTextField
        id="highlights"
        label="Highlights"
        quality
        placeholder="Key features in bullet points. Ex: • Lightweight design • Noise cancellation"
        defaultValue={listing.highlights ?? ""}
        rows={4}
        hint="At least 4 bullet points for a good content score."
      />
    </div>
  );
}

// ─── Step 2 — Variants ───────────────────────────────────────────────────────

function VariantsStep({
  variants,
  setVariants,
  commissionRate,
  commissionPercent,
}: {
  variants: Variant[];
  setVariants: React.Dispatch<React.SetStateAction<Variant[]>>;
  commissionRate: number;
  commissionPercent: number;
}) {
  const addVariant = () => {
    setVariants((prev) => [
      ...prev,
      {
        id: `v${Date.now()}`,
        variation: "",
        sellerSku: "",
        gtin: "",
        quantity: "1",
        globalPrice: prev[0]?.globalPrice ?? "",
        salePrice: "",
        saleStartDate: "",
        saleEndDate: "",
      },
    ]);
  };

  const removeVariant = (id: string) => {
    if (variants.length === 1) return;
    setVariants((prev) => prev.filter((v) => v.id !== id));
  };

  const update = (id: string, field: keyof Variant, value: string) => {
    setVariants((prev) =>
      prev.map((v) => (v.id === id ? { ...v, [field]: value } : v))
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-500">Add one row per variant (e.g. different sizes or colours).</p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="gap-1 text-xs" type="button" disabled>
            <CalendarIcon className="h-3.5 w-3.5" /> Edit Date
          </Button>
          <Button variant="outline" size="sm" className="text-xs" type="button" disabled>
            Bulk Edit
          </Button>
        </div>
      </div>

      {variants.map((v, idx) => {
        const net = v.globalPrice ? calcNetPayout(parseFloat(v.globalPrice), commissionRate) : null;
        return (
          <div key={v.id} className="rounded-xl border bg-zinc-50/50 p-4 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <input type="checkbox" className="h-4 w-4 rounded" />
                <span className="text-sm font-medium text-zinc-700">
                  Variation {idx + 1}{v.quantity ? `, Quantity (${v.quantity})` : ""}
                </span>
              </div>
              {variants.length > 1 && (
                <button type="button" onClick={() => removeVariant(v.id)} className="rounded-lg p-1 text-zinc-400 hover:bg-red-50 hover:text-red-500">
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Variation <RequiredBadge /></Label>
                <Input placeholder="e.g. Red / XL / 128GB" value={v.variation} onChange={(e) => update(v.id, "variation", e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Seller SKU <RequiredBadge /></Label>
                <Input value={v.sellerSku} onChange={(e) => update(v.id, "sellerSku", e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">GTIN / Barcode</Label>
                <Input placeholder="GTIN Barcode" value={v.gtin} onChange={(e) => update(v.id, "gtin", e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Quantity <RequiredBadge /></Label>
                <Input type="number" min="0" value={v.quantity} onChange={(e) => update(v.id, "quantity", e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Global Price (GHS) <RequiredBadge /></Label>
                <div className="relative">
                  <Input type="number" min="0" step="0.01" placeholder="Global Price" value={v.globalPrice} onChange={(e) => update(v.id, "globalPrice", e.target.value)} className="pr-12" />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium text-zinc-400">GHS</span>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Sale Price (GHS)</Label>
                <div className="relative">
                  <Input type="number" min="0" step="0.01" placeholder="Sale Price" value={v.salePrice} onChange={(e) => update(v.id, "salePrice", e.target.value)} className="pr-12" />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium text-zinc-400">GHS</span>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Sale Start Date</Label>
                <Input type="date" value={v.saleStartDate} onChange={(e) => update(v.id, "saleStartDate", e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Sale End Date</Label>
                <Input type="date" value={v.saleEndDate} onChange={(e) => update(v.id, "saleEndDate", e.target.value)} />
              </div>
            </div>

            {net !== null && (
              <div className="flex items-center justify-between rounded-lg border bg-white px-3 py-2 text-xs">
                <span className="text-zinc-500">Est. net payout after {commissionPercent}% commission</span>
                <span className="font-semibold text-emerald-600">{formatGHS(net)}</span>
              </div>
            )}

            {variants.length > 1 && (
              <div className="flex justify-end">
                <button type="button" onClick={() => removeVariant(v.id)} className="flex items-center gap-1 text-xs text-zinc-400 hover:text-red-500">
                  <Trash2 className="h-3.5 w-3.5" /> Delete
                </button>
              </div>
            )}
          </div>
        );
      })}

      <button
        type="button"
        onClick={addVariant}
        className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-zinc-200 py-3 text-sm font-medium text-zinc-500 transition-colors hover:border-blue-300 hover:bg-blue-50/40 hover:text-blue-600"
      >
        <Plus className="h-4 w-4" /> ADD VARIATION
      </button>
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
}) {
  return (
    <div className="space-y-5">
      {/* Certifications */}
      <div>
        <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-zinc-400">Certifications & Standards</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="cert">Certifications</Label>
            <Select value={certification} onValueChange={setCertification}>
              <SelectTrigger id="cert"><SelectValue placeholder="Ex: ISO 9001" /></SelectTrigger>
              <SelectContent>
                {certifications.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="fda">FDA</Label>
            <Input id="fda" name="fda" placeholder="Ex: E1452773G" />
          </div>
        </div>
      </div>

      {/* Material */}
      <div>
        <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-zinc-400">Material & Construction</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="material" className="flex items-center">Main Material <QualityBadge /></Label>
            <Input id="material" name="material" defaultValue={listing.main_material ?? ""} placeholder="Ex: Stainless Steel" />
            <p className="text-[11px] text-amber-600">Required to increase listing quality</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="material-family" className="flex items-center">Material Family <QualityBadge /></Label>
            <Select value={materialFamily} onValueChange={setMaterialFamily}>
              <SelectTrigger id="material-family"><SelectValue placeholder="Ex: Metal" /></SelectTrigger>
              <SelectContent>
                {materialFamilies.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-amber-600">Required to increase listing quality</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="size">Size (L × W × H cm)</Label>
            <Input
              id="size"
              name="size"
              defaultValue={
                listing.size_l && listing.size_w && listing.size_h
                  ? `${listing.size_l} × ${listing.size_w} × ${listing.size_h}`
                  : ""
              }
              placeholder="Ex: 30 × 20 × 5"
            />
          </div>
        </div>
      </div>

      {/* Product identity */}
      <div>
        <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-zinc-400">Product Identity</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="model">Model</Label>
            <Input id="model" name="model" defaultValue={listing.model ?? ""} placeholder="Model ID or manufacturer part number" />
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
            <Label htmlFor="note">Note</Label>
            <Input id="note" name="note" placeholder="Ex: Limited availability during holiday season" />
          </div>
        </div>
      </div>

      {/* Warranty */}
      <div>
        <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-zinc-400">Warranty Information</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="warranty-duration" className="flex items-center">Warranty Duration <QualityBadge /></Label>
            <Select value={warrantyDuration} onValueChange={setWarrantyDuration}>
              <SelectTrigger id="warranty-duration"><SelectValue placeholder="Ex: 2 years" /></SelectTrigger>
              <SelectContent>
                {warrantyDurations.map((w) => <SelectItem key={w} value={w}>{w}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-amber-600">Required to increase listing quality</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="warranty-type">Warranty Type</Label>
            <Select value={warrantyType} onValueChange={setWarrantyType}>
              <SelectTrigger id="warranty-type"><SelectValue placeholder="Ex: Service Center" /></SelectTrigger>
              <SelectContent>
                {warrantyTypes.map((w) => <SelectItem key={w} value={w}>{w}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="mt-4 grid gap-4">
          <RichTextField id="product-warranty" label="Product Warranty" defaultValue={listing.warranty_text ?? ""} placeholder="Detailed warranty terms…" rows={3} />
          <RichTextField id="warranty-address" label="Warranty Address" defaultValue={listing.warranty_address ?? ""} placeholder="Service center name and address…" rows={2} />
        </div>
      </div>

      {/* Additional */}
      <div>
        <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-zinc-400">Additional Details</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="youtube-id">YouTube Video ID</Label>
            <Input id="youtube-id" name="youtube-id" defaultValue={listing.youtube_id ?? ""} placeholder="Ex: a1b2c3d4" />
          </div>
        </div>
        <div className="mt-4 grid gap-4">
          <RichTextField id="from-manufacturer" label="From the Manufacturer" placeholder="Official manufacturer product information…" rows={3} />
          <RichTextField id="whats-in-box" label="What&apos;s in the Box" placeholder="List all package contents…" rows={3} />
        </div>
      </div>
    </div>
  );
}

// ─── Step 4 — Category-specific Jumia Attributes ─────────────────────────────

interface AttrSchema {
  name:           string;
  label:          string;
  type:           "enum" | "string" | "number" | "boolean" | "multi";
  allowed_values: string[];
  required:       boolean;
}

function CategoryAttributesStep({
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

  useEffect(() => {
    if (!categoryCode || isNaN(Number(categoryCode)) || Number(categoryCode) === 0) {
      setLoading(false);
      return;
    }
    fetch(`/api/jumia/categories/${categoryCode}/attributes`)
      .then((r) => r.json())
      .then((d) => setSchema(d.attributes ?? []))
      .catch(() => setSchema([]))
      .finally(() => setLoading(false));
  }, [categoryCode]);

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
      <div className="rounded-xl border border-dashed border-zinc-200 py-10 text-center text-sm text-zinc-400">
        No category-specific fields for this category.
      </div>
    );
  }

  // Group: required first, then optional
  const required = schema.filter((a) => a.required);
  const optional = schema.filter((a) => !a.required);

  const renderField = (attr: AttrSchema) => {
    const val = values[attr.name] ?? "";

    if (attr.type === "boolean") {
      return (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => onChange(attr.name, val === "true" ? "false" : "true")}
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
        <Select value={val} onValueChange={(v) => onChange(attr.name, v)}>
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
                  const next = active
                    ? selected.filter((s) => s !== v)
                    : [...selected, v];
                  onChange(attr.name, next.join(", "));
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
        onChange={(e) => onChange(attr.name, e.target.value)}
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
        These are the exact fields Jumia requires for this category. Fields marked <span className="text-red-500 font-bold mx-0.5">*</span> are required for your listing to be accepted.
      </div>

      {required.length > 0 && renderGroup(required, "Required fields", "text-red-500")}
      {optional.length > 0 && renderGroup(optional, "Optional fields", "text-zinc-400")}
    </div>
  );
}

// ─── Main review client ───────────────────────────────────────────────────────

const formSteps = [
  { id: 1, label: "Product Information" },
  { id: 2, label: "Category Fields" },
  { id: 3, label: "Variants" },
  { id: 4, label: "Specification" },
];

export function ReviewClient({ listing }: { listing: ListingRow }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [formStep, setFormStep] = useState(1);

  // ── Controlled select state ───────────────────────────────────────────────
  const [colorFamily, setColorFamily] = useState(listing.color_family ?? "");
  const [certification, setCertification] = useState(listing.certifications?.[0] ?? "");
  const [materialFamily, setMaterialFamily] = useState(listing.material_family ?? "");
  const [productionCountry, setProductionCountry] = useState(listing.production_country ?? "");
  const [warrantyDuration, setWarrantyDuration] = useState(listing.warranty_duration ?? "");
  const [warrantyType, setWarrantyType] = useState(listing.warranty_type ?? "");

  // ── Lifted variants state ─────────────────────────────────────────────────
  const commissionRate = listing.commission_rate ?? 0.1;
  const commissionPercent = Math.round(commissionRate * 100);
  const [variants, setVariants] = useState<Variant[]>([
    {
      id: "v1",
      variation: "",
      sellerSku: listing.sku,
      gtin: "",
      quantity: "1",
      globalPrice: listing.selling_price ? String(listing.selling_price) : "",
      salePrice: "",
      saleStartDate: "",
      saleEndDate: "",
    },
  ]);

  // ── Dynamic category attributes ───────────────────────────────────────────
  const [dynAttrs, setDynAttrs] = useState<Record<string, string>>(
    (listing.dynamic_attributes as Record<string, string>) ?? {}
  );

  // ── Save state ────────────────────────────────────────────────────────────
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // ── Derived display values ────────────────────────────────────────────────
  const cat = mockCategories.find((c) => c.id === listing.category_id);
  const sellingPrice = variants[0]?.globalPrice
    ? parseFloat(variants[0].globalPrice)
    : (listing.selling_price ?? 0);
  const netPayout = sellingPrice > 0 ? calcNetPayout(sellingPrice, commissionRate) : 0;
  const thumbnail = listing.images?.[0] ?? null;
  const titleDisplay = listing.title ?? "Untitled listing";
  const categoryLabel = listing.category_path ?? listing.category_id ?? "Uncategorised";

  // ── Save handler ──────────────────────────────────────────────────────────
  async function handleSave(publish: boolean) {
    if (!formRef.current) return;
    setSaving(true);
    setSaveError(null);

    const fd = new FormData(formRef.current);
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
        brand:              str("brand"),
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
        dynamic_attributes: dynAttrs,
        status:             publish ? "pending_approval" : "draft",
      });

      router.push("/listings");
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed. Please try again.");
      setSaving(false);
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
          <StatusPill status={listing.status} />
          <MarketplaceBadge marketplace="jumia" />
        </div>
      </div>

      {/* Category path banner */}
      {cat && (
        <div className="flex items-center gap-2 rounded-xl border bg-zinc-50 px-4 py-2.5 text-xs text-zinc-500">
          <span className="shrink-0 font-semibold text-zinc-700">Category:</span>
          <span className="truncate">{cat.path}</span>
          <span className="shrink-0 rounded-full bg-zinc-200 px-1.5 py-0.5 text-[10px] font-mono text-zinc-500">{cat.code}</span>
          <button type="button" className="ml-auto shrink-0 text-blue-500 hover:text-blue-600 font-medium">Change</button>
        </div>
      )}

      {/* Two-column layout */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[360px_1fr]">

        {/* ── LEFT — AI Preview (sticky) ─────────────────────────────────── */}
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
                  <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[9px] font-bold text-blue-600">AI</span>
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
                  <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[9px] font-bold text-blue-600">AI</span>
                </div>
                <button type="button" className="rounded p-0.5 text-zinc-400 hover:text-blue-500">
                  <RefreshCw className="h-3 w-3" />
                </button>
              </div>
              <p className="text-[11px] text-zinc-600 leading-relaxed line-clamp-4">
                {listing.description ?? `This is a high-quality ${titleDisplay}. Suitable for everyday use.`}
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

        {/* ── RIGHT — 3-step Jumia form ──────────────────────────────────── */}
        <div className="space-y-4">
          <div className="rounded-2xl border bg-white shadow-sm overflow-hidden">

            {/* Step tabs */}
            <div className="flex border-b">
              {formSteps.map((s) => {
                const isActive = formStep === s.id;
                const isDone = formStep > s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setFormStep(s.id)}
                    className={cn(
                      "flex flex-1 items-center justify-center gap-2 border-r px-3 py-3.5 text-xs font-medium transition-colors last:border-r-0",
                      isActive ? "border-b-2 border-b-orange-500 bg-orange-50 text-orange-700"
                        : isDone ? "bg-zinc-50 text-zinc-400 hover:bg-zinc-100"
                        : "text-zinc-400 hover:bg-zinc-50"
                    )}
                  >
                    <span className={cn(
                      "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold",
                      isActive ? "bg-orange-500 text-white"
                        : isDone ? "bg-emerald-500 text-white"
                        : "bg-zinc-200 text-zinc-500"
                    )}>
                      {isDone ? <Check className="h-3 w-3" /> : s.id}
                    </span>
                    <span className="hidden sm:block">{s.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Form — all steps stay mounted so FormData can collect all inputs */}
            <form ref={formRef} onSubmit={(e) => e.preventDefault()}>
              <div className="p-5">
                <motion.div
                  key={formStep}
                  initial={{ opacity: 0, x: 8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.15 }}
                >
                  {/* Always rendered — only active step is visible */}
                  <div className={formStep !== 1 ? "hidden" : ""}>
                    <ProductInformationStep
                      listing={listing}
                      colorFamily={colorFamily}
                      setColorFamily={setColorFamily}
                    />
                  </div>
                  <div className={formStep !== 2 ? "hidden" : ""}>
                    <CategoryAttributesStep
                      categoryCode={listing.category_code}
                      values={dynAttrs}
                      onChange={(k, v) => setDynAttrs((prev) => ({ ...prev, [k]: v }))}
                    />
                  </div>
                  <div className={formStep !== 3 ? "hidden" : ""}>
                    <VariantsStep
                      variants={variants}
                      setVariants={setVariants}
                      commissionRate={commissionRate}
                      commissionPercent={commissionPercent}
                    />
                  </div>
                  <div className={formStep !== 4 ? "hidden" : ""}>
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
                    />
                  </div>
                </motion.div>
              </div>

              {/* Error banner */}
              {saveError && (
                <div className="mx-5 mb-3 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700">
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  {saveError}
                </div>
              )}

              {/* Footer */}
              <div className="flex items-center justify-between border-t bg-zinc-50/50 px-5 py-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setFormStep((s) => Math.max(1, s - 1))}
                  disabled={formStep === 1 || saving}
                >
                  <ArrowLeft className="h-3.5 w-3.5 mr-1" /> Previous
                </Button>

                <div className="flex items-center gap-1.5">
                  {formSteps.map((s) => (
                    <div
                      key={s.id}
                      className={cn(
                        "h-1.5 rounded-full transition-all",
                        formStep === s.id ? "w-5 bg-orange-500"
                          : formStep > s.id ? "w-3 bg-emerald-400"
                          : "w-1.5 bg-zinc-300"
                      )}
                    />
                  ))}
                </div>

                {formStep < formSteps.length ? (
                  <Button
                    type="button"
                    size="sm"
                    className="bg-orange-500 hover:bg-orange-600"
                    onClick={() => setFormStep((s) => Math.min(formSteps.length, s + 1))}
                    disabled={saving}
                  >
                    Next <ChevronRight className="h-3.5 w-3.5 ml-1" />
                  </Button>
                ) : (
                  <div className="flex gap-2">
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
                      className="gap-1 bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700"
                      disabled={saving}
                      onClick={() => handleSave(true)}
                    >
                      {saving
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <Check className="h-3.5 w-3.5" />}
                      Approve & publish
                    </Button>
                  </div>
                )}
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
