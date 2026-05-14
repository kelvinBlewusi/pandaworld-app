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
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MultiSelectDropdown } from "@/components/ui/multi-select";
import { cn } from "@/lib/utils";

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

export function SchemaField({ attr, value, onChange, confidenceDot, source }: SchemaFieldProps) {
  const hasMin = typeof attr.min_length === "number" && attr.min_length! > 0;
  const hasMax = typeof attr.max_length === "number" && attr.max_length! > 0;
  const len = value.length;
  const tooShort = hasMin && len > 0 && len < (attr.min_length ?? 0);
  const tooLong  = hasMax && len > (attr.max_length ?? Infinity);
  const isText   = attr.type === "string" || attr.type === "textarea" || attr.type === "number";

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

      {renderInput(attr, value, onChange)}

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

  // TEXT_AREA
  if (attr.type === "textarea") {
    return (
      <Textarea
        value={value}
        rows={4}
        placeholder={`Ex: [${attr.label}]`}
        onChange={(e) => onChange(e.target.value)}
        className="text-sm"
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
