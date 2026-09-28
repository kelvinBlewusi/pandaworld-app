/**
 * Credit packs and what things cost in credits — the only pricing there
 * is (the monthly plans were removed 2026-09-28). Sold from the dashboard's
 * Buy Credits modal and shown on /pricing; charged only while billing is on
 * (lib/billing/mode.ts).
 */

export interface CreditPack {
  id: string;
  credits: number;
  amountGhs: number;
}

/**
 * 1 credit = GHS 0.25 in every pack, so a live WhatsApp / web listing
 * (LIVE_LISTING_CREDIT_COST = 2) is GHS 0.50 however much a seller buys.
 * Smallest purchase GHS 30, largest GHS 100 (set 2026-09-28).
 */
export const CREDIT_PACKS: CreditPack[] = [
  { id: "starter", credits: 120, amountGhs: 30 },
  { id: "small",   credits: 200, amountGhs: 50 },
  { id: "medium",  credits: 400, amountGhs: 100 },
];

/** Pack id shown with the "Popular" badge in the Buy Credits modal. */
export const POPULAR_PACK_ID = "small";

export function getCreditPack(id: string): CreditPack | undefined {
  return CREDIT_PACKS.find((p) => p.id === id);
}

/**
 * Credit amounts of earlier packs (100/280/600 until 2026-09-13, then
 * 150/330/650 until 2026-09-28) — kept so a purchase transaction recorded
 * back then still resolves to its pack instead of showing no "Plan" pill.
 */
const LEGACY_CREDIT_AMOUNTS: Record<number, string> = {
  100: "starter", 280: "small", 600: "medium",
  150: "starter", 330: "small", 650: "medium",
};

/**
 * Reverse lookup by credit count — each pack has a distinct `credits`
 * value, so a purchase transaction's `amount` (see extension_credit_
 * transactions) identifies which pack was bought without needing its own
 * stored pack id. Used for the dashboard's "Plan" pill (lib/billing/
 * extension-credits.ts's getMostRecentCreditPack()).
 */
export function getCreditPackByCredits(credits: number): CreditPack | undefined {
  return (
    CREDIT_PACKS.find((p) => p.credits === credits) ??
    CREDIT_PACKS.find((p) => p.id === LEGACY_CREDIT_AMOUNTS[credits])
  );
}

/**
 * Every sign-up starts with this many free credits, spendable on the
 * extension and WhatsApp alike (lib/billing/extension-credits.ts). 25 as
 * of 2026-09-28 (was 10).
 */
export const FREE_SIGNUP_CREDITS = 25;

/** One extension autofill costs this many credits. 1.5 as of 2026-09-28 (was 2.5). */
export const LISTING_CREDIT_COST = 1.5;

/**
 * A WhatsApp or web listing costs this many credits, charged once, when
 * Jumia confirms it live — drafts, redrafts and listings Jumia rejects
 * cost nothing (2026-09-28). Held against the balance from submission
 * until Jumia's verdict: see chargeLiveListing / creditsDueForSubmission
 * in lib/billing/extension-credits.ts. Priced above an extension autofill
 * because we draft AND submit the whole listing, where the extension only
 * fills a form the seller submits themselves.
 */
export const LIVE_LISTING_CREDIT_COST = 2;

/**
 * One AI image (a photo polished or rebuilt on the review page, or one
 * generated from text) costs this many credits. Image models bill per
 * image, about $0.04 each (Gemini image edit, Imagen 3), several times a
 * whole listing draft, so priced to match. Charged per image that came
 * back, after it's saved; an image served from the listing's cache is
 * free. Set 2026-09-28 along with the move off monthly plans, whose
 * "polish" quota these used to count against.
 */
export const IMAGE_CREDIT_COST = 4;

/** How far a number of credits goes: whole autofills, or whole live WhatsApp / web listings. */
export function packReach(credits: number): { autofills: number; listings: number } {
  return {
    autofills: Math.floor(credits / LISTING_CREDIT_COST),
    listings:  Math.floor(credits / LIVE_LISTING_CREDIT_COST),
  };
}

/**
 * Prepares a balance for a JSON API response (app/api/extension/account,
 * app/api/extension/fill) — `JSON.stringify(Infinity)` silently becomes
 * `null`, which the extension panel can't tell apart from "unknown". This
 * makes the unlimited case (admins, and everyone while billing is off —
 * see lib/billing/extension-credits.ts) explicit instead.
 */
export function serializeCredits(balance: number): { value: number | null; unlimited: boolean } {
  if (!Number.isFinite(balance)) return { value: null, unlimited: true };
  return { value: balance, unlimited: false };
}
