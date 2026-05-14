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
import { Loader2, RefreshCw, Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
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
}

export function SchemaForm({
  categoryCode,
  listing,
  overrideValues,
  onFieldChange,
  fieldSources,
  fieldConfidence,
  renderConfidenceDot,
}: SchemaFormProps) {
  const [schema,    setSchema]    = useState<JumiaAttributeDef[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [syncing,   setSyncing]   = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  const loadSchema = useCallback(async () => {
    if (!categoryCode || isNaN(Number(categoryCode)) || Number(categoryCode) === 0) {
      setSchema([]);
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

  useEffect(() => { loadSchema(); }, [loadSchema]);

  const handleSyncNow = async () => {
    setSyncing(true);
    setSyncError(null);
    try {
      const r = await fetch("/api/jumia/sync-categories", { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Sync failed");
      await new Promise((res) => setTimeout(res, 600));
      await loadSchema();
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  };

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
        Loading category fields from Jumia…
      </div>
    );
  }

  if (schema.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-zinc-300 bg-zinc-50/50 p-6 text-center space-y-3">
        <p className="text-sm text-zinc-600">No fields cached for this category.</p>
        <p className="text-[11px] text-zinc-400">
          Click below to pull Jumia&apos;s schema for this category — usually takes 1–2 seconds.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleSyncNow}
          disabled={syncing}
          className="gap-1.5"
        >
          {syncing
            ? <><Loader2 className="h-3 w-3 animate-spin" /> Fetching…</>
            : <><RefreshCw className="h-3 w-3" /> Fetch fields from Jumia</>}
        </Button>
        {syncError && <p className="text-xs text-red-500">{syncError}</p>}
      </div>
    );
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
  const required = schema.filter((a) => a.required);
  const optional = schema.filter((a) => !a.required);

  const renderGroup = (attrs: JumiaAttributeDef[], heading: string, headingColor: string) => {
    if (attrs.length === 0) return null;
    return (
      <div className="space-y-3">
        <p className={cn("text-[11px] font-semibold uppercase tracking-widest", headingColor)}>
          {heading}
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {attrs.map((attr) => {
            const key       = `dynamic_attributes.${attr.name}`;
            const colKey    = columnFor(attr.name);
            const sourceKey = colKey ?? key;
            const source    = fieldConfidence?.[sourceKey]?.source ?? fieldConfidence?.[attr.name]?.source;
            const confidence = fieldConfidence?.[sourceKey]?.confidence ?? fieldConfidence?.[attr.name]?.confidence;
            const isText    = attr.type === "string" || attr.type === "textarea" || attr.type === "number";
            const wideSpan  = attr.type === "textarea";
            return (
              <div key={attr.name} className={wideSpan ? "sm:col-span-2 lg:col-span-3" : ""}>
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
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {renderGroup(required, `Required (${required.length})`,        "text-red-500")}
      {renderGroup(optional, `Optional (${optional.length})`,        "text-zinc-400")}
    </div>
  );
}

// Tiny local cn that doesn't depend on the global utility (keeps this
// component portable). The global one is used elsewhere.
function cn(...parts: (string | false | undefined | null)[]): string {
  return parts.filter(Boolean).join(" ");
}
