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
 * Pricing since 2026-10-07: Starter is 80 credits for GHS 35 (GHS 0.44 a
 * credit; it was 100), the other packs as set 2026-10-01 (GHS 0.30 to 0.33
 * a credit). A live WhatsApp / web listing and an extension autofill are 2
 * credits each (3 and 5 in Nigeria and Morocco, COUNTRY_LISTING_CREDIT_COST):
 * GHS 0.88 on Starter, about GHS 0.60 on Business. An AI image is 4
 * credits. Launch pricing, 2026-10-01: 1 credit = GHS 0.35 at the Starter
 * price, a listing GHS 0.70, an autofill (1 credit) GHS 0.35. Costs it was set against
 * (per live WhatsApp listing, measured): AI drafting ~GHS 0.05, WhatsApp
 * messages ~GHS 0.18 (Meta charges per bot message from 2026-10-01),
 * Paystack 1.95%; plus ~GHS 530 a month fixed (Vercel Pro, Supabase Pro).
 * Break-even is about 1,200 listings a month.
 *
 * Was GHS 0.25 a credit in every pack (120 / 200 / 400 credits for GHS
 * 30 / 50 / 100), 2026-09-28 to 2026-10-01.
 */
export const CREDIT_PACKS: CreditPack[] = [
  // 80 credits for GHS 35 from 2026-10-07 (owner: "reduce the 100 credits to 80 for same price").
  { id: "starter",  credits: 80,  amountGhs: 35 },
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
 * feature while the last pack they bought is that pack or a bigger one,
 * and only while they have credits (lib/billing/features.ts; the owner
 * set "highest pack ever" on 2026-10-01 and changed it to this on
 * 2026-10-06).
 *
 * `comingSoon` features are not built yet. They are listed with the packs
 * like the others (owner's call, 2026-10-03; they were greyed out before),
 * so the pricing FAQ and the Terms name them as not available yet
 * (comingSoonLabels).
 *
 * `minPack: EVERYONE`: on every plan, free sign-up credits included, and
 * charged per use like the rest (owner, 2026-10-07: "make all the
 * capabilities available to all plans in the chat and charge credits for
 * those we charge ... except the label and the alert on WhatsApp"). They
 * still pause at 0 credits. Not listed as a pack's own (packFeatures).
 */
export interface PackFeature {
  id:          string;
  label:       string;
  /** For tight spaces such as the Buy credits modal's pack rows. */
  short:       string;
  minPack:     string;
  comingSoon?: boolean;
}

export const EVERYONE = "everyone";

export const PACK_FEATURES: PackFeature[] = [
  { id: "qc_fix",                 label: "Jumia QC rejection alerts and guided fixes",  short: "QC alerts & fixes",          minPack: EVERYONE },
  // The alerts the bot sends on its own: new orders, order updates, payouts.
  { id: "order_alerts",           label: "Order and payout alerts on WhatsApp",         short: "Order & payout alerts",      minPack: "pro", comingSoon: true },
  // Standard from 2026-10-07, since each label is charged (owner: "the label download to WhatsApp should be added to the GHS 70 pack").
  { id: "shipping_labels",        label: "Shipping labels on WhatsApp",                 short: "Shipping labels",            minPack: "standard", comingSoon: true },
  // In the chat (WhatsApp and the Jumia Listing Assistant): products, orders
  // (packing, ready to ship, cancelling), reports, payouts, the warehouse.
  { id: "shop_whatsapp",          label: "Your live Jumia shop in chat: products, orders, reports and payouts", short: "Shop in chat", minPack: EVERYONE, comingSoon: true },
  { id: "fee_calc_whatsapp",      label: "Jumia fee calculator in chat",                short: "Fee calculator in chat",     minPack: EVERYONE, comingSoon: true },
  { id: "fee_calc_extension",     label: "Jumia fee calculator on the extension panel", short: "Fee calculator in the extension", minPack: "pro" },
  { id: "image_polish_extension", label: "Jumia image polish on the Chrome extension",  short: "Image polish in the extension",   minPack: "pro" },
];

/** The pack features not built yet, by label, for the pages that must say so. */
export function comingSoonLabels(): string[] {
  return PACK_FEATURES.filter((f) => f.comingSoon).map((f) => f.label);
}

/** What a pack includes, in PACK_FEATURES order (what every plan has is everyoneFeatures). */
export function packFeatures(packId: string): PackFeature[] {
  const rank = packRank(packId);
  return PACK_FEATURES.filter((f) => f.minPack !== EVERYONE && packRank(f.minPack) <= rank);
}

/** What every plan has, free sign-up credits included. */
export function everyoneFeatures(): PackFeature[] {
  return PACK_FEATURES.filter((f) => f.minPack === EVERYONE);
}

export function getCreditPack(id: string): CreditPack | undefined {
  return CREDIT_PACKS.find((p) => p.id === id);
}

/**
 * Credit amounts of earlier packs (100/280/600 until 2026-09-13, 150/330/650
 * until 2026-09-28, 120/200/400 until 2026-10-01, Starter 100 until
 * 2026-10-07) — kept so a purchase
 * transaction recorded back then still resolves to the nearest pack today
 * instead of showing no "Plan" pill. (100 is today's Starter as well.)
 */
const LEGACY_CREDIT_AMOUNTS: Record<number, string> = {
  100: "starter",
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
 * extension and WhatsApp alike (lib/billing/extension-credits.ts): 6 free
 * listings either way. 12 for sign-ups from 2026-10-07 (owner: "reduce the
 * free tier to 6 listings, 12 credits, for upcoming sign ups"); balances
 * already given stay. 20 from 2026-10-01, 25 from 2026-09-28, 10 before.
 */
export const FREE_SIGNUP_CREDITS = 12;

/**
 * One extension autofill costs this many credits, the same as a WhatsApp
 * listing. 2 as of 2026-10-07 (owner: "extension fills should also be 2
 * credits"); 1 from 2026-10-01, 1.5 from 2026-09-28, 2.5 before.
 */
export const LISTING_CREDIT_COST = 2;

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
 * Where WhatsApp costs us more per message (Meta's 2026 rates: Nigeria about
 * twice Ghana, Morocco about five times), a live listing costs more there,
 * by the seller's Jumia country. Shown only to sellers connected from that
 * country: public pages show LIVE_LISTING_CREDIT_COST (owner, 2026-10-07).
 */
export const COUNTRY_LISTING_CREDIT_COST: Record<string, number> = { NG: 3, MA: 5 };

/** What a live listing costs a seller in this Jumia country ("GH", "NG"…; unknown is the usual price). */
export function listingCostFor(country: string | null | undefined): number {
  return COUNTRY_LISTING_CREDIT_COST[(country ?? "").trim().toUpperCase()] ?? LIVE_LISTING_CREDIT_COST;
}

/**
 * WhatsApp services charged as they're used (owner, 2026-10-07: "no
 * credits for alerts, but charge credits to get labels, for live changes,
 * and for alerts the bot sends on its own"). New-order alerts and the
 * assistant's replies are free (the assistant has a daily allowance,
 * lib/whatsapp/assistant-limits.ts). Each is charged once per reference
 * (chargeService in lib/billing/extension-credits.ts), never for admins or
 * while billing is off.
 */
/** One order's shipping label sent on WhatsApp; the same label again is free. */
export const LABEL_CREDIT_COST = 0.5;
/** One confirmed change to live Jumia products (one tap, up to 20 products); given back if Jumia refuses it all. */
export const LIVE_CHANGE_CREDIT_COST = 0.5;
/** A message the bot sends on its own, other than a new-order alert: order updates, "Jumia paid you". */
export const NOTICE_CREDIT_COST = 0.2;

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

/** One line of "what costs credits", for the pricing and billing pages. */
export interface CreditCost { what: string; detail: string; credits: number }

/**
 * Everything that costs credits, with this seller's listing price (their
 * country's, listingCostFor; the usual price on public pages).
 */
export function creditCosts(listingCost = LIVE_LISTING_CREDIT_COST): CreditCost[] {
  return [
    { what: "WhatsApp or web listing", detail: "Photos in, a complete listing submitted to Jumia. Charged only when it goes live.", credits: listingCost },
    { what: "Chrome extension autofill", detail: "One product's form filled in on Vendor Center.", credits: LISTING_CREDIT_COST },
    { what: "Shipping label on WhatsApp", detail: "One order's label PDF. The same label again is free.", credits: LABEL_CREDIT_COST },
    { what: "Change to a live Jumia product", detail: "Stock, price, a sale or on/off, confirmed with one tap, for up to 20 products at once. Given back if Jumia refuses it.", credits: LIVE_CHANGE_CREDIT_COST },
    { what: "Order updates and payout messages", detail: "Delivered, returned, failed or cancelled orders, and \"Jumia paid you\". New-order alerts are free.", credits: NOTICE_CREDIT_COST },
  ];
}

/** How far a number of credits goes: whole autofills, or whole live WhatsApp / web listings at `listingCost`. */
export function packReach(credits: number, listingCost = LIVE_LISTING_CREDIT_COST): { autofills: number; listings: number } {
  return {
    autofills: Math.floor(credits / LISTING_CREDIT_COST),
    listings:  Math.floor(credits / listingCost),
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
