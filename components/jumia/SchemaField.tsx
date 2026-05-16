"use client";

/**
 * SchemaField — renders a single Jumia category attribute exactly as the
 * Jumia Vendor Center would render it, driven by the attribute's `type`
 * returned by Jumia's PIM API.
 *
 * Supported types (per official Postman docs):
 *   - BOOLEAN         → Yes/No select
 *   - NUMBER          → numeric input
 *   - DATE            → date picker
 *   - DATE_TIME       → datetime-local picker
 *   - SELECTION       → single-select dropdown
 *   - MULTI_SELECTION → checkbox-popover (comma-separated value)
 *   - TEXT_AREA       → rich-text-style textarea
 *   - TEXT (default)  → text input
 *
 * Storage is decided by attribute-mapping.ts. The caller doesn't need to
 * know — it just provides current value and onChange.
 */

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MultiSelectDropdown } from "@/components/ui/multi-select";
import { RichTextField } from "./RichTextField";
import { BrandCombobox } from "./BrandCombobox";
import { cn } from "@/lib/utils";

// Attribute names that should render as a Jumia-brand-catalogue lookup
// instead of a free-text input or generic select. Jumia rejects listings
// whose brand isn't an exact match against their catalogue.
const BRAND_FIELD_NAMES = new Set<string>(["brand", "manufacturer", "make"]);

export type JumiaAttrType =
  | "boolean"
  | "number"
  | "date"
  | "datetime"
  | "enum"
  | "multi"
  | "textarea"
  | "string";

export interface JumiaAttributeDef {
  name:           string;
  label:          string;
  type:           JumiaAttrType;
  allowed_values: string[];
  required:       boolean;
  is_variant:     boolean;
  min_length?:    number | null;
  max_length?:    number | null;
}

interface SchemaFieldProps {
  attr:           JumiaAttributeDef;
  value:          string;
  onChange:       (value: string) => void;
  /** Optional AI confidence indicator next to the label */
  confidenceDot?: React.ReactNode;
  /** Indicates this field came from AI vs user vs is seller-required */
  source?:        "image" | "ocr" | "inferred" | "seller-required" | "user";
}

// Attribute names that should always render as a multi-line textarea even
// if Jumia returns type=TEXT or type=NUMBER for them. Matches Jumia VC
// behaviour where these fields appear with a rich-text editor.
//
// IMPORTANT: "manufacturer" intentionally LEFT OUT — Jumia uses that name
// for the BRAND value (autocomplete from brand catalogue), not for the
// descriptive "From the Manufacturer" textarea. The descriptive field is
// "from_the_manufacturer" (and its aliases in attribute-mapping).
const LONG_TEXT_FIELD_NAMES = new Set<string>([
  // ── Long product copy ────────────────────────────────────────────────
  "description", "product_description",
  "highlights", "short_description",
  // ── From the manufacturer (descriptive text) ─────────────────────────
  "from_the_manufacturer", "from_manufacturer",
  "manufacturer_description", "manufacturer_text",
  "manufacturer_info", "manufacturer_notes",
  // ── What's in the box ────────────────────────────────────────────────
  "whats_in_the_box", "what_is_in_the_box", "what_in_box",
  "whats_in_box", "box_contents", "in_the_box",
  "package_contents", "contents_of_the_box",
  // ── Warranty copy ────────────────────────────────────────────────────
  "product_warranty", "warranty_text", "warranty",
  "warranty_address", "warranty_info",
  // ── Notes ────────────────────────────────────────────────────────────
  "note", "notes",
  "additional_info", "additional_information",
]);

// Label patterns that ALWAYS render as textarea regardless of Jumia's
// reported type. Jumia uses varied internal attribute names per category
// (e.g. one category may call the field "whats_in_box", another
// "package_contents") but the human-readable label stays consistent.
// Matching on label catches cases the name-set misses.
//
// Pattern matches are case-insensitive and partial — "Product description"
// in a label hits /description/i. Keep the list tight: only labels we
// know with high confidence are descriptive free-text fields.
const LONG_TEXT_LABEL_PATTERNS: RegExp[] = [
  /what.?s in (the )?box/i,         // "What's in the box", "Whats in box", etc.
  /(box|package) contents?/i,        // "Box contents", "Package content"
  /from the manufacturer/i,
  /manufacturer (description|text|info|notes?)/i,
  /product description/i,
  /short description/i,
  /(product )?highlights?/i,
  /additional information?/i,
  /(product )?warranty (text|address|info|description|terms?)/i,
];

function effectiveType(attr: JumiaAttributeDef): JumiaAttrType {
  // Force-promote known long-text fields to TEXTAREA regardless of what
  // Jumia's schema reports. Some categories return TEXT (single line) or
  // even NUMBER for these fields, which would silently break input — the
  // seller typed text into an `<input type="number">` and the browser
  // rejected anything non-numeric, or the AI-filled value didn't display
  // at all because it wasn't a parseable number.
  //
  // Two-layer match: first try the internal attribute name (snake_case),
  // then fall through to the human-readable label (since Jumia's names
  // vary per category but the labels are consistent).
  if (LONG_TEXT_FIELD_NAMES.has(attr.name.toLowerCase())) {
    return "textarea";
  }
  for (const pattern of LONG_TEXT_LABEL_PATTERNS) {
    if (pattern.test(attr.label)) return "textarea";
  }
  return attr.type;
}

export function SchemaField({ attr, value, onChange, confidenceDot, source }: SchemaFieldProps) {
  const renderType = effectiveType(attr);
  const hasMin = typeof attr.min_length === "number" && attr.min_length! > 0;
  const hasMax = typeof attr.max_length === "number" && attr.max_length! > 0;
  const len = value.length;
  const tooShort = hasMin && len > 0 && len < (attr.min_length ?? 0);
  const tooLong  = hasMax && len > (attr.max_length ?? Infinity);
  const isText   = renderType === "string" || renderType === "textarea" || renderType === "number";

  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-semibold text-zinc-700 flex items-center gap-1.5">
        <span className="truncate">{attr.label}</span>
        {attr.required && <span className="text-orange-500">*</span>}
        {attr.is_variant && (
          <span className="text-[9px] rounded-full bg-violet-100 text-violet-600 px-1.5 py-0.5 font-semibold">variant</span>
        )}
        {confidenceDot}
      </Label>

      {renderInput({ ...attr, type: renderType }, value, onChange)}

      {isText && (hasMin || hasMax) && (
        <p className={cn(
          "text-[11px]",
          tooShort || tooLong ? "text-red-500" :
          len > 0             ? "text-emerald-600" :
                                "text-zinc-400"
        )}>
          {len}{hasMax ? `/${attr.max_length}` : ""} characters
          {hasMin && len < (attr.min_length ?? 0) && ` · min ${attr.min_length}`}
        </p>
      )}

      {/* Subtle helper text per field metadata */}
      {attr.required && !(hasMin || hasMax) && source !== "seller-required" && (
        <p className="text-[11px] text-orange-600">Required by Jumia for this category</p>
      )}
      {source === "seller-required" && (
        <p className="text-[11px] text-zinc-500">You fill this — AI does not infer it.</p>
      )}
    </div>
  );
}

// ─── Type-specific renderers ────────────────────────────────────────────────

function renderInput(attr: JumiaAttributeDef, value: string, onChange: (v: string) => void) {
  // BRAND — render as type-ahead against Jumia's brand catalogue regardless
  // of what type Jumia reports. Free-text input here causes downstream
  // rejection when Jumia's validator doesn't recognise the typed value.
  if (BRAND_FIELD_NAMES.has(attr.name.toLowerCase())) {
    return (
      <BrandCombobox
        value={value}
        onChange={onChange}
        placeholder={`Ex: ${attr.label}`}
      />
    );
  }

  // BOOLEAN
  if (attr.type === "boolean") {
    return (
      <Select value={value} onValueChange={onChange}>
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
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-10 text-sm">
          <SelectValue placeholder={`Ex: ${attr.allowed_values[0]} [${attr.label}]`} />
        </SelectTrigger>
        <SelectContent>
          {attr.allowed_values.map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
        </SelectContent>
      </Select>
    );
  }

  // MULTI_SELECTION — checkbox popover
  if (attr.type === "multi" && attr.allowed_values.length > 0) {
    return (
      <MultiSelectDropdown
        options={attr.allowed_values}
        value={value}
        onChange={onChange}
        placeholder={`Pick one or more · ${attr.label}`}
      />
    );
  }

  // DATE
  if (attr.type === "date") {
    return (
      <Input type="date" value={value} onChange={(e) => onChange(e.target.value)} className="h-10 text-sm" />
    );
  }

  // DATE_TIME
  if (attr.type === "datetime") {
    return (
      <Input type="datetime-local" value={value} onChange={(e) => onChange(e.target.value)} className="h-10 text-sm" />
    );
  }

  // TEXT_AREA — render with the rich-text toolbar wrapper to match Jumia
  // Vendor Center. Toolbar buttons are visual-only (no rich formatting
  // executed) since Jumia strips formatting on save anyway.
  if (attr.type === "textarea") {
    return (
      <RichTextField
        value={value}
        onChange={onChange}
        placeholder={`Ex: [${attr.label}]`}
        rows={4}
      />
    );
  }

  // NUMBER
  if (attr.type === "number") {
    return (
      <Input
        type="number"
        value={value}
        placeholder={`Ex: 0 [${attr.label}]`}
        onChange={(e) => onChange(e.target.value)}
        className="h-10 text-sm"
      />
    );
  }

  // TEXT (default)
  return (
    <Input
      value={value}
      placeholder={`Ex: [${attr.label}]`}
      onChange={(e) => onChange(e.target.value)}
      className="h-10 text-sm"
    />
  );
}
