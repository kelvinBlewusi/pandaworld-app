import { appUrl } from "@/lib/whatsapp/app-url";

/**
 * Pure parsing/formatting helpers for the WhatsApp multi-product batch
 * flow, split out from lib/whatsapp/intake.ts for the same reason
 * lib/whatsapp/draft.ts is split out — unit-testable without pulling in
 * Supabase/AI-pipeline transitive deps.
 */

const MAX_BATCH_SIZE = 20;

/** "3", "3.", "three products" (digits only — no word-number parsing, kept
 *  deliberately simple) → 3. Rejects 0, negatives, and anything above the cap. */
export function parseProductCount(text: string): number | null {
  const trimmed = text.trim();
  const match = trimmed.match(/\d+/);
  if (!match || match.index == null) return null;
  if (trimmed[match.index - 1] === "-") return null; // "-1" isn't a count
  const n = parseInt(match[0], 10);
  if (!Number.isFinite(n) || n < 1 || n > MAX_BATCH_SIZE) return null;
  return n;
}

export type SubmitCommand = { all: true } | { all: false; seqs: number[] };

/** "submit" / "submit all" → all products. "submit 1 and 4" / "submit 2, 3"
 *  → just those product numbers. Returns null if the message isn't a submit
 *  command at all. */
export function parseSubmitCommand(text: string): SubmitCommand | null {
  const trimmed = text.trim();
  if (!/^submit\b/i.test(trimmed)) return null;
  const rest = trimmed.replace(/^submit\b/i, "").trim();
  if (!rest || /^all$/i.test(rest)) return { all: true };
  const nums = rest.match(/\d+/g);
  if (!nums || nums.length === 0) return { all: true };
  const seqs = Array.from(new Set(nums.map((n) => parseInt(n, 10)))).sort((a, b) => a - b);
  return { all: false, seqs };
}

export type EditCommand =
  | { needsSeq: false; seq: number; text: string; explicit: boolean }
  | { needsSeq: true; text: string };

/**
 * "2: change the color to blue" / "product 3 - make it size L" → an edit
 * targeting that product number (`explicit: true` — the "N:" syntax is an
 * unambiguous, deliberate edit regardless of what follows). When the batch
 * has exactly one product, a leading number isn't required — any other
 * text is treated as applying to product 1 directly (`explicit: false`),
 * and when the batch has more than one, `needsSeq: true` asks which
 * product it's for.
 *
 * Returns null only for a submit command or empty text. The `explicit:
 * false` / `needsSeq: true` cases are NOT reliable signals that the
 * seller actually meant an edit — "Hi" or "New listing" match them too —
 * callers should gate those two on something like looksActionable() from
 * lib/whatsapp/intent.ts before acting, and only ever treat the explicit
 * numbered form as a sure thing.
 */
export function parseEditCommand(text: string, batchSize: number): EditCommand | null {
  const trimmed = text.trim();
  if (!trimmed || /^submit\b/i.test(trimmed)) return null;

  const numbered = trimmed.match(/^(?:product\s*)?#?(\d+)\s*[:\-]\s*([\s\S]+)$/i);
  if (numbered) {
    const seq = parseInt(numbered[1], 10);
    const editText = numbered[2].trim();
    if (editText) return { needsSeq: false, seq, text: editText, explicit: true };
  }

  if (batchSize === 1) return { needsSeq: false, seq: 1, text: trimmed, explicit: false };

  return { needsSeq: true, text: trimmed };
}

// ─── Deterministic price/stock extraction ──────────────────────────────────
//
// Price and stock are seller-owned fields — never AI-guessed anywhere else
// in this codebase (see lib/actions/auto-analyze.ts), and that rule holds
// here too. This is plain regex over what the seller explicitly typed, not
// an inference — if it doesn't match a clear, explicit number, it returns
// null and the seller sets it on the review page instead.

/** "price 150", "price: GHS 150", "₵150", "150 cedis" → 150. Null if no
 *  explicit price-shaped number is found. */
export function extractPrice(text: string): number | null {
  const labeled = text.match(/price\s*[:=]?\s*(?:GH[SC]?|GH₵|₵)?\s*(\d+(?:\.\d+)?)/i);
  if (labeled) return parseFloat(labeled[1]);
  const currency = text.match(/(?:GH[SC]?|GH₵|₵)\s*(\d+(?:\.\d+)?)/i) ?? text.match(/(\d+(?:\.\d+)?)\s*ced[ei]s/i);
  if (currency) return parseFloat(currency[1]);
  return null;
}

/** "stock 10", "qty: 10", "quantity 10" → 10. Null otherwise. */
export function extractStock(text: string): number | null {
  const match = text.match(/(?:stock|qty|quantity)\s*[:=]?\s*(\d+)/i);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function whatsappListingsUrl(batchId?: string): string {
  const base = `${appUrl()}/extension/whatsapp-listings`;
  return batchId ? `${base}?batch=${batchId}` : base;
}

/** The focused single-product editor for one chat-drafted listing — see
 *  app/extension/(app)/whatsapp-listings/[id]/page.tsx. */
export function focusedEditorUrl(listingId: string): string {
  return `${appUrl()}/extension/whatsapp-listings/${listingId}`;
}
