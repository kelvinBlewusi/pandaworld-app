"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Loader2, Send, Plus, Check, ChevronRight, AlertCircle, Eye, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusPill } from "@/components/ui/status-pill";
import { CategoryDrawer } from "@/components/ui/category-drawer";
import { cn } from "@/lib/utils";
import { updateListing, replaceVariantsForListing } from "@/lib/actions/listings";
import { SchemaForm } from "@/components/jumia/SchemaForm";
import { VariantCard, buildAxisCombos } from "@/components/jumia/VariantCard";
import { columnFor, fieldChangeToUpdate, readAttributeValue } from "@/lib/jumia/attribute-mapping";
import { STATIC_FIELDS, universalInfoFields } from "@/lib/jumia/universal-fields";
import type { ListingRow, ListingStatus, VariantRow as VariantRowDB } from "@/lib/supabase/types";
import type { JumiaCategoryAttribute } from "@/lib/jumia/categories";
import type { VariantRow, AxisDef } from "@/lib/jumia/variant-types";

/**
 * The "focused editor" — a single-product form scoped to exactly what
 * Jumia asks for in that product's category, reached by tapping a link
 * the WhatsApp bot sends once a chat-drafted product finishes analysis
 * (see lib/whatsapp/intake.ts). Deliberately much simpler than the full
 * editor (app/(main)/listings/[id]/review/review-client.tsx): no AI-assist
 * tooling, no quality score, no image add or reorder (a photo can be
 * removed, owner 2026-10-07: "an x icon on the image cards"), no bulk
 * variant actions — just this product's fields, editable, with Save and
 * Submit. A category picker WAS added later (CategoryDrawer below) so a
 * WhatsApp-only seller isn't forced out to the full editor just to fix
 * a wrong category — see handleCategoryChange.
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
/** The shape /api/jumia/preview returns — the real payload, not a
 *  description of it. */
interface JumiaPreview {
  products: {
    name?:        { value?: string };
    description?: { value?: string };
    parentSku?:   string;
    sellerSku?:   string;
    variation?:   string;
    brand?:       { code?: number; name?: string };
    category?:    { code?: number; name?: string };
    images?:      { url: string; primary?: boolean }[];
    price?:       { value?: number; currency?: string };
    stock?:       number;
    attributes?:  { name: string; value: string }[];
  }[];
  adjustments:      string[];
  missing_required: string[];
  blockers:         string[];
}

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

  // Straight to a full AI refill on pick — same one-action collapse as
  // review-client.tsx's handleCategoryChange, doubly important here since
  // a chat-drafted product landing on this page with no category at all
  // means the seller is actively correcting a low-confidence AI pick and
  // wants a filled-in listing back, not another empty form to type into.
  const handleCategoryChange = async (cat: { code: number; name: string; path: string }) => {
    const previousCode = categoryCode;
    setCategoryCode(String(cat.code));
    setCategoryPath(cat.path);
    setCategoryName(cat.name);
    if (String(cat.code) === previousCode) return;

    setRefillingAttributes(true);
    setRefillError(null);
    try {
      const res = await fetch(`/api/listings/${listing.id}/refill-attributes`, {
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
        // A variant with no sale of its own goes to Jumia with the
        // listing's (mapListingToJumiaProducts), which is where a sale set
        // in chat lands, so that's what it shows. Live, 2026-10-07: "Sale
        // 100 from 20th October to 28th October" was set and this was blank.
        ...(v.sale_price != null
          ? { salePrice: String(v.sale_price), saleStartDate: v.sale_start_date ?? "", saleEndDate: v.sale_end_date ?? "" }
          : {
              salePrice:     initialListing.sale_price != null ? String(initialListing.sale_price) : "",
              saleStartDate: initialListing.sale_price != null ? initialListing.sale_start_date ?? "" : "",
              saleEndDate:   initialListing.sale_price != null ? initialListing.sale_end_date ?? "" : "",
            }),
      }));
    }
    return [{
      id: "v1", axes: {}, variation: "Default", sellerSku: initialListing.sku,
      gtin: "", quantity: String(initialListing.quantity ?? 1),
      globalPrice: initialListing.selling_price ? String(initialListing.selling_price) : "",
      // Same fallback as globalPrice above, for the same reason — a
      // sale price stated in chat before any variant row exists lands
      // on the listing itself (see migration
      // 2026-09-13_listing-sale-price.sql), so show it here rather than
      // a blank field that looks like it never registered.
      salePrice:     initialListing.sale_price != null ? String(initialListing.sale_price) : "",
      saleStartDate: initialListing.sale_start_date ?? "",
      saleEndDate:   initialListing.sale_end_date   ?? "",
    }];
  });
  const [axesDef, setAxesDef]           = useState<AxisDef[]>([]);
  const [collapsedVariants, setCollapsedVariants] = useState<Set<string>>(new Set());
  const [schemaAxes, setSchemaAxes]     = useState<JumiaCategoryAttribute[]>([]);

  // Whether the seller has deliberately opened the variants section.
  //
  // This used to be inferred purely from `variants.length > 1`, and that
  // one line caused both halves of a reported bug. A simple product holds
  // ONE synthetic "Default" row (Jumia requires a non-empty variation even
  // for a single-variant product), and at length 1 that row is hidden
  // behind the plain Price/Stock form. So:
  //
  //   tap "Add a variation" → length 2 → the hidden row APPEARS alongside
  //   the new one, and one tap looks like it created two fields.
  //
  //   delete one → length 1 → the whole section vanishes, which reads as
  //   having deleted everything rather than one row.
  //
  // Sticky now: once opened it stays open, so the count never silently
  // decides what the seller is looking at.
  //
  // Starts open when the ONE persisted row already carries a real
  // variation string — a category with a single free-text variant axis
  // (colour, say) can come out of auto-analyze with exactly one row whose
  // `variation` is "Black", not the synthetic "Default" placeholder.
  // Defaulting to collapsed hid that value behind "+ Add a variation",
  // which reads as "nothing here" rather than "here's what the AI wrote,
  // edit it" — the seller only found it by tapping Add, which then also
  // appended a second, unwanted blank row alongside it.
  const [variantsOpen, setVariantsOpen] = useState(() => {
    if (initialVariants.length !== 1) return false;
    const v = initialVariants[0].variation?.trim();
    return !!v && v.toLowerCase() !== "default";
  });
  const multiVariant = variantsOpen || variants.length > 1 || axesDef.length > 0;

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

  // Same rule as the full editor: a category whose ONLY variant axis is a
  // fixed list (screen sizes, shoe lengths) can't accept anything else for
  // its Variation field — Jumia's own Vendor Center shows exactly this
  // axis's options as a dropdown, not free text. Scoped to exactly one
  // axis; two or more is what the "Variant axes" picker below is for.
  const singleAxisVariationOptions =
    schemaAxes.length === 1 && schemaAxes[0].allowed_values.length > 0
      ? schemaAxes[0].allowed_values
      : undefined;

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
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<JumiaPreview | null>(null);
  const [message, setMessage] = useState<{ type: "ok" | "error"; text: string } | null>(null);
  // The photos that go to Jumia: one can be removed (the X on its card), never the last.
  const [images, setImages] = useState<string[]>(initialListing.images ?? []);
  const [removing, setRemoving] = useState<string | null>(null);
  const photosEditable = !["pending_approval", "processing", "live"].includes(status);

  async function removeImage(url: string) {
    if (images.length <= 1 || removing) return;
    const before = images;
    const next = images.filter((u) => u !== url);
    setImages(next);
    setRemoving(url);
    try {
      const saved = await updateListing(listing.id, { images: next });
      setListing(saved);
      setMessage({ type: "ok", text: "Photo removed: it won't be sent to Jumia." });
    } catch {
      setImages(before);
      setMessage({ type: "error", text: "That photo wasn't removed. Check your connection and try again." });
    } finally {
      setRemoving(null);
    }
  }

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
    // Opening is explicit, and separate from the row count — see
    // variantsOpen. Without this the first tap reveals the hidden
    // synthetic row too, and looks like it added two.
    setVariantsOpen(true);
    setVariants((prev) => {
      // Suffix from the highest one ALREADY in use, not from the row
      // count. Counting breaks as soon as a middle row is deleted: two
      // rows ending -01 and -03, delete -03, add → count says -02, and a
      // -02 may well be sitting right there. Jumia rejects the feed on a
      // duplicate seller SKU, so this has to be unique, not merely tidy.
      const used = new Set(prev.map((v) => v.sellerSku));
      let n = prev.reduce((max, v) => {
        const m = /-(\d+)$/.exec(v.sellerSku);
        return m ? Math.max(max, Number(m[1])) : max;
      }, prev.length);
      let sku = "";
      do { n += 1; sku = `${listing.sku}-${String(n).padStart(2, "0")}`; } while (used.has(sku));
      return [
        ...prev,
        {
          id: `v-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          axes: {}, variation: "", sellerSku: sku,
          gtin: "", quantity: "1", globalPrice: prev[0]?.globalPrice ?? "",
          salePrice: "", saleStartDate: "", saleEndDate: "",
        },
      ];
    });
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

  // Column-backed fields must render from the COLUMN, never from a stale
  // dynamic_attributes copy of the same name.
  //
  // Confirmed live: this page showed a different Product description than
  // the full editor for the same listing, because auto-analyze writes BOTH
  // listings.description (rich HTML, Pass A) and a plain-text
  // dynamic_attributes.description (the category schema's own attribute),
  // and `{ ...dynAttrs, ...columnOverrides }` renders the dynAttrs one
  // until the seller happens to edit the field — columnOverrides is empty
  // on first render. Jumia's product description comes from the COLUMN
  // (see buildBaseProduct in lib/jumia/api.ts), so this page was showing
  // the one value that does NOT reach Jumia as the description.
  //
  // The full editor never had this bug because it appends explicit
  // description/highlights/brand mirrors after the spread. Doing it by
  // column mapping instead of by hardcoded name covers every such field,
  // including ones added to ATTRIBUTE_TO_COLUMN later.
  const overrideValues: Record<string, string> = { ...dynAttrs };
  for (const name of Array.from(new Set([
    ...Object.keys(dynAttrs),
    ...universalInfoFields().map((f) => f.name),
  ]))) {
    if (columnFor(name)) overrideValues[name] = readAttributeValue(listing, name);
  }
  Object.assign(overrideValues, columnOverrides);
  const needsPrice = !variants[0]?.globalPrice?.trim();
  const needsCategory = !categoryCode;
  const canPush = status === "draft" || status === "failed";

  const persist = useCallback(async (): Promise<boolean> => {
    const sellingPrice = variants[0]?.globalPrice ? parseFloat(variants[0].globalPrice) : null;
    // The listing's sale is what a variant with none of its own falls back
    // to. Saved here as the variants' shared sale, or none when they differ,
    // so a sale cleared or changed here can't come back from the listing.
    const sales = new Set(variants.map((v) => `${v.salePrice.trim()}|${v.saleStartDate}|${v.saleEndDate}`));
    const shared = sales.size === 1 && variants[0]?.salePrice.trim() ? variants[0] : null;
    const listingSale = {
      sale_price:      shared ? parseFloat(shared.salePrice) : null,
      sale_start_date: shared?.saleStartDate || null,
      sale_end_date:   shared?.saleEndDate || null,
    };

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
        ...listingSale,
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

  /** The variant payload, exactly as a push would send it. Shared with
   *  the preview so the two can never describe different states. */
  function currentVariantPayload() {
    return variants.map((v) => ({
      variation:     v.variation?.trim()  || "",
      sellerSku:     v.sellerSku?.trim()  || `${listing.sku}-${v.id.slice(0, 4)}`,
      gtin:          v.gtin?.trim()       || null,
      quantity:      Math.max(0, parseInt(v.quantity || "1", 10) || 1),
      globalPrice:   v.globalPrice ? parseFloat(v.globalPrice) : null,
      salePrice:     v.salePrice   ? parseFloat(v.salePrice)   : null,
      saleStartDate: v.saleStartDate || null,
      saleEndDate:   v.saleEndDate   || null,
    }));
  }

  async function handlePreview() {
    setPreviewing(true);
    setMessage(null);
    try {
      // Sends the LIVE form state, unsaved edits included — previewing
      // what is on screen is the whole point, and making the seller save
      // first would mean the preview answers a question about a different
      // version than the one they are looking at.
      const res = await fetch("/api/jumia/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listingId: listing.id, variants: currentVariantPayload() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ type: "error", text: data.error ?? "Couldn't build the preview." });
        return;
      }
      setPreview(data as JumiaPreview);
    } catch {
      setMessage({ type: "error", text: "Network error — please try again." });
    } finally {
      setPreviewing(false);
    }
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
      const pushVariants = currentVariantPayload();
      const res = await fetch("/api/jumia/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listingId: listing.id, variants: pushVariants }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setStatus("pending_approval");
        // Name anything Jumia did not receive as written. Silently
        // "succeeding" while a value the seller typed was dropped is the
        // failure mode this exists to end.
        const adjusted = (data.adjustments ?? []) as string[];
        setMessage({
          type: "ok",
          text: adjusted.length > 0
            ? `Submitted — pending Jumia review. Note: ${adjusted.join("; ")}.`
            : "Submitted — pending Jumia review.",
        });
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
    <div className="mx-auto max-w-2xl space-y-6 rounded-3xl bg-zinc-100/70 p-4 sm:p-6">
      <Link
        href="/extension/whatsapp-listings"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-zinc-500 hover:text-zinc-800"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to WhatsApp listings
      </Link>

      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-widest text-orange-600">Edit product</p>
          <h1 className="mt-1 text-2xl font-bold text-zinc-900">{title || "(untitled)"}</h1>
        </div>
        <StatusPill status={status} />
      </div>

      {images.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pt-1">
          {images.map((url, i) => (
            <div key={url} className={cn("relative h-20 w-20 shrink-0", removing === url && "opacity-50")}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={url} alt={`Photo ${i + 1}`} className="h-20 w-20 rounded-lg object-cover" />
              {photosEditable && images.length > 1 && (
                <button
                  type="button"
                  onClick={() => void removeImage(url)}
                  disabled={removing != null}
                  aria-label={`Remove photo ${i + 1}`}
                  title="Remove this photo"
                  className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/65 text-white shadow transition-colors hover:bg-red-600 disabled:opacity-50"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="space-y-4 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
        <div>
          <Label className="text-sm text-zinc-500">Product name</Label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1 h-11 text-base" />
        </div>

        {!multiVariant && (
          <>
            <div className="flex gap-4">
              <div className="flex-1">
                <Label className="text-sm text-zinc-500">Price (GHS)</Label>
                <Input
                  type="number"
                  value={variants[0]?.globalPrice ?? ""}
                  onChange={(e) => updateVariant(variants[0].id, "globalPrice", e.target.value)}
                  placeholder="0.00"
                  className={cn("mt-1 h-11 text-base", needsPrice && "border-amber-300")}
                />
              </div>
              <div className="flex-1">
                <Label className="text-sm text-zinc-500">Stock</Label>
                <Input
                  type="number"
                  value={variants[0]?.quantity ?? ""}
                  onChange={(e) => updateVariant(variants[0].id, "quantity", e.target.value)}
                  placeholder="1"
                  className="mt-1 h-11 text-base"
                />
              </div>
            </div>
            <button
              type="button"
              onClick={addVariation}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-orange-600 hover:text-orange-700"
            >
              <Plus className="h-4 w-4" /> Add a variation (color, size, etc.)
            </button>
          </>
        )}
        <div>
          <Label className="text-sm text-zinc-500 flex items-center gap-2">
            Category
            {refillingAttributes && <Loader2 className="h-3.5 w-3.5 animate-spin text-orange-500" />}
          </Label>
          <button
            type="button"
            onClick={() => setShowCategoryPicker(true)}
            disabled={refillingAttributes}
            className={cn(
              "mt-1 flex h-11 w-full items-center justify-between rounded-md border bg-white px-3 text-base text-left transition-colors",
              categoryName ? "border-zinc-200 text-zinc-800" : "border-amber-300 text-zinc-400",
              refillingAttributes && "opacity-60 cursor-not-allowed",
            )}
          >
            <span className="truncate">{categoryName || "Pick a category"}</span>
            <ChevronRight className="h-5 w-5 shrink-0 text-zinc-400" />
          </button>
          {refillError && (
            <p className="mt-1 flex items-start gap-1 text-sm text-red-600">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> {refillError}
            </p>
          )}
        </div>
      </div>

      {multiVariant && (
        <div className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-semibold text-zinc-800">Variants</h2>

          {schemaAxes.length > 0 && (
            <div className="rounded-md border border-zinc-200 bg-zinc-50/50 p-3 space-y-2">
              <p className="text-sm font-semibold text-zinc-600">Variant axes</p>
              <div className="flex flex-wrap gap-1.5">
                {schemaAxes.map((a) => {
                  const active = !!axesDef.find((x) => x.name === a.name);
                  return (
                    <button
                      key={a.name}
                      type="button"
                      onClick={() => (active ? removeAxis(a.name) : addAxis(a))}
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-sm font-medium transition-colors",
                        active
                          ? "border-orange-500 bg-orange-500 text-white"
                          : "border-zinc-200 bg-white text-zinc-600 hover:border-orange-300",
                      )}
                    >
                      {active && <Check className="inline h-3.5 w-3.5 mr-1" />}
                      {a.label}
                    </button>
                  );
                })}
              </div>
              {axesDef.map((axis) => (
                <div key={axis.name} className="space-y-1">
                  <p className="text-xs font-medium text-zinc-500">{axis.label} values</p>
                  <div className="flex flex-wrap gap-1">
                    {axis.allowedValues.map((v) => {
                      const sel = axis.values.includes(v);
                      return (
                        <button
                          key={v}
                          type="button"
                          onClick={() => toggleAxisValue(axis.name, v)}
                          className={cn(
                            "rounded-full border px-2 py-0.5 text-xs transition-colors",
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
                variationOptions={singleAxisVariationOptions}
              />
            ))}
          </div>

          <button
            type="button"
            onClick={addVariation}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-zinc-300 bg-white py-3 text-sm font-semibold text-orange-500 hover:border-orange-300 hover:bg-orange-50 transition-colors"
          >
            <Plus className="h-4 w-4" /> ADD VARIATION
          </button>
        </div>
      )}

      {needsCategory ? (
        <div className="rounded-md border border-dashed border-zinc-300 bg-zinc-50/50 p-6 text-center text-base text-zinc-500">
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
        <p className={cn("text-base", message.type === "ok" ? "text-emerald-600" : "text-red-600")}>{message.text}</p>
      )}
      {needsPrice && !message && (
        <p className="text-sm text-amber-600">No price yet — set one above before submitting.</p>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-zinc-100 pt-4">
        <Button variant="outline" onClick={handleSave} disabled={saving || pushing}>
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          Save
        </Button>
        {/* Before, not after. Everything else in this product tells the
            seller about a difference once it has already happened — a
            rejection, an adjustment note, a value that turned out not to
            have arrived. This is the one place to look while it can still
            change the outcome. */}
        <Button variant="outline" onClick={handlePreview} disabled={saving || pushing || previewing} className="gap-1.5">
          {previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
          Preview what goes to Vendor Center
        </Button>
        {canPush && (
          <Button onClick={handlePush} disabled={saving || pushing} className="gap-1.5">
            {pushing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Submit to Jumia
          </Button>
        )}
      </div>

      {preview && <JumiaPreviewPanel preview={preview} onClose={() => setPreview(null)} />}

      <CategoryDrawer
        open={showCategoryPicker}
        onClose={() => setShowCategoryPicker(false)}
        onSelect={handleCategoryChange}
        initialPath={categoryPath ?? undefined}
      />
    </div>
  );
}

/**
 * The payload, rendered as fields rather than JSON.
 *
 * Shows what lands in Vendor Center, which is deliberately not the same view as
 * the form above it. The form is where a seller expresses intent; this is
 * where they check it survived — a title with the brand stripped out, a
 * "What's in the box" whose line breaks became <br>, an attribute the
 * category dropped. Rendering raw JSON would technically be the same
 * information and would be read by nobody.
 */
function JumiaPreviewPanel({ preview, onClose }: { preview: JumiaPreview; onClose: () => void }) {
  const first = preview.products[0];
  // Both kinds of "this won't go through" in one list. A seller doesn't
  // care that one comes from our own validation and the other from the
  // category schema — they care what to fix.
  const problems = [
    ...preview.blockers,
    ...preview.missing_required.map((label) => `${label} is required by this category`),
  ];

  return (
    <div className="mt-4 rounded-2xl border border-zinc-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3">
        <h3 className="text-sm font-semibold text-zinc-900">What you will see on Vendor Center</h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close preview"
          className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-50 hover:text-zinc-700"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-4 px-5 py-4">
        {problems.length > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
            <p className="text-xs font-semibold text-amber-800">This would not be accepted yet</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-amber-700">
              {problems.map((p, i) => <li key={i}>{p}</li>)}
            </ul>
          </div>
        )}

        {preview.adjustments.length > 0 && (
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2">
            <p className="text-xs font-semibold text-zinc-700">Changed on the way out</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-zinc-600">
              {preview.adjustments.map((a, i) => <li key={i}>{a}</li>)}
            </ul>
          </div>
        )}

        {!first ? (
          <p className="text-sm text-zinc-400">Nothing to send yet.</p>
        ) : (
          <>
            <PreviewRow label="Title"    value={first.name?.value} />
            <PreviewRow label="Brand"    value={first.brand?.name} />
            <PreviewRow label="Category" value={first.category?.name} />
            <PreviewRow
              label="Price"
              value={first.price?.value != null ? `${first.price.value} ${first.price.currency ?? ""}`.trim() : undefined}
            />
            <PreviewRow label="Stock" value={first.stock != null ? String(first.stock) : undefined} />
            <PreviewRow label="Images" value={`${first.images?.length ?? 0} photo${(first.images?.length ?? 0) === 1 ? "" : "s"}`} />

            {preview.products.length > 1 && (
              <PreviewRow
                label="Variants"
                value={preview.products.map((p) => p.variation).filter(Boolean).join(", ")}
              />
            )}

            <div>
              <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">Description</p>
              {/* The description is HTML by the time it reaches here, and
                  seeing it RENDERED is the point — a seller checking
                  whether their line breaks survived learns nothing from
                  reading the tags. */}
              <div
                className="prose prose-sm mt-1 max-w-none rounded-lg border border-zinc-100 bg-zinc-50 p-3 text-sm text-zinc-700"
                dangerouslySetInnerHTML={{ __html: first.description?.value ?? "" }}
              />
            </div>

            {(first.attributes?.length ?? 0) > 0 && (
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">
                  Attributes ({first.attributes!.length})
                </p>
                <dl className="mt-1 divide-y divide-zinc-100 rounded-lg border border-zinc-100">
                  {first.attributes!.map((a) => (
                    <div key={a.name} className="flex gap-3 px-3 py-1.5 text-sm">
                      <dt className="w-1/3 shrink-0 truncate text-zinc-500">{a.name}</dt>
                      <dd
                        className="min-w-0 flex-1 text-zinc-800"
                        dangerouslySetInnerHTML={{ __html: a.value }}
                      />
                    </div>
                  ))}
                </dl>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function PreviewRow({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex gap-3 text-sm">
      <span className="w-1/3 shrink-0 text-[11px] font-medium uppercase tracking-wide text-zinc-400">{label}</span>
      <span className={cn("min-w-0 flex-1", value ? "text-zinc-800" : "text-zinc-300")}>
        {value || "— empty"}
      </span>
    </div>
  );
}
