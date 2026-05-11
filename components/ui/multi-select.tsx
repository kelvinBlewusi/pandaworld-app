"use client";

/**
 * MultiSelectDropdown — Jumia-style multi-pick field.
 *
 * Renders a button styled like a Select trigger; clicking it opens a popover
 * with checkbox rows. Selected values are shown comma-separated in the
 * button label. Used wherever a Jumia category attribute is of type
 * MULTI_SELECTION (e.g. Color family, Certifications).
 *
 * Stores the value as a comma-separated string so it's compatible with our
 * existing TEXT columns; callers can `.split(",").map(s => s.trim())` to get
 * an array when pushing to Jumia.
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface MultiSelectDropdownProps {
  options:     string[];
  value:       string;                 // comma-separated
  onChange:    (csv: string) => void;
  placeholder?: string;
  disabled?:   boolean;
  className?:  string;
}

export function MultiSelectDropdown({
  options,
  value,
  onChange,
  placeholder = "Select…",
  disabled,
  className,
}: MultiSelectDropdownProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Parse the comma-separated value into a Set for O(1) lookups
  const selected = new Set(
    value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const toggle = (option: string) => {
    if (selected.has(option)) selected.delete(option);
    else                       selected.add(option);
    onChange(Array.from(selected).join(", "));
  };

  const displayLabel = Array.from(selected).join(", ");

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex h-10 w-full items-center justify-between rounded-md border bg-white px-3 text-sm text-left transition-colors",
          displayLabel
            ? "border-zinc-200 text-zinc-800"
            : "border-zinc-200 text-zinc-400 hover:border-zinc-300",
          disabled && "opacity-50 cursor-not-allowed"
        )}
      >
        <span className="truncate">{displayLabel || placeholder}</span>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-zinc-400 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div
          className="absolute z-30 mt-1 w-full max-h-72 overflow-y-auto rounded-md border bg-white shadow-lg"
        >
          {options.length === 0 ? (
            <p className="px-3 py-4 text-xs text-zinc-400 text-center">No options available</p>
          ) : (
            options.map((opt) => {
              const isSelected = selected.has(opt);
              return (
                <button
                  key={opt}
                  type="button"
                  onClick={() => toggle(opt)}
                  className={cn(
                    "flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors",
                    isSelected ? "bg-orange-50 text-zinc-900" : "text-zinc-700 hover:bg-zinc-50"
                  )}
                >
                  <span
                    className={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
                      isSelected
                        ? "border-orange-500 bg-orange-500"
                        : "border-zinc-300 bg-white"
                    )}
                  >
                    {isSelected && <Check className="h-3 w-3 text-white" />}
                  </span>
                  {opt}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
