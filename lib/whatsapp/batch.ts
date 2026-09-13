import { appUrl } from "@/lib/whatsapp/app-url";

/**
 * Pure parsing/formatting helpers for the WhatsApp multi-product batch
 * flow, split out from lib/whatsapp/intake.ts for the same reason
 * lib/whatsapp/draft.ts is split out — unit-testable without pulling in
 * Supabase/AI-pipeline transitive deps.
 */

/**
 * How many products one chat batch may hold.
 *
 * Lowered from 20 to 5 on 2026-09-13, on measurement rather than taste.
 * startBatchAnalysis runs every product's analysis CONCURRENTLY inside the
 * WhatsApp webhook, which Vercel kills at 60s (ANALYSIS_DEADLINE_MS in
 * lib/whatsapp/intake.ts races it at 45s so a reply always gets out). A
 * single product measured 22.7s end to end in production — already half
 * that deadline on its own — and each one makes 3-4 Gemini vision calls
 * and holds up to MAX_LISTING_IMAGES images in the shared in-process
 * cache. At 20 that is 60-80 concurrent Gemini calls and up to 160 cached
 * images from one instance: rate-limit territory, and every product that
 * misses the deadline reports "still finishing" to the seller having
 * consumed nothing but time.
 *
 * 5 keeps the burst near 20 calls with roughly 2x headroom over the
 * measured single-product time. Raising it meaningfully isn't a matter of
 * changing this number — it needs the analysis moved off the request path
 * onto a background worker, at which point the 60s ceiling stops being
 * the binding constraint at all.
 */
export const MAX_BATCH_SIZE = 5;

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

/** Quick-pick buttons for the "how many products?" prompt — the single
 *  most common counts, so a seller can tap instead of typing; free-text
 *  numbers up to MAX_BATCH_SIZE still work exactly the same (the button
 *  id IS the digit, so it round-trips straight through parseProductCount). */
export const COUNT_QUICK_PICKS: { id: string; title: string }[] = [
  { id: "1", title: "1 product" },
  { id: "2", title: "2 products" },
  { id: "3", title: "3 products" },
];

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

/** "price 150", "price: GHS 150", "the price is 150", "₵150", "150 cedis"
 *  → 150. A message that's JUST a bare number ("200") also counts —
 *  confirmed live: a seller told "tell me the price" (the photo-prompt's
 *  own wording, no keyword required) reasonably just types "200", and
 *  requiring a "price"/currency prefix silently dropped it, leaving the
 *  listing with no price and "price is required" errors at submit time.
 *  Null if neither shape matches.
 *
 *  The optional "is"/"was" before the separator matters: confirmed live,
 *  "The price is 150" (a completely natural way to say it, and how the
 *  photo-collection prompt's own example phrases it) didn't match when
 *  the gap between "price" and the separator only allowed whitespace —
 *  the seller got told "still needs: price" despite having stated it. */
export function extractPrice(text: string): number | null {
  // Negative lookbehind excludes "sale price 100" — that's
  // extractSalePrice's territory (below); without this guard, a message
  // that states ONLY a sale price (no regular price at all) would have
  // its sale price misread as the regular selling price.
  const labeled = text.match(/(?<!sale\s)price\s*(?:is|was)?\s*[:=]?\s*(?:GH[SC]?|GH₵|₵)?\s*(\d+(?:\.\d+)?)/i);
  if (labeled) return parseFloat(labeled[1]);
  const currency = text.match(/(?:GH[SC]?|GH₵|₵)\s*(\d+(?:\.\d+)?)/i) ?? text.match(/(\d+(?:\.\d+)?)\s*ced[ei]s/i);
  if (currency) return parseFloat(currency[1]);
  const bare = text.trim().match(/^(\d+(?:\.\d+)?)$/);
  if (bare) return parseFloat(bare[1]);
  return null;
}

/** "stock 10", "qty: 10", "the stock is 10", "quantity 10" → 10. Null
 *  otherwise. Same "is"/"was" tolerance as extractPrice, and for the same
 *  reason — a seller phrasing it as a full sentence shouldn't silently
 *  fail to register. */
export function extractStock(text: string): number | null {
  const match = text.match(/(?:stock|qty|quantity)\s*(?:is|was)?\s*[:=]?\s*(\d+)/i);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ─── Deterministic sale-price + date-range extraction ──────────────────────
//
// Same "seller-owned, never AI-guessed" principle as price/stock above — a
// sale price and its start/end dates are things the seller states
// explicitly, not something to infer from images. Dates are only ever set
// when confidently parsed; anything else is left unset rather than
// guessed, matching extractPrice's "null beats wrong" rule. Not yet wired
// into persistence anywhere — see the caller for what listing/variant
// field this should land in.

export interface SalePriceExtraction {
  salePrice: number;
  /** ISO "YYYY-MM-DD", only set when confidently parsed. */
  startDate?: string;
  /** ISO "YYYY-MM-DD", only set when confidently parsed. */
  endDate?: string;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
  apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
  aug: 7, august: 7, sep: 8, sept: 8, september: 8,
  oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Parses one date phrase — "20 September", "September 20, 2026", or
 *  "2026-09-20" — into an ISO "YYYY-MM-DD" string, or null if it doesn't
 *  match a supported shape (deliberately narrow: a wrong sale window on a
 *  live marketplace is worse than not setting one). When no year is
 *  given, assumes the current year, rolling to next year if that date
 *  has already passed — sale windows are always near-future. */
function parseDatePhrase(raw: string, now: Date): string | null {
  const phrase = raw.trim().replace(/[.,]+$/, "");

  const iso = phrase.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    const month = parseInt(iso[2], 10);
    const day = parseInt(iso[3], 10);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${iso[1]}-${pad2(month)}-${pad2(day)}`;
  }

  const dayMonth = phrase.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?\s*(\d{4})?$/);
  const monthDay = !dayMonth ? phrase.match(/^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?$/) : null;
  const m = dayMonth
    ? { day: parseInt(dayMonth[1], 10), monthName: dayMonth[2], year: dayMonth[3] }
    : monthDay
    ? { day: parseInt(monthDay[2], 10), monthName: monthDay[1], year: monthDay[3] }
    : null;
  if (!m) return null;

  const month = MONTH_NAMES[m.monthName.toLowerCase()];
  if (month == null || m.day < 1 || m.day > 31) return null;

  let year = m.year ? parseInt(m.year, 10) : now.getFullYear();
  if (!m.year) {
    const candidate = new Date(Date.UTC(year, month, m.day));
    const oneDayMs = 24 * 3600 * 1000;
    if (candidate.getTime() < now.getTime() - oneDayMs) year += 1;
  }
  return `${year}-${pad2(month + 1)}-${pad2(m.day)}`;
}

/** "sale price 120", "discount to 100 from 20 September to 30 September",
 *  "sale price is 80 until 2026-10-01" → { salePrice, startDate?, endDate? }.
 *  Null if no sale price is stated at all. A stated price with a date
 *  range that doesn't parse still returns the price — dates are additive,
 *  not required for the sale price itself to register. The `(?!\s*%)`
 *  guard stops "20% off"/"discount 20%" from being misread as a GH₵20
 *  sale price — "discount" alone (unlike "sale price") is genuinely
 *  ambiguous between a percentage and a flat amount. */
export function extractSalePrice(text: string, now: Date = new Date()): SalePriceExtraction | null {
  // (?!\d) before the %-guard matters: without it, a greedy \d+ that fails
  // the %-guard backtracks to a SHORTER digit run that dodges it (e.g.
  // "20%" backtracking from "20" to "2" — "2" isn't immediately followed
  // by "%", so the guard alone would let "discount 20% off" through as
  // salePrice=2). (?!\d) rejects any match that isn't the full digit run,
  // closing that backtrack path.
  const priceMatch = text.match(
    /(?:sale\s*price|discount(?:ed)?\s*(?:price)?)\s*(?:is|was|to|of)?\s*[:=]?\s*(?:GH[SC]?|GH₵|₵)?\s*(\d+(?:\.\d+)?)(?!\d)(?!\s*%)/i,
  );
  if (!priceMatch) return null;
  const result: SalePriceExtraction = { salePrice: parseFloat(priceMatch[1]) };

  const range = text.match(/from\s+([^.,\n]+?)\s+(?:to|until|till)\s+([^.,\n]+?)(?=[.,\n]|$)/i);
  if (range) {
    const start = parseDatePhrase(range[1], now);
    const end = parseDatePhrase(range[2], now);
    // Confirmed live: "30th September 2026 to 31 December 2025" (an
    // explicit year on each side, so parseDatePhrase's own "roll to next
    // year" logic never kicks in to fix it) parsed to a start AFTER the
    // end — an inverted sale window that would confuse Jumia at best. Both
    // dates individually parsed fine; only the pairing is wrong, and there's
    // no reliable way to guess which side the seller actually meant, so
    // drop both rather than publish a window nobody could have intended —
    // same "null beats wrong" rule as everywhere else in this file. The
    // sale PRICE itself still applies; only the date window is dropped.
    if (start && end && start > end) {
      console.warn(`[whatsapp batch] dropped inverted sale date range: "${start}" to "${end}"`);
    } else {
      if (start) result.startDate = start;
      if (end) result.endDate = end;
    }
  } else {
    const untilOnly = text.match(/(?:until|till|ending)\s+([^.,\n]+?)(?=[.,\n]|$)/i);
    if (untilOnly) {
      const end = parseDatePhrase(untilOnly[1], now);
      if (end) result.endDate = end;
    }
  }

  return result;
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

/** The extension dashboard's Buy Credits modal — same credit ledger a
 *  WhatsApp draft now spends from (see WHATSAPP_DRAFT_CREDIT_COST in
 *  lib/billing/credit-packs.ts). */
export function buyCreditsUrl(): string {
  return `${appUrl()}/extension/dashboard`;
}
