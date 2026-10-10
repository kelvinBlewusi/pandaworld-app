/**
 * The blocks an answer is laid out in (lib/whatsapp/rich.ts sends them; the
 * Listing Assistant's page draws them: components/assistant/rich-message.tsx).
 * Pure, so the page can use it.
 */

export type RichTone = "good" | "warn" | "bad" | "info" | "neutral";
/** A table cell: words, or words with a colour (a status). */
export type RichCell = string | { text: string; tone: RichTone };

export type RichBlock =
  | { kind: "heading"; text: string; sub?: string }
  /** A row of numbers, each in its own tile ("On 120", "Out of stock 4"). */
  | { kind: "stats"; items: { label: string; value: string; tone?: RichTone; note?: string }[] }
  /** `align` per column; "right" for numbers and money. `folded`: shown closed, under `title`, opened with a tap. */
  | { kind: "table"; columns: string[]; rows: RichCell[][]; align?: ("left" | "right")[]; more?: string; title?: string; folded?: boolean }
  /** Horizontal bars, longest first as given: sales by product, orders by status. */
  | { kind: "bars"; items: { label: string; value: number; shown: string; tone?: RichTone }[] }
  /** Words, with WhatsApp's *bold* and _italic_. */
  | { kind: "text"; text: string }
  /** A side remark in a soft box: what's still applying, what to try next. */
  | { kind: "note"; text: string; tone?: RichTone };

const BLOCK_KINDS = new Set(["heading", "stats", "table", "bars", "text", "note"]);

/** The blocks of a stored message, or null when there are none fit to draw. Pure. */
export function richBlocks(v: unknown): RichBlock[] | null {
  const blocks = (v as { blocks?: unknown } | null)?.blocks;
  if (!Array.isArray(blocks) || blocks.length === 0) return null;
  const ok = blocks.filter((b): b is RichBlock => !!b && typeof b === "object" && BLOCK_KINDS.has((b as { kind?: string }).kind ?? ""));
  return ok.length > 0 ? ok.slice(0, 20) : null;
}

/** A status with its colour. */
export const cell = (text: string, tone: RichTone): RichCell => ({ text, tone });

/** "ON"/"OFF"/"Rejected" for a product, coloured (owner, 2026-10-10: ON/OFF in capitals). */
export function productStatusCell(p: { status: string | null; qcStatus: string | null; stock: number | null }): RichCell {
  if (p.status === "DELETED") return cell("Deleted", "neutral");
  if (p.qcStatus === "REJECTED") return cell("Rejected", "bad");
  if (p.qcStatus === "PENDING" || p.qcStatus === "NOT_READY_TO_QC") return cell("Waiting for QC", "info");
  if (p.status === "INACTIVE") return cell("OFF", "neutral");
  if (p.status === "ACTIVE" && p.stock === 0) return cell("Out of stock", "bad");
  if (p.status === "ACTIVE") return cell("ON", "good");
  return cell(p.status ? p.status.toLowerCase() : "?", "neutral");
}

/** A stock number, coloured: 0 red, low amber. */
export function stockCell(stock: number | null, low = 3): RichCell {
  if (stock == null) return cell("?", "neutral");
  return cell(String(stock), stock === 0 ? "bad" : stock <= low ? "warn" : "neutral");
}
