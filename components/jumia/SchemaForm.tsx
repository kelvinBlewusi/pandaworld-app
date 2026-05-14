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
import { Loader2, Tag, AlertCircle } from "lucide-react";
import { SchemaField, type JumiaAttributeDef } from "./SchemaField";
import { columnFor, readAttributeValue } from "@/lib/jumia/attribute-mapping";
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
   * Color family / Weight on one line). Sub-lg breakpoints always render
   * 1- or 2-col regardless of this prop.
   */
  cols?: 3 | 4;
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
}: SchemaFormProps) {
  const [schema,    setSchema]    = useState<JumiaAttributeDef[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

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

  if (loading) {
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
  if (loadError) {
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
  // BOTH attribute name AND backing column. Jumia sometimes returns
  // aliases for the same logical field (e.g. "weight" + "weight_kg",
  // "highlights" + "short_description") which all map to the same column
  // — rendering both creates ghost duplicates. We keep the first one we
  // see and drop subsequent aliases.
  //
  // Live attributes win on collision so Jumia's exact validation rules /
  // allowed_values trump our defaults whenever Jumia returns the field.
  const seenColumns = new Set<string>();
  const seenNames   = new Set<string>();
  const merged:     JumiaAttributeDef[] = [];

  const tryAccept = (attr: JumiaAttributeDef) => {
    const n = attr.name.toLowerCase();
    if (seenNames.has(n)) return;
    const col = columnFor(attr.name);
    if (col && seenColumns.has(col)) return;
    seenNames.add(n);
    if (col) seenColumns.add(col);
    merged.push(attr);
  };

  for (const a of schema)               tryAccept(a);
  for (const a of extraFields ?? [])    tryAccept(a);

  if (merged.length === 0) {
    // No attributes for this category and no extras — correct for some
    // catch-all Jumia categories. Render nothing rather than a confusing
    // empty-state.
    return null;
  }

  // Build the current value for each attribute: prefer override (live form
  // state) then fall back to the persisted listing value.
  const getValue = (attrName: string): string => {
    if (overrideValues && attrName in overrideValues) {
      return overrideValues[attrName];
    }
    return readAttributeValue(listing, attrName);
  };

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
    return null;   // nothing to render in this slice — caller can skip the section header
  }

  // Required fields lead the order so the seller scans them first, but we
  // render everything in ONE continuous grid (matches Jumia VC's layout).
  // Headings only appear when hideGroupHeadings is false AND there are
  // both required AND optional fields to label.
  const required = visible.filter((a) => a.required);
  const optional = visible.filter((a) => !a.required);
  const ordered: JumiaAttributeDef[] = [...required, ...optional];

  const gridClass = cn(
    "grid grid-cols-1 gap-4 sm:grid-cols-2",
    cols === 4 ? "lg:grid-cols-4" : "lg:grid-cols-3",
  );
  const wideSpanClass = cols === 4
    ? "sm:col-span-2 lg:col-span-4"
    : "sm:col-span-2 lg:col-span-3";

  const renderField = (attr: JumiaAttributeDef) => {
    const key        = `dynamic_attributes.${attr.name}`;
    const colKey     = columnFor(attr.name);
    const sourceKey  = colKey ?? key;
    const source     = fieldConfidence?.[sourceKey]?.source     ?? fieldConfidence?.[attr.name]?.source;
    const confidence = fieldConfidence?.[sourceKey]?.confidence ?? fieldConfidence?.[attr.name]?.confidence;
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

  return (
    <div className="space-y-3">
      {!hideGroupHeadings && required.length > 0 && optional.length > 0 && (
        <p className="text-[11px] font-semibold uppercase tracking-widest text-red-500">
          Required ({required.length}) <span className="text-zinc-300">·</span>{" "}
          <span className="text-zinc-400">Optional ({optional.length})</span>
        </p>
      )}
      <div className={gridClass}>
        {ordered.map(renderField)}
      </div>
    </div>
  );
}

// Tiny local cn that doesn't depend on the global utility (keeps this
// component portable). The global one is used elsewhere.
function cn(...parts: (string | false | undefined | null)[]): string {
  return parts.filter(Boolean).join(" ");
}
