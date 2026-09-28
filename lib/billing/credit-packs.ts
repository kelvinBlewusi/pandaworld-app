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

export const CREDIT_PACKS: CreditPack[] = [
  { id: "starter", credits: 150, amountGhs: 20 },
  { id: "small",   credits: 330, amountGhs: 50 },
  { id: "medium",  credits: 650, amountGhs: 100 },
];

/** Pack id shown with the "Popular" badge in the Buy Credits modal. */
export const POPULAR_PACK_ID = "small";

export function getCreditPack(id: string): CreditPack | undefined {
  return CREDIT_PACKS.find((p) => p.id === id);
}

/**
 * Credit amounts from before the 2026-09-13 price increase (100/280/600 ->
 * 150/330/650, same GHS price each) — kept so a purchase transaction
 * recorded before that change still resolves to its pack instead of
 * showing no "Plan" pill at all.
 */
const LEGACY_CREDIT_AMOUNTS: Record<number, string> = { 100: "starter", 280: "small", 600: "medium" };

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
 * One WhatsApp product draft (a single runAutoAnalyze pass) costs this
 * many credits (2 as of 2026-09-28, was 3) — priced higher than an
 * extension autofill because
 * it runs the full listing pipeline (describe + category pick + attribute
 * fill, up to 3-6 Gemini calls) rather than one single vision call.
 * Deducted only after a successful draft, same rule LISTING_CREDIT_COST
 * follows — see deductCredits()'s call site in
 * app/api/extension/fill/route.ts and its WhatsApp counterpart in
 * lib/whatsapp/intake.ts's startBatchAnalysis().
 */
export const WHATSAPP_DRAFT_CREDIT_COST = 2;

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

/** How far a number of credits goes: whole autofills, or whole WhatsApp / web drafts. */
export function packReach(credits: number): { autofills: number; drafts: number } {
  return {
    autofills: Math.floor(credits / LISTING_CREDIT_COST),
    drafts:    Math.floor(credits / WHATSAPP_DRAFT_CREDIT_COST),
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
