"use client";

/**
 * CategoryRow — a single row in the Jumia-style category drawer.
 *
 * Behaviour matches Vendor Center exactly:
 *
 *   • A row is SELECTABLE only when it has no children (i.e. it's a
 *     leaf in the tree). Parents always drill — clicking the row body,
 *     the chevron, OR the radio of a parent navigates one level deeper.
 *     Sellers can never pick a parent directly in VC; same here.
 *
 *   • Hovering a non-selectable row reveals an inline tooltip
 *     positioned to the LEFT of the drawer, in the dimmed backdrop area,
 *     with an arrow pointing back at the row. 300ms delay before show
 *     to avoid flickering when scrubbing the mouse through the list.
 *     The tooltip is rendered via createPortal to document.body so any
 *     `overflow` or `transform` on the drawer chain can't clip it.
 *
 *   • Leaves (no children) are selectable. Clicking the radio or the
 *     row body selects them.
 *
 * Listability is decided by the caller via `isSelectable`. We don't
 * infer it here so the same component works for tree nodes AND flat
 * search results.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
   * Whether this row can be selected directly (radio click selects it).
   * In VC: leaves only. Parents always drill regardless of whether they
   * have an attributeSet on Jumia's side.
   */
  isSelectable: boolean;
  /** Whether this row is the currently-selected one (radio filled). */
  isSelected:   boolean;
  /** Called when the seller drills into this row (body or chevron click). */
  onDrillIn:    () => void;
  /** Called when the seller selects this row (only fires if isSelectable). */
  onSelect:     () => void;
}

const TOOLTIP_DELAY_MS = 300;

export function CategoryRow({
  label,
  subLabel,
  hasChildren,
  isSelectable,
  isSelected,
  onDrillIn,
  onSelect,
}: CategoryRowProps) {
  const rowRef        = useRef<HTMLLIElement>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const [tooltipCoords, setTooltipCoords] = useState<{ top: number; right: number } | null>(null);
  const [mounted, setMounted] = useState(false);

  // Only render portal after mount (avoids SSR hydration mismatch).
  useEffect(() => { setMounted(true); }, []);

  // Show tooltip after a brief delay when hovering a non-selectable row.
  // Compute coordinates from the row's bounding box and the viewport
  // width — positions the tooltip in the dim backdrop area to the left
  // of the drawer, vertically centred on the row.
  const showTooltipSoon = () => {
    if (isSelectable) return;
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      const rect = rowRef.current?.getBoundingClientRect();
      if (!rect) return;
      // The drawer's left edge is at rect.left (rows sit at the right side
      // of the screen). Anchor the tooltip's right edge 16px to the left
      // of the drawer, vertically centred on the row.
      setTooltipCoords({
        top:   rect.top + rect.height / 2,
        right: window.innerWidth - rect.left + 16,
      });
      setTooltipOpen(true);
    }, TOOLTIP_DELAY_MS);
  };

  const hideTooltip = () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    setTooltipOpen(false);
  };

  useEffect(() => () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
  }, []);

  // Unified click handler. The whole row + chevron drills (if parent) or
  // selects (if leaf). The radio's onClick is the same — VC doesn't
  // require pinpoint accuracy on the small radio dot.
  const handleClick = () => {
    hideTooltip();
    if (hasChildren) {
      onDrillIn();
    } else if (isSelectable) {
      onSelect();
    }
  };

  return (
    <li
      ref={rowRef}
      className="relative"
      onMouseEnter={showTooltipSoon}
      onMouseLeave={hideTooltip}
    >
      <button
        type="button"
        onClick={handleClick}
        className={cn(
          "flex w-full items-center gap-3 px-5 py-3 text-left transition-colors",
          "hover:bg-orange-50",
        )}
      >
        {/* Radio — visual state only. Click target is the whole row above. */}
        <span
          aria-checked={isSelected}
          role="radio"
          className={cn(
            "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
            isSelected
              ? "border-orange-500 bg-orange-500"
              : isSelectable
              ? "border-zinc-300"
              : "border-zinc-200",
          )}
        >
          {isSelected && <Check className="h-2.5 w-2.5 text-white" />}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-zinc-800">{label}</span>
          {subLabel && (
            <span className="block truncate text-[11px] text-zinc-400">{subLabel}</span>
          )}
        </span>

        {hasChildren && (
          <ChevronRight className="h-4 w-4 shrink-0 text-orange-500" />
        )}
      </button>

      {/* Portal-rendered tooltip — sits in document.body so the drawer's
          overflow / transform never clips it. Positioned to the LEFT of
          the drawer, vertically centred on the hovered row, with an
          arrow pointing right (back toward the row). */}
      {mounted && tooltipOpen && tooltipCoords && createPortal(
        <div
          role="status"
          aria-live="polite"
          style={{
            position:  "fixed",
            top:       tooltipCoords.top,
            right:     tooltipCoords.right,
            transform: "translateY(-50%)",
            zIndex:    60,
          }}
          className="max-w-[260px] rounded-md bg-zinc-900 px-3 py-2 text-[11px] leading-snug text-white shadow-lg pointer-events-none"
        >
          This category can&apos;t be used for listing. Please choose a sub-category.
          {/* Arrow pointing right toward the row */}
          <span className="absolute right-[-4px] top-1/2 h-2 w-2 -translate-y-1/2 rotate-45 bg-zinc-900" />
        </div>,
        document.body,
      )}
    </li>
  );
}
