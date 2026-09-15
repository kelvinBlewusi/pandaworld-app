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
 * Briefly 5, now 20 again — but for a different reason than the original
 * 20, which was simply untested. Analysis used to run CONCURRENTLY inside
 * the WhatsApp webhook, racing Vercel's 60s kill; one product measured
 * 22.7s in production, so a large batch meant products silently reporting
 * "still finishing" having produced nothing, and 5 was what actually fit.
 *
 * Batches now queue (supabase/migrations/2026-09-13_analysis-jobs-queue.sql)
 * and drain in app/api/worker/analyze-jobs, CLAIM_LIMIT products per tick,
 * each tick chaining into the next. The per-request ceiling no longer
 * applies, so exceeding capacity costs TIME rather than failing: a 20-
 * product batch takes a few minutes and the seller watches "✅ Product N
 * drafted" arrive throughout.
 *
 * What still binds, and what to check before raising this further:
 *   - The Gemini/Vertex per-project quota, which every seller shares. That
 *     is the real global ceiling and it is not measured yet.
 *   - Patience. At CLAIM_LIMIT 3 this is roughly 3 products per ~25s, so
 *     50 would be a ~7-minute wait — long enough to read as broken even
 *     though nothing is.
 */
export const MAX_BATCH_SIZE = 20;

/** "3", "3.", "three products" (digits only — no word-number parsing, kept
 *  deliberately simple) → 3. Rejects 0, negatives, and anything above the cap. */
export function parseProductCount(text: string): number | null {
  const result = readProductCount(text);
  return result.ok ? result.count : null;
}

/** Why a count was rejected — so the seller gets told the real reason. */
export type CountRejection =
  | { ok: true;  count: number }
  | { ok: false; reason: "no_number" }
  | { ok: false; reason: "too_many"; value: number }
  | { ok: false; reason: "too_few";  value: number };

/**
 * Same parse as parseProductCount, but says WHY it failed.
 *
 * parseProductCount collapses every rejection to null, which made "50"
 * and "a few" indistinguishable to the caller — so a seller who asked for
 * 50 products was answered "⚠️ I need a number to get started". They had
 * given one. The cap is real and worth stating plainly; pretending not to
 * understand is the wrong way to state it.
 */
export function readProductCount(text: string): CountRejection {
  const trimmed = text.trim();
  const match = trimmed.match(/\d+/);
  if (!match || match.index == null) return { ok: false, reason: "no_number" };
  // "-1" isn't a count.
  if (trimmed[match.index - 1] === "-") return { ok: false, reason: "no_number" };

  const n = parseInt(match[0], 10);
  if (!Number.isFinite(n)) return { ok: false, reason: "no_number" };
  if (n < 1) return { ok: false, reason: "too_few",  value: n };
  if (n > MAX_BATCH_SIZE) return { ok: false, reason: "too_many", value: n };
  return { ok: true, count: n };
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

  // Number BEFORE the currency: "110 ghs", "110GHC", "110 ₵".
  //
  // Only "N cedis" was handled in this direction, so "110 ghs sold in
  // singles" read as no price at all — the seller stated it plainly and
  // the listing was still blocked at submit with "price is required".
  // Seen live on 2026-09-15.
  // The \b rides on the LETTER forms only. A word boundary needs a
  // word/non-word transition, and ₵ is already non-word, so "200 ₵"
  // matched nothing at all with the boundary on the outside.
  const trailingCurrency = text.match(/(\d+(?:\.\d+)?)\s*(?:GH[SC]\b|GH₵|₵)/i);
  if (trailingCurrency) return parseFloat(trailingCurrency[1]);

  const bare = text.trim().match(/^(\d+(?:\.\d+)?)$/);
  if (bare) return parseFloat(bare[1]);

  // A number alone on its own LINE, when the message says nothing else
  // numeric about money.
  //
  // The whole-message rule above only fires when the message is nothing
  // but a number. Sellers routinely put the price on one line and notes on
  // the next:
  //
  //   210
  //   The colors available are Blue and Red
  //
  // which lost the price entirely. Both real cases on 2026-09-15 put it on
  // its own line, one at the top and one at the bottom.
  //
  // Guarded hard, because a bare number is the most ambiguous thing a
  // seller can type: EXACTLY ONE such line may exist. Two or more and this
  // returns null rather than picking, which is the same "null beats wrong"
  // rule the rest of this file follows — a size and a price on separate
  // lines must not become a coin flip.
  const bareLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+(?:\.\d+)?$/.test(line));
  if (bareLines.length === 1) return parseFloat(bareLines[0]);

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
  /**
   * Set when a date range WAS found but refused. The seller wrote
   * something they expect to see on the listing, so silence reads as the
   * system ignoring them — the caller surfaces this so they can correct
   * it rather than discover the missing promo dates later.
   */
  dateWarning?: string;
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
/**
 * A sale window, however the seller happens to introduce it.
 *
 * Previously this required the literal word "from", which meant a note
 * reading "Start and end date is 30th September 2026 to 31 December 2026"
 * produced no dates at all — the seller stated a promo window in plain
 * English and got silence. "from" is only one of the ways people write it,
 * and not the most natural one after a label like "start and end date".
 *
 * Still anchored on an explicit lead-in rather than matching a bare
 * "X to Y" anywhere in the note: unanchored, "available in sizes 4 to 8"
 * or "takes 3 to 5 days" would both read as a sale window.
 */
const DATE_RANGE_RE =
  /(?:from|between|(?:sale|promo(?:tion)?|start(?:\s+and\s+end)?|end)?\s*dates?\s*(?:is|are|will\s+be)?\s*(?:from)?)\s+([^.,\n]+?)\s+(?:to|until|till|through)\s+([^.,\n]+?)(?=[.,\n]|$)/i;

export function extractSalePrice(text: string, now: Date = new Date()): SalePriceExtraction | null {
  // (?!\d) before the %-guard matters: without it, a greedy \d+ that fails
  // the %-guard backtracks to a SHORTER digit run that dodges it (e.g.
  // "20%" backtracking from "20" to "2" — "2" isn't immediately followed
  // by "%", so the guard alone would let "discount 20% off" through as
  // salePrice=2). (?!\d) rejects any match that isn't the full digit run,
  // closing that backtrack path.
  const priceMatch = text.match(
    /(?:sales?\s*price|promo(?:tion(?:al)?)?\s*price|discount(?:ed)?\s*(?:price)?)\s*(?:is|was|to|of|at)?\s*[:=]?\s*(?:GH[SC]?|GH₵|₵)?\s*(\d+(?:\.\d+)?)(?!\d)(?!\s*%)/i,
  );
  if (!priceMatch) return null;
  const result: SalePriceExtraction = { salePrice: parseFloat(priceMatch[1]) };

  const range = text.match(DATE_RANGE_RE);
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
      result.dateWarning =
        `the promo dates read ${start} to ${end}, which ends before it starts — the sale price is set, but add the dates in the editor`;
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
