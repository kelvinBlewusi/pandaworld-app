"use client";

/**
 * CategoryRow — a single row in the Jumia-style category drawer.
 *
 * Behaviour matches Vendor Center: clicking the row body drills in (when
 * the node has children); clicking the radio button SELECTS (only if the
 * category is listable per Jumia's attributeSet signal). Clicking the
 * radio on a non-listable category renders an inline tooltip — auto-
 * dismisses on next interaction or after 3s — and leaves the radio
 * unchecked. The chevron echoes the row-body drill-in behaviour.
 *
 * Listability is decided by the caller via `isListable`. We don't infer
 * it here so the same component works for tree nodes AND flat search
 * results.
 */

import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface CategoryRowProps {
  /** Display label — segment name in the tree view, leaf name in search. */
  label:       string;
  /** Optional smaller line below the label — used in search to show full path. */
  subLabel?:   string;
  /** Does this node have children to drill into? Shows the chevron + enables drill. */
  hasChildren: boolean;
  /**
   * Listable per Jumia's attributeSet signal (i.e. attribute_set_sid is
   * non-null). Listable categories — leaves OR intermediate parents —
   * can be selected directly via the radio. Non-listable tree nodes can
   * only be drilled into; clicking their radio shows the blocked-tooltip.
   */
  isListable:  boolean;
  /** Whether this row is the currently-selected one (radio filled). */
  isSelected:  boolean;
  /** Called when the seller drills into this row (body or chevron click). */
  onDrillIn:   () => void;
  /** Called when the seller selects this row via the radio (only fires if listable). */
  onSelect:    () => void;
}

export function CategoryRow({
  label,
  subLabel,
  hasChildren,
  isListable,
  isSelected,
  onDrillIn,
  onSelect,
}: CategoryRowProps) {
  const [blocked, setBlocked] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-dismiss the blocked-tooltip after 3s, and clear it on any
  // interaction elsewhere (handled by the drawer-level click listener).
  useEffect(() => {
    if (!blocked) return;
    timerRef.current = setTimeout(() => setBlocked(false), 3000);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [blocked]);

  const handleRadioClick = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (isListable) {
      setBlocked(false);
      onSelect();
    } else {
      setBlocked(true);
    }
  };

  const handleBodyClick = () => {
    setBlocked(false);
    if (hasChildren) {
      onDrillIn();
    } else if (isListable) {
      // No children + listable + body clicked → selecting is the only
      // sensible action. Matches VC where a leaf row's whole body is
      // a select target.
      onSelect();
    }
  };

  return (
    <li className="relative">
      <div
        className={cn(
          "flex w-full items-center gap-3 px-5 py-3 transition-colors",
          isListable || hasChildren ? "hover:bg-orange-50" : "opacity-60",
        )}
      >
        {/* Radio button — own click target so the tooltip path is precise. */}
        <button
          type="button"
          onClick={handleRadioClick}
          onKeyDown={(e) => {
            if (e.key === " " || e.key === "Enter") handleRadioClick(e);
          }}
          aria-checked={isSelected}
          role="radio"
          aria-label={
            isListable
              ? `Select ${label}`
              : `${label} — not listable. Pick a sub-category.`
          }
          className={cn(
            "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors focus:outline-none focus:ring-2 focus:ring-orange-300",
            isSelected
              ? "border-orange-500 bg-orange-500"
              : isListable
              ? "border-zinc-300 hover:border-orange-400"
              : "border-zinc-200",
          )}
        >
          {isSelected && <Check className="h-2.5 w-2.5 text-white" />}
        </button>

        {/* Body — drills if hasChildren, else selects (for listable leaves). */}
        <button
          type="button"
          onClick={handleBodyClick}
          className="flex flex-1 items-center gap-3 min-w-0 text-left"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-zinc-800">{label}</span>
            {subLabel && (
              <span className="block truncate text-[11px] text-zinc-400">{subLabel}</span>
            )}
          </span>
          {hasChildren && (
            <ChevronRight className="h-4 w-4 shrink-0 text-zinc-400" />
          )}
        </button>
      </div>

      {/* Blocked-tooltip — anchored to the radio (top-left of row). Inline
          implementation: small, no portal, no Radix dependency. */}
      {blocked && (
        <div
          role="status"
          aria-live="polite"
          className="absolute left-5 top-full z-10 mt-1 max-w-[280px] rounded-md bg-zinc-900 px-3 py-1.5 text-[11px] text-white shadow-lg"
        >
          This category can&apos;t be used for listing. Please choose a sub-category.
          <span className="absolute -top-1 left-2 h-2 w-2 rotate-45 bg-zinc-900" />
        </div>
      )}
    </li>
  );
}
