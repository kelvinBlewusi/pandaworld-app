"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ExternalLink, Loader2, Send, Plus, Check, ChevronRight, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusPill } from "@/components/ui/status-pill";
import { CategoryDrawer } from "@/components/ui/category-drawer";
import { cn } from "@/lib/utils";
import { updateListing, replaceVariantsForListing } from "@/lib/actions/listings";
import { SchemaForm } from "@/components/jumia/SchemaForm";
import { VariantCard, buildAxisCombos } from "@/components/jumia/VariantCard";
import { columnFor, fieldChangeToUpdate } from "@/lib/jumia/attribute-mapping";
import { STATIC_FIELDS, universalInfoFields } from "@/lib/jumia/universal-fields";
import { reviewUrl } from "@/lib/whatsapp/draft";
import type { ListingRow, ListingStatus, VariantRow as VariantRowDB } from "@/lib/supabase/types";
import type { JumiaCategoryAttribute } from "@/lib/jumia/categories";
import type { VariantRow, AxisDef } from "@/lib/jumia/variant-types";

/**
 * The "focused editor" — a single-product form scoped to exactly what
 * Jumia asks for in that product's category, reached by tapping a link
 * the WhatsApp bot sends once a chat-drafted product finishes analysis
 * (see lib/whatsapp/intake.ts). Deliberately much simpler than the full
 * editor (app/(main)/listings/[id]/review/review-client.tsx): no AI-assist
 * tooling, no quality score, no category picker, no bulk variant actions —
 * just this product's fields, editable, with Save and Submit.
 *
 * Variants ARE supported (a chat-drafted product can already come out of
 * runAutoAnalyze with more than one — the same analysis pipeline the web
 * flow uses) via the same VariantCard/VariantRow the full editor uses, so
 * a seller never lands here to find their color/size variants missing.
 * The common single-variant case stays a plain Price/Stock pair — no
 * variant chrome shows until there's a real reason for it.
 *
 * Modeled on components/extension/whatsapp-listings-view.tsx's existing
 * Price/Stock + Save + Push pattern, extended with a SchemaForm block for
 * the category-specific fields that view doesn't show.
 */
export function WhatsAppFocusedEditor({
  listing: initialListing,
  initialVariants = [],
}: {
  listing: ListingRow;
  initialVariants?: VariantRowDB[];
}) {
  const router = useRouter();
  const [listing, setListing] = useState(initialListing);
  const [title, setTitle]     = useState(initialListing.title ?? "");
  const [status, setStatus]   = useState<ListingStatus>(initialListing.status);

  // Same two-store pattern as the full editor: dynAttrs for
  // dynamic_attributes-backed fields, columnOverrides for fields that map
  // to a first-class column (color, weight_kg, main_material, ...).
  const [dynAttrs, setDynAttrs] = useState<Record<string, string>>(
    (initialListing.dynamic_attributes ?? {}) as Record<string, string>,
  );
  const [columnOverrides, setColumnOverrides] = useState<Record<string, string>>({});

  // ── Category — same drawer + refill-on-change flow as the full editor ──
  // A chat-drafted product can reach here with no category at all (the AI
  // couldn't confidently pick one), which used to be a dead end: the only
  // fix was the full editor. categoryCode/categoryPath are local state
  // (not read from `listing`) so SchemaForm reacts the instant a category
  // is picked, matching review-client.tsx's own pattern.
  const [categoryCode, setCategoryCode] = useState<string | null>(initialListing.category_code);
  const [categoryPath, setCategoryPath] = useState<string | null>(initialListing.category_path);
  const [categoryName, setCategoryName] = useState(
    initialListing.category_path?.split("/").pop()?.trim() ?? "",
  );
  const [showCategoryPicker, setShowCategoryPicker] = useState(false);
  const [refillingAttributes, setRefillingAttributes] = useState(false);
  const [refillError, setRefillError] = useState<string | null>(null);

  const handleCategoryChange = async (cat: { code: number; name: string; path: string }) => {
    const previousCode = categoryCode;
    setCategoryCode(String(cat.code));
    setCategoryPath(cat.path);
    setCategoryName(cat.name);
    if (String(cat.code) === previousCode) return;

    setRefillingAttributes(true);
    setRefillError(null);
    try {
      const res = await fetch(`/api/listings/${listing.id}/refill-attributes?mode=schema-only`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categoryCode: cat.code, categoryPath: cat.path }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRefillError(data.error ?? "Couldn't fetch category fields from Jumia.");
        return;
      }
      setDynAttrs((data.dynamic_attributes as Record<string, string>) ?? {});
      setColumnOverrides({});
      router.refresh();
    } catch (e) {
      setRefillError(e instanceof Error ? e.message : "Couldn't fetch category fields.");
    } finally {
      setRefillingAttributes(false);
    }
  };

  // ── Variants — same shape and hydration as the full editor ────────────
  // Hydrate from persisted rows (set by auto-analyze when the AI detected
  // variations, or a previous save). No persisted rows yet → seed one
  // synthetic "Default" row from the listing's own price/quantity, same
  // as the full editor — Jumia requires a non-empty variation even for a
  // simple single-variant product.
  const [variants, setVariants] = useState<VariantRow[]>(() => {
    if (initialVariants.length > 0) {
      return initialVariants.map((v, i) => ({
        id:            `v-db-${i}`,
        axes:          {},
        variation:     v.variation        ?? "",
        sellerSku:     v.seller_sku       ?? `${initialListing.sku}-${i + 1}`,
        gtin:          v.gtin             ?? "",
        quantity:      String(v.quantity ?? 1),
        globalPrice:   v.global_price != null ? String(v.global_price) : "",
        salePrice:     v.sale_price   != null ? String(v.sale_price)   : "",
        saleStartDate: v.sale_start_date  ?? "",
        saleEndDate:   v.sale_end_date    ?? "",
      }));
    }
    return [{
      id: "v1", axes: {}, variation: "Default", sellerSku: initialListing.sku,
      gtin: "", quantity: String(initialListing.quantity ?? 1),
      globalPrice: initialListing.selling_price ? String(initialListing.selling_price) : "",
      salePrice: "", saleStartDate: "", saleEndDate: "",
    }];
  });
  const [axesDef, setAxesDef]           = useState<AxisDef[]>([]);
  const [collapsedVariants, setCollapsedVariants] = useState<Set<string>>(new Set());
  const [schemaAxes, setSchemaAxes]     = useState<JumiaCategoryAttribute[]>([]);

  const multiVariant = variants.length > 1 || axesDef.length > 0;

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

  // Rebuild variant rows from active axis values (Color, Size, etc.), same
  // logic as the full editor — leaves variants alone when no axes are
  // active so a previously-saved or AI-detected multi-variant list never
  // silently collapses back to one row.
  useEffect(() => {
    if (axesDef.length === 0) return;
    const combos = buildAxisCombos(axesDef);
    if (combos.length === 0) return;
    setVariants((prev) =>
      combos.map((combo) => {
        const key = Object.values(combo).map((v) => v.replace(/\s+/g, "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 4)).join("-");
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
      }),
    );
  }, [axesDef, listing.sku]);

  const [saving, setSaving] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [message, setMessage] = useState<{ type: "ok" | "error"; text: string } | null>(null);

  function handleFieldChange(attributeName: string, value: string) {
    if (columnFor(attributeName)) {
      setColumnOverrides((prev) => ({ ...prev, [attributeName]: value }));
    } else {
      setDynAttrs((prev) => ({ ...prev, [attributeName]: value }));
    }
  }

  const updateVariant = (id: string, field: keyof VariantRow, value: string) => {
    setVariants((prev) => prev.map((v) => (v.id === id ? { ...v, [field]: value } : v)));
  };
  const toggleCollapse = (id: string) => {
    setCollapsedVariants((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const deleteVariant = (id: string) => {
    if (variants.length === 1) return;
    setVariants((p) => p.filter((v) => v.id !== id));
  };
  const addVariation = () => {
    const newId  = `v-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const suffix = String(variants.length + 1).padStart(2, "0");
    setVariants((prev) => [
      ...prev,
      {
        id: newId, axes: {}, variation: "", sellerSku: `${listing.sku}-${suffix}`,
        gtin: "", quantity: "1", globalPrice: prev[0]?.globalPrice ?? "",
        salePrice: "", saleStartDate: "", saleEndDate: "",
      },
    ]);
  };
  const addAxis = (attr: JumiaCategoryAttribute) => {
    if (axesDef.find((a) => a.name === attr.name)) return;
    setAxesDef((p) => [...p, { name: attr.name, label: attr.label, values: [], allowedValues: attr.allowed_values }]);
  };
  const removeAxis = (name: string) => setAxesDef((p) => p.filter((a) => a.name !== name));
  const toggleAxisValue = (axisName: string, value: string) =>
    setAxesDef((p) => p.map((a) =>
      a.name === axisName
        ? { ...a, values: a.values.includes(value) ? a.values.filter((v) => v !== value) : [...a.values, value] }
        : a,
    ));

  const overrideValues: Record<string, string> = { ...dynAttrs, ...columnOverrides };
  const needsPrice = !variants[0]?.globalPrice?.trim();
  const needsCategory = !categoryCode;
  const canPush = status === "draft" || status === "failed";

  const persist = useCallback(async (): Promise<boolean> => {
    const sellingPrice = variants[0]?.globalPrice ? parseFloat(variants[0].globalPrice) : null;

    const overrideColumnUpdates: Record<string, unknown> = {};
    for (const [attr, val] of Object.entries(columnOverrides)) {
      const { columnUpdate } = fieldChangeToUpdate(attr, val);
      if (columnUpdate) Object.assign(overrideColumnUpdates, columnUpdate);
    }

    try {
      const updated = await updateListing(listing.id, {
        title: title.trim() || null,
        category_code: categoryCode,
        category_path: categoryPath,
        ...(sellingPrice != null && sellingPrice > 0 ? { selling_price: sellingPrice } : {}),
        // Only mirror quantity onto the listing row when there's no real
        // variant axis in play — with active axes, per-variant quantity in
        // the variants table is the only meaningful number (same rule the
        // full editor uses).
        ...(axesDef.length === 0
          ? { quantity: Math.max(0, parseInt(variants[0]?.quantity ?? "1", 10) || 1) }
          : {}),
        dynamic_attributes: { ...dynAttrs },
        ...overrideColumnUpdates,
      });
      setListing(updated);

      await replaceVariantsForListing(
        listing.id,
        variants.map((v) => ({
          variation:       v.variation?.trim() || null,
          seller_sku:      v.sellerSku?.trim()  || null,
          gtin:            v.gtin?.trim()       || null,
          quantity:        Math.max(0, parseInt(v.quantity || "1", 10) || 1),
          global_price:    v.globalPrice ? parseFloat(v.globalPrice) : null,
          sale_price:      v.salePrice   ? parseFloat(v.salePrice)   : null,
          sale_start_date: v.saleStartDate || null,
          sale_end_date:   v.saleEndDate   || null,
        })),
      );
      return true;
    } catch (e) {
      setMessage({ type: "error", text: (e as Error).message });
      return false;
    }
  }, [listing.id, title, variants, axesDef.length, dynAttrs, columnOverrides]);

  async function handleSave() {
    setSaving(true);
    setMessage(null);
    const ok = await persist();
    if (ok) setMessage({ type: "ok", text: "Saved." });
    setSaving(false);
  }

  async function handlePush() {
    setPushing(true);
    setMessage(null);
    // Submit always saves first — a seller should never push stale data by
    // forgetting to tap Save, and there's no reason a failed validation
    // here should also lose their edits.
    const saved = await persist();
    if (!saved) {
      setPushing(false);
      return;
    }
    try {
      // Send variants from local UI state, same guarantee the full editor
      // makes: what's on screen at click time is what reaches Jumia,
      // regardless of any DB persistence timing.
      const pushVariants = variants.map((v) => ({
        variation:     v.variation?.trim()  || "",
        sellerSku:     v.sellerSku?.trim()  || `${listing.sku}-${v.id.slice(0, 4)}`,
        gtin:          v.gtin?.trim()       || null,
        quantity:      Math.max(0, parseInt(v.quantity || "1", 10) || 1),
        globalPrice:   v.globalPrice ? parseFloat(v.globalPrice) : null,
        salePrice:     v.salePrice   ? parseFloat(v.salePrice)   : null,
        saleStartDate: v.saleStartDate || null,
        saleEndDate:   v.saleEndDate   || null,
      }));
      const res = await fetch("/api/jumia/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listingId: listing.id, variants: pushVariants }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setStatus("pending_approval");
        setMessage({ type: "ok", text: "Submitted — pending Jumia review." });
      } else {
        setMessage({ type: "error", text: data.error ?? data.message ?? "Push failed." });
      }
    } catch {
      setMessage({ type: "error", text: "Network error — please try again." });
    } finally {
      setPushing(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Link
        href="/extension/whatsapp-listings"
        className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-500 hover:text-zinc-800"
      >
        <ArrowLeft className="h-3 w-3" />
        Back to WhatsApp listings
      </Link>

      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-orange-600">Edit product</p>
          <h1 className="mt-1 text-xl font-bold text-zinc-900">{title || "(untitled)"}</h1>
        </div>
        <StatusPill status={status} />
      </div>

      {listing.images.length > 0 && (
        <div className="flex gap-2 overflow-x-auto">
          {listing.images.map((url, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={i} src={url} alt="" className="h-20 w-20 shrink-0 rounded-lg object-cover" />
          ))}
        </div>
      )}

      <div className="space-y-4 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
        <div>
          <Label className="text-xs text-zinc-500">Product name</Label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1" />
        </div>

        {!multiVariant && (
          <>
            <div className="flex gap-4">
              <div className="flex-1">
                <Label className="text-xs text-zinc-500">Price (GHS)</Label>
                <Input
                  type="number"
                  value={variants[0]?.globalPrice ?? ""}
                  onChange={(e) => updateVariant(variants[0].id, "globalPrice", e.target.value)}
                  placeholder="0.00"
                  className={cn("mt-1", needsPrice && "border-amber-300")}
                />
              </div>
              <div className="flex-1">
                <Label className="text-xs text-zinc-500">Stock</Label>
                <Input
                  type="number"
                  value={variants[0]?.quantity ?? ""}
                  onChange={(e) => updateVariant(variants[0].id, "quantity", e.target.value)}
                  placeholder="1"
                  className="mt-1"
                />
              </div>
            </div>
            <button
              type="button"
              onClick={addVariation}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-orange-600 hover:text-orange-700"
            >
              <Plus className="h-3.5 w-3.5" /> Add a variation (color, size, etc.)
            </button>
          </>
        )}
        <div>
          <Label className="text-xs text-zinc-500 flex items-center gap-2">
            Category
            {refillingAttributes && <Loader2 className="h-3 w-3 animate-spin text-orange-500" />}
          </Label>
          <button
            type="button"
            onClick={() => setShowCategoryPicker(true)}
            disabled={refillingAttributes}
            className={cn(
              "mt-1 flex h-10 w-full items-center justify-between rounded-md border bg-white px-3 text-sm text-left transition-colors",
              categoryName ? "border-zinc-200 text-zinc-800" : "border-amber-300 text-zinc-400",
              refillingAttributes && "opacity-60 cursor-not-allowed",
            )}
          >
            <span className="truncate">{categoryName || "Pick a category"}</span>
            <ChevronRight className="h-4 w-4 shrink-0 text-zinc-400" />
          </button>
          {refillError && (
            <p className="mt-1 flex items-start gap-1 text-[11px] text-red-600">
              <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" /> {refillError}
            </p>
          )}
        </div>
      </div>

      {multiVariant && (
        <div className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-zinc-800">Variants</h2>

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
                      onClick={() => (active ? removeAxis(a.name) : addAxis(a))}
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                        active
                          ? "border-orange-500 bg-orange-500 text-white"
                          : "border-zinc-200 bg-white text-zinc-600 hover:border-orange-300",
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
                              : "border-zinc-200 bg-white text-zinc-500 hover:border-zinc-300",
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

          <div className="space-y-3">
            {variants.map((v) => (
              <VariantCard
                key={v.id}
                variant={v}
                collapsed={collapsedVariants.has(v.id)}
                onUpdate={(field, value) => updateVariant(v.id, field, value)}
                onToggleCollapse={() => toggleCollapse(v.id)}
                onDelete={() => deleteVariant(v.id)}
              />
            ))}
          </div>

          <button
            type="button"
            onClick={addVariation}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-zinc-300 bg-white py-3 text-xs font-semibold text-orange-500 hover:border-orange-300 hover:bg-orange-50 transition-colors"
          >
            <Plus className="h-3.5 w-3.5" /> ADD VARIATION
          </button>
        </div>
      )}

      {needsCategory ? (
        <div className="rounded-md border border-dashed border-zinc-300 bg-zinc-50/50 p-6 text-center text-sm text-zinc-500">
          Pick a category above to see this product's Jumia fields.
        </div>
      ) : (
        <SchemaForm
          categoryCode={categoryCode}
          listing={listing}
          overrideValues={overrideValues}
          onFieldChange={handleFieldChange}
          excludeNames={STATIC_FIELDS}
          extraFields={universalInfoFields()}
          excludeVariants
          cols={2}
        />
      )}

      {message && (
        <p className={cn("text-sm", message.type === "ok" ? "text-emerald-600" : "text-red-600")}>{message.text}</p>
      )}
      {needsPrice && !message && (
        <p className="text-xs text-amber-600">No price yet — set one above before submitting.</p>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-zinc-100 pt-4">
        <Button variant="outline" onClick={handleSave} disabled={saving || pushing}>
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          Save
        </Button>
        {canPush && (
          <Button onClick={handlePush} disabled={saving || pushing} className="gap-1.5">
            {pushing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Submit to Jumia
          </Button>
        )}
        <Link
          href={reviewUrl(listing.id)}
          className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-zinc-400 hover:text-zinc-700"
        >
          Full editor <ExternalLink className="h-3 w-3" />
        </Link>
      </div>

      <CategoryDrawer
        open={showCategoryPicker}
        onClose={() => setShowCategoryPicker(false)}
        onSelect={handleCategoryChange}
        initialPath={categoryPath ?? undefined}
      />
    </div>
  );
}
