"use client";

/**
 * SchemaForm — renders the entire field set for a Jumia category exactly
 * as Jumia Vendor Center would, in a single 3-column grid.
 *
 * Driven entirely by GET /api/jumia/categories/{code}/attributes. The
 * caller provides the listing snapshot and a write handler; we figure
 * out the correct backing store (column vs dynamic_attributes) per
 * field via lib/jumia/attribute-mapping.
 */

import { useEffect, useState, useCallback } from "react";
import { Loader2, Tag, AlertCircle, Sparkles } from "lucide-react";
import { SchemaField, type JumiaAttributeDef } from "./SchemaField";
import { canonicalKey, columnFor, readAttributeValue } from "@/lib/jumia/attribute-mapping";
import type { ListingRow } from "@/lib/supabase/types";

interface SchemaFormProps {
  /** Numeric leaf category code, e.g. 10000799 */
  categoryCode:    string | null;
  /** Current listing snapshot — provides current values for both columns and dynamic_attributes */
  listing:         ListingRow;
  /** Override values from local form state (overlays listing for unsaved edits) */
  overrideValues?: Record<string, string>;
  /** Called when any field is edited. Caller decides storage based on attribute-mapping. */
  onFieldChange:   (attributeName: string, value: string) => void;
  /** Field source map — used to render the AI confidence badge next to each label */
  fieldSources?:   Record<string, "ai" | "user">;
  /** Field confidence map — used to colour the AI badge */
  fieldConfidence?: Record<string, {
    confidence: number;
    source:     "image" | "ocr" | "inferred" | "seller-required";
    reasoning?: string;
  }>;
  /** Tiny pill renderer for confidence — caller injects to avoid coupling */
  renderConfidenceDot?: (info: { source?: string; confidence?: number }) => React.ReactNode;
  /**
   * Whitelist: only render attributes whose name is in this list (case-insensitive).
   * Used to split the schema into Product Information vs Product Specification
   * sections without duplicating fields.
   */
  includeNames?:   string[];
  /** Blacklist: never render attributes whose name is in this list */
  excludeNames?:   string[];
  /** Hide the "Required (N) / Optional (N)" group headings */
  hideGroupHeadings?: boolean;
  /**
   * Universal fields injected into the schema if Jumia didn't include them
   * for this category. Brand / description / highlights / warranty fields
   * etc. live here so the form is consistent across all categories — Jumia
   * doesn't always return these in their per-category schema, but our UI
   * needs them regardless. Live Jumia attributes win on name collision.
   */
  extraFields?:    JumiaAttributeDef[];
  /**
   * Skip attributes flagged `is_variant: true`. Set true when this form
   * renders alongside a dedicated Variants section that already consumes
   * those axes — prevents the variation field from rendering twice.
   */
  excludeVariants?: boolean;
  /**
   * Grid density at the large breakpoint. 3-col is the default and works
   * well for the wide Product Specification (lots of small fields). 4-col
   * is right for the more compact Product Information row (Brand / Color /
   * Color family / Weight on one line). 2-col suits a narrower single-column
   * page layout (e.g. the WhatsApp focused editor). Sub-lg breakpoints
   * always render 1- or 2-col regardless of this prop.
   */
  cols?: 2 | 3 | 4;
  /**
   * When set, a "Fill empty fields with AI" button renders at the top of
   * the form. Click → caller runs Gemini fill against the current category
   * schema. Only one of the SchemaForm instances on a page should receive
   * this prop (typically the Product Specification one) so we don't show
   * two buttons.
   */
  onFillWithAI?: () => void | Promise<void>;
  /** Disable/loading state for the Fill-with-AI button. */
  fillWithAILoading?: boolean;
  /**
   * Collapse fields the AI filled with high confidence into a single
   * "N fields look good" summary, showing only fields that genuinely need a
   * look (required + empty, AI confidence < 0.75, or explicitly
   * seller-required) expanded by default. Meant for a category schema that
   * can run to dozens of fields — off by default so a small, fixed field
   * set (e.g. Product Information) isn't affected.
   */
  collapseHighConfidence?: boolean;
}

export function SchemaForm({
  categoryCode,
  listing,
  overrideValues,
  onFieldChange,
  fieldSources,
  fieldConfidence,
  renderConfidenceDot,
  includeNames,
  excludeNames,
  hideGroupHeadings,
  extraFields,
  excludeVariants,
  cols = 3,
  onFillWithAI,
  fillWithAILoading = false,
  collapseHighConfidence = false,
}: SchemaFormProps) {
  const [schema,    setSchema]    = useState<JumiaAttributeDef[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showLooksGood, setShowLooksGood] = useState(false);

  // Single fetch — the server transparently syncs from Jumia on cache miss,
  // so by the time this promise resolves we have a fully-populated schema
  // (or a clear error if the seller needs to reconnect).
  const loadSchema = useCallback(async () => {
    if (!categoryCode || isNaN(Number(categoryCode)) || Number(categoryCode) === 0) {
      setSchema([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const r = await fetch(`/api/jumia/categories/${categoryCode}/attributes`);
      const d = await r.json();
      if (!r.ok) {
        // 401 from this endpoint means the Jumia OAuth app is dead — the
        // global ReconnectBanner handles the redirect; we just stop loading.
        if (r.status === 401) {
          setLoadError("RECONNECT");
        } else {
          setLoadError(d.error ?? `Failed to load schema (${r.status})`);
        }
        setSchema([]);
      } else {
        setSchema(d.attributes ?? []);
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Network error");
      setSchema([]);
    } finally {
      setLoading(false);
    }
  }, [categoryCode]);

  useEffect(() => { loadSchema(); }, [loadSchema]);

  if (!categoryCode) {
    return (
      <div className="rounded-md border border-dashed border-zinc-300 bg-zinc-50/50 p-6 text-center text-sm text-zinc-500">
        <Tag className="h-6 w-6 mx-auto mb-2 text-zinc-400" />
        Pick a category above to see the listing fields Jumia requires.
      </div>
    );
  }

  // Cold start: no schema yet AND still loading → centred spinner.
  // (Category-change reloads keep the previous schema visible with a pill
  // on top — see below — so the page doesn't flash blank.)
  if (loading && schema.length === 0) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-sm text-zinc-400">
        <Loader2 className="h-4 w-4 animate-spin" />
        Pulling live fields from Jumia…
      </div>
    );
  }

  // Error path: schema fetch failed (network blip, reconnect needed, etc.).
  // Reconnect errors are handled globally by the ReconnectBanner — here we
  // just show a minimal inline notice so the page isn't blocked.
  if (loadError && schema.length === 0) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 flex items-start gap-2">
        <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-amber-500" />
        <div className="space-y-1">
          <p className="font-medium">
            {loadError === "RECONNECT"
              ? "Reconnect your Jumia account to load category fields."
              : "Couldn't load category fields from Jumia."}
          </p>
          {loadError !== "RECONNECT" && (
            <button
              type="button"
              onClick={loadSchema}
              className="text-xs underline hover:text-amber-700"
            >
              Try again
            </button>
          )}
        </div>
      </div>
    );
  }

  // Merge Jumia's live schema with caller-supplied extraFields, deduped by
  // canonical key (collapses column aliases like weight/weight_kg AND
  // dynamic-attribute aliases like whats_in_the_box/what_is_in_the_box).
  //
  // Jumia's live attribute wins on collision so its exact validation rules
  // trump our defaults — BUT we enrich the live attr in place if it's
  // missing critical info our extraField has (e.g. Jumia returned the
  // field as TEXT/NUMBER with no allowed_values, but we know it should
  // be a SELECTION with a fixed option list).
  const merged:    JumiaAttributeDef[]                  = [];
  const byKey:     Map<string, JumiaAttributeDef>       = new Map();

  const consume = (attr: JumiaAttributeDef, isExtra: boolean) => {
    const key = canonicalKey(attr.name);
    const existing = byKey.get(key);
    if (!existing) {
      // First time we see this canonical key — accept it. Spread so the
      // map and array share the same object reference; we mutate later
      // during enrichment.
      const copy: JumiaAttributeDef = { ...attr, allowed_values: [...attr.allowed_values] };
      byKey.set(key, copy);
      merged.push(copy);
      return;
    }
    // Duplicate canonical key — try to enrich the existing attr with
    // anything the second one has but the first lacks. Only enrich FROM
    // extras (we never let an extraField overwrite live Jumia data).
    if (!isExtra) return;

    // Fill in missing allowed_values from extras.
    if (existing.allowed_values.length === 0 && attr.allowed_values.length > 0) {
      existing.allowed_values = [...attr.allowed_values];
    }
    // Promote type from string/number to enum/multi when the extras have
    // a more specific type with a populated option list. Prevents
    // "Material family" rendering as a free-text input just because
    // Jumia's per-category schema reported it as TEXT.
    if (
      (existing.type === "string" || existing.type === "number") &&
      (attr.type === "enum" || attr.type === "multi") &&
      attr.allowed_values.length > 0
    ) {
      existing.type           = attr.type;
      existing.allowed_values = [...attr.allowed_values];
    }
  };

  for (const a of schema)            consume(a, false);
  for (const a of extraFields ?? []) consume(a, true);

  // Build the current value for each attribute: prefer override (live form
  // state) then fall back to the persisted listing value.
  const getValue = (attrName: string): string => {
    if (overrideValues && attrName in overrideValues) {
      return overrideValues[attrName];
    }
    return readAttributeValue(listing, attrName);
  };

  if (merged.length === 0) {
    // No attributes for this category and no extras. Some Jumia categories
    // are genuinely empty (no category-specific schema), others got here
    // because a live fetch silently failed. Either way, render a clear
    // empty-state so the section isn't visually blank — the seller knows
    // the category is set and what to do next.
    return (
      <div className="rounded-md border border-dashed border-zinc-300 bg-zinc-50/50 p-6 text-center space-y-3">
        <p className="text-sm text-zinc-600">
          This category has no specific fields from Jumia.
        </p>
        <p className="text-xs text-zinc-400">
          Your universal product info above is enough — submit when ready.
        </p>
        {onFillWithAI && (
          <button
            type="button"
            onClick={() => { void onFillWithAI(); }}
            disabled={fillWithAILoading}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
              fillWithAILoading
                ? "border-zinc-200 bg-zinc-50 text-zinc-400 cursor-not-allowed"
                : "border-orange-200 bg-orange-50 text-orange-700 hover:bg-orange-100",
            )}
          >
            {fillWithAILoading ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                Retrying…
              </>
            ) : (
              <>
                <Sparkles className="h-3 w-3" />
                Try AI fill anyway
              </>
            )}
          </button>
        )}
      </div>
    );
  }

  // Group: required first (so seller knows what blocks publish), then
  // optional. Within each group preserve Jumia's natural ordering.
  // Apply caller-supplied whitelist/blacklist filters (case-insensitive).
  // Used to split the schema into "Product Information" vs "Product
  // Specification" sections without duplicating fields.
  const includeSet = includeNames
    ? new Set(includeNames.map((n) => n.toLowerCase()))
    : null;
  const excludeSet = excludeNames
    ? new Set(excludeNames.map((n) => n.toLowerCase()))
    : null;
  const visible = merged.filter((a) => {
    const n = a.name.toLowerCase();
    if (includeSet && !includeSet.has(n)) return false;
    if (excludeSet && excludeSet.has(n))  return false;
    if (excludeVariants && a.is_variant)  return false;
    return true;
  });

  if (visible.length === 0) {
    // Filters stripped every field in this slice. Show a friendly
    // empty-state for the Product Specification section (which is where
    // onFillWithAI is wired) so the seller doesn't stare at a blank
    // panel. The Product Information slice doesn't pass onFillWithAI,
    // so it still returns null — that's intentional because Product
    // Information always has its universalInfoFields fallback.
    if (!onFillWithAI) return null;
    return (
      <div className="rounded-md border border-dashed border-zinc-300 bg-zinc-50/50 p-6 text-center space-y-3">
        <p className="text-sm text-zinc-600">
          No category-specific fields needed here.
        </p>
        <p className="text-xs text-zinc-400">
          Jumia covers everything for this category in the universal product
          info above. You&apos;re ready to submit.
        </p>
      </div>
    );
  }

  // Required fields lead the order so the seller scans them first, but we
  // render everything in ONE continuous grid (matches Jumia VC's layout).
  // Headings only appear when hideGroupHeadings is false AND there are
  // both required AND optional fields to label.
  const required = visible.filter((a) => a.required);
  const optional = visible.filter((a) => !a.required);
  const ordered: JumiaAttributeDef[] = [...required, ...optional];

  // Has at least one empty field that the AI could fill — drives the
  // disabled state of the "Fill empty fields with AI" button.
  const hasEmptyField = ordered.some((a) => !getValue(a.name)?.trim());

  const gridClass = cn(
    "grid grid-cols-1 gap-4 sm:grid-cols-2",
    cols === 4 ? "lg:grid-cols-4" : cols === 2 ? "lg:grid-cols-2" : "lg:grid-cols-3",
  );
  const wideSpanClass = cols === 4
    ? "sm:col-span-2 lg:col-span-4"
    : cols === 2
    ? "sm:col-span-2 lg:col-span-2"
    : "sm:col-span-2 lg:col-span-3";

  // Shared by classification (below) and rendering — both need the same
  // source/confidence lookup per attribute.
  const fieldInfo = (attr: JumiaAttributeDef) => {
    const key        = `dynamic_attributes.${attr.name}`;
    const colKey     = columnFor(attr.name);
    const sourceKey  = colKey ?? key;
    const source     = fieldConfidence?.[sourceKey]?.source     ?? fieldConfidence?.[attr.name]?.source;
    const confidence = fieldConfidence?.[sourceKey]?.confidence ?? fieldConfidence?.[attr.name]?.confidence;
    return { sourceKey, source, confidence };
  };

  const renderField = (attr: JumiaAttributeDef) => {
    const { sourceKey, source, confidence } = fieldInfo(attr);
    const isText     = attr.type === "string" || attr.type === "textarea" || attr.type === "number";
    const wideSpan   = attr.type === "textarea";
    return (
      <div key={attr.name} className={wideSpan ? wideSpanClass : ""}>
        <SchemaField
          attr={attr}
          value={getValue(attr.name)}
          onChange={(v) => onFieldChange(attr.name, v)}
          source={fieldSources?.[sourceKey] === "user" ? "user" : source as ("image" | "ocr" | "inferred" | "seller-required" | undefined)}
          confidenceDot={
            renderConfidenceDot && isText
              ? renderConfidenceDot({ source, confidence })
              : null
          }
        />
      </div>
    );
  };

  // Confidence-first grouping (Product Specification only — see
  // collapseHighConfidence's doc comment). A field "needs attention" when
  // it's required-and-empty (never hidden — blocks publish), explicitly
  // seller-required, or has a value the AI wasn't confident about. 0.75
  // matches the threshold review-client.tsx's AIConfidenceBanner already
  // uses for its own category-confidence check, so "confident" means one
  // consistent thing on the page rather than a second invented number.
  // Everything else — a confident AI value, a seller-typed value with no
  // confidence entry, or an empty optional field — collapses by default.
  const needsAttention: JumiaAttributeDef[] = [];
  const looksGood:      JumiaAttributeDef[] = [];
  if (collapseHighConfidence) {
    for (const attr of ordered) {
      const { source, confidence } = fieldInfo(attr);
      const value = getValue(attr.name)?.trim();
      const flagged =
        (attr.required && !value) ||
        source === "seller-required" ||
        (Boolean(value) && typeof confidence === "number" && confidence < 0.75);
      (flagged ? needsAttention : looksGood).push(attr);
    }
  }

  return (
    <div className="space-y-3 relative">
      {/* Pill banner during a category-switch reload — old fields stay
          visible (slightly dimmed) so the form doesn't flash blank. */}
      {loading && schema.length > 0 && (
        <div className="absolute -top-2 right-0 z-10 inline-flex items-center gap-1.5 rounded-full bg-orange-50 border border-orange-200 px-3 py-1 text-[11px] font-medium text-orange-700 shadow-sm">
          <Loader2 className="h-3 w-3 animate-spin" />
          Updating fields from Jumia…
        </div>
      )}
      {/* Header row: required/optional summary + "Fill with AI" button. */}
      {(onFillWithAI || (!hideGroupHeadings && required.length > 0 && optional.length > 0)) && (
        <div className="flex items-center justify-between gap-3">
          {!hideGroupHeadings && required.length > 0 && optional.length > 0 ? (
            <p className="text-[11px] font-semibold uppercase tracking-widest text-red-500">
              Required ({required.length}) <span className="text-zinc-300">·</span>{" "}
              <span className="text-zinc-400">Optional ({optional.length})</span>
            </p>
          ) : (
            <span />
          )}
          {onFillWithAI && (
            <button
              type="button"
              onClick={() => { void onFillWithAI(); }}
              disabled={fillWithAILoading || !hasEmptyField}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors",
                fillWithAILoading || !hasEmptyField
                  ? "border-zinc-200 bg-zinc-50 text-zinc-400 cursor-not-allowed"
                  : "border-orange-200 bg-orange-50 text-orange-700 hover:bg-orange-100",
              )}
              title={
                !hasEmptyField
                  ? "All fields are filled. Clear a field to re-run the AI."
                  : "Use Gemini to fill the empty category fields from your images."
              }
            >
              {fillWithAILoading ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Filling…
                </>
              ) : (
                <>
                  <Sparkles className="h-3 w-3" />
                  Fill empty fields with AI
                </>
              )}
            </button>
          )}
        </div>
      )}
      <div className={cn(gridClass, loading && schema.length > 0 && "opacity-60 pointer-events-none transition-opacity")}>
        {(collapseHighConfidence ? needsAttention : ordered).map(renderField)}
      </div>
      {collapseHighConfidence && looksGood.length > 0 && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50/50">
          <button
            type="button"
            onClick={() => setShowLooksGood((v) => !v)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-emerald-700 hover:bg-emerald-50"
          >
            <span className="text-emerald-500">✓</span>
            {looksGood.length} field{looksGood.length === 1 ? "" : "s"} look{looksGood.length === 1 ? "s" : ""} good
            <span className="ml-auto text-emerald-500">{showLooksGood ? "Hide" : "Review"}</span>
          </button>
          {showLooksGood && (
            <div className={cn(gridClass, "p-3 pt-0")}>
              {looksGood.map(renderField)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Tiny local cn that doesn't depend on the global utility (keeps this
// component portable). The global one is used elsewhere.
function cn(...parts: (string | false | undefined | null)[]): string {
  return parts.filter(Boolean).join(" ");
}
