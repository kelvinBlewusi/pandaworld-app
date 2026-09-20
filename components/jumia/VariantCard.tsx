"use client";

import { ChevronDown, ChevronUp, Trash2, Calendar as CalendarIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { isValidGTIN } from "@/lib/utils/gtin";
import type { VariantRow, AxisDef } from "@/lib/jumia/variant-types";

function Required() {
  return <span className="ml-0.5 text-orange-500">*</span>;
}

/**
 * One variant's edit card, matching Jumia's own Variants-step layout.
 * Shared between the full editor (app/(main)/listings/[id]/review/review-client.tsx)
 * and the WhatsApp focused editor (components/extension/whatsapp-focused-editor.tsx).
 *
 * The selection checkbox only renders when the caller passes
 * onToggleSelect — the full editor uses it to drive its "Collapse All" /
 * "Select All" bulk-action row, but the focused editor has no bulk
 * actions, and a checkbox with nothing wired to it would just confuse a
 * seller tapping it and seeing no effect.
 */
export function VariantCard({
  variant,
  selected,
  collapsed,
  onUpdate,
  onToggleSelect,
  onToggleCollapse,
  onDelete,
  variationOptions,
}: {
  variant: VariantRow;
  selected?: boolean;
  collapsed: boolean;
  onUpdate: (field: keyof VariantRow, value: string) => void;
  onToggleSelect?: () => void;
  onToggleCollapse: () => void;
  onDelete: () => void;
  /**
   * The category's own fixed list of variation options (e.g. screen sizes,
   * shoe lengths) — present exactly when the category declares a SINGLE
   * variant axis with its own allowed_values, mirroring what Jumia's own
   * Vendor Center shows in its Variation dropdown for that same category
   * (including a literal "..." entry when Jumia's schema offers one, for a
   * seller who can't tell which option applies).
   *
   * When given and non-empty, the Variation field renders as a dropdown of
   * exactly these options instead of free text — Jumia genuinely doesn't
   * accept anything else for a category like this, so offering free text
   * only sets a seller up for a rejection. Omitted (or empty) for a
   * category with no restricted axis, where free text is genuinely fine,
   * or one with more than one axis, where the separate "Variant axes"
   * picker above already builds the right composite value per combo.
   */
  variationOptions?: string[];
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
          {onToggleSelect && (
            <input
              type="checkbox"
              checked={selected ?? false}
              onChange={onToggleSelect}
              onClick={(e) => e.stopPropagation()}
              className="h-4 w-4 rounded border-zinc-300 text-orange-500 focus:ring-orange-500"
            />
          )}
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
              {variationOptions && variationOptions.length > 0 ? (
                <>
                  <Select value={variant.variation} onValueChange={(v) => onUpdate("variation", v)}>
                    <SelectTrigger className="h-10 text-sm">
                      <SelectValue placeholder="Select an option" />
                    </SelectTrigger>
                    <SelectContent>
                      {/* The variant's current value may be a stale guess
                          from before this category's options were known —
                          shown here rather than silently dropped, so the
                          seller sees exactly what's set and can replace it. */}
                      {variant.variation && !variationOptions.includes(variant.variation) && (
                        <SelectItem value={variant.variation}>{variant.variation} (current)</SelectItem>
                      )}
                      {variationOptions.map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <p className="text-[10px] text-zinc-400">
                    This category only accepts one of its own stocked options — pick the one that matches,
                    or &quot;...&quot; if you&apos;re not sure which applies.
                  </p>
                </>
              ) : (
                <>
                  <Input
                    placeholder={Object.values(variant.axes ?? {}).filter(Boolean).join(" / ") || "..."}
                    value={variant.variation}
                    onChange={(e) => onUpdate("variation", e.target.value)}
                    className="h-10 text-sm"
                  />
                  <p className="text-[10px] text-zinc-400">
                    Label that distinguishes this variant — e.g. &quot;3 Set (Trowel, Fork &amp; Cultivator)&quot;,
                    &quot;Hoe only&quot;, &quot;Pack of 6&quot;, &quot;Large&quot;, &quot;Red&quot;.
                  </p>
                </>
              )}
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

/** Cartesian product of active axis values → one combo per variant row. */
export function buildAxisCombos(axesDef: AxisDef[]): Record<string, string>[] {
  return axesDef.reduce<Record<string, string>[]>(
    (acc, axis) => {
      if (!axis.values.length) return acc;
      return acc.flatMap((c) => axis.values.map((v) => ({ ...c, [axis.name]: v })));
    },
    [{}],
  );
}

/** Short, uppercased, alphanumeric-only abbreviation — used to build SKU suffixes. */
export function abbr(v: string, n = 4): string {
  return v.replace(/\s+/g, "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, n);
}
