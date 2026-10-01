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
 * Launch pricing, set 2026-10-01: 1 credit = GHS 0.35 at the Starter
 * price, so a live WhatsApp / web listing (LIVE_LISTING_CREDIT_COST = 2)
 * is GHS 0.70, an extension autofill (1 credit) GHS 0.35 and an AI image
 * (4 credits) GHS 1.40. Bigger packs carry up to 15% extra credits; at the
 * Business rate a listing is about GHS 0.60. Costs it was set against
 * (per live WhatsApp listing, measured): AI drafting ~GHS 0.05, WhatsApp
 * messages ~GHS 0.18 (Meta charges per bot message from 2026-10-01),
 * Paystack 1.95%; plus ~GHS 530 a month fixed (Vercel Pro, Supabase Pro).
 * Break-even is about 1,200 listings a month.
 *
 * Was GHS 0.25 a credit in every pack (120 / 200 / 400 credits for GHS
 * 30 / 50 / 100), 2026-09-28 to 2026-10-01.
 */
export const CREDIT_PACKS: CreditPack[] = [
  { id: "starter",  credits: 100, amountGhs: 35 },
  { id: "standard", credits: 210, amountGhs: 70 },
  { id: "pro",      credits: 440, amountGhs: 140 },
  { id: "business", credits: 940, amountGhs: 280 },
];

/** Pack id shown with the "Popular" badge in the Buy Credits modal. */
export const POPULAR_PACK_ID = "standard";

/** A pack's place in CREDIT_PACKS, smallest first; -1 for none or an unknown id. */
export function packRank(id: string | null | undefined): number {
  return CREDIT_PACKS.findIndex((p) => p.id === id);
}

/**
 * Features that come with a pack, from `minPack` up. A seller has a
 * feature once they've bought that pack or a bigger one, ever: the
 * highest pack bought counts, a smaller top-up later doesn't take it away
 * (lib/billing/features.ts). Set by the owner, 2026-10-01.
 *
 * `comingSoon` features are only advertised: shown greyed out on the
 * packs that will include them, not built yet.
 */
export interface PackFeature {
  id:          string;
  label:       string;
  minPack:     string;
  comingSoon?: boolean;
}

export const PACK_FEATURES: PackFeature[] = [
  { id: "qc_fix",               label: "Jumia QC rejection alerts and guided fixes", minPack: "standard" },
  { id: "order_alerts",         label: "Order alerts on WhatsApp",                   minPack: "pro", comingSoon: true },
  { id: "shipping_labels",      label: "Shipping labels on WhatsApp",                minPack: "pro", comingSoon: true },
  { id: "fee_calc_whatsapp",    label: "Jumia fee calculator on WhatsApp",           minPack: "pro", comingSoon: true },
  { id: "fee_calc_extension",   label: "Jumia fee calculator on the extension panel", minPack: "pro", comingSoon: true },
  { id: "image_polish_extension", label: "Jumia image polish on the Chrome extension", minPack: "pro", comingSoon: true },
];

/** What a pack includes, in PACK_FEATURES order. */
export function packFeatures(packId: string): PackFeature[] {
  const rank = packRank(packId);
  return PACK_FEATURES.filter((f) => packRank(f.minPack) <= rank);
}

export function getCreditPack(id: string): CreditPack | undefined {
  return CREDIT_PACKS.find((p) => p.id === id);
}

/**
 * Credit amounts of earlier packs (100/280/600 until 2026-09-13, 150/330/650
 * until 2026-09-28, 120/200/400 until 2026-10-01) — kept so a purchase
 * transaction recorded back then still resolves to the nearest pack today
 * instead of showing no "Plan" pill. (100 is today's Starter as well.)
 */
const LEGACY_CREDIT_AMOUNTS: Record<number, string> = {
  280: "standard", 600: "pro",
  150: "starter", 330: "standard", 650: "pro",
  120: "starter", 200: "standard", 400: "pro",
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
 * extension and WhatsApp alike (lib/billing/extension-credits.ts): 10 free
 * WhatsApp listings, or 20 autofills. 20 as of 2026-10-01 (25 from
 * 2026-09-28, 10 before).
 */
export const FREE_SIGNUP_CREDITS = 20;

/** One extension autofill costs this many credits: GHS 0.35. 1 as of 2026-10-01 (1.5 from 2026-09-28, 2.5 before). */
export const LISTING_CREDIT_COST = 1;

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
