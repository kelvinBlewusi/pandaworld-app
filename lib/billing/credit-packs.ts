/**
 * Extension credit-pack pricing — the "Buy Credits" flow on
 * /extension/dashboard, separate from the classic app's plan tiers
 * (lib/billing/plans.ts).
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
 * Reverse lookup by credit count — each pack has a distinct `credits`
 * value, so a purchase transaction's `amount` (see extension_credit_
 * transactions) identifies which pack was bought without needing its own
 * stored pack id. Used to show the dashboard's "Plan" pill for extension
 * sellers who never subscribed to a classic-app plan tier (lib/billing/
 * extension-credits.ts's getMostRecentCreditPack()).
 */
/**
 * Credit amounts from before the 2026-09-13 price increase (100/280/600 ->
 * 150/330/650, same GHS price each) — kept so a purchase transaction
 * recorded before that change still resolves to its pack instead of
 * showing no "Plan" pill at all.
 */
const LEGACY_CREDIT_AMOUNTS: Record<number, string> = { 100: "starter", 280: "small", 600: "medium" };

export function getCreditPackByCredits(credits: number): CreditPack | undefined {
  return (
    CREDIT_PACKS.find((p) => p.credits === credits) ??
    CREDIT_PACKS.find((p) => p.id === LEGACY_CREDIT_AMOUNTS[credits])
  );
}

/** Every sign-up starts with this many free credits (lib/billing/extension-credits.ts). */
export const FREE_SIGNUP_CREDITS = 10;

/** One extension autofill costs this many credits. */
export const LISTING_CREDIT_COST = 2.5;

/**
 * One WhatsApp product draft (a single runAutoAnalyze pass) costs this
 * many credits — priced higher than an extension autofill (2.5) because
 * it runs the full listing pipeline (describe + category pick + attribute
 * fill, up to 3-6 Gemini calls) rather than one single vision call.
 * Deducted only after a successful draft, same rule LISTING_CREDIT_COST
 * follows — see deductCredits()'s call site in
 * app/api/extension/fill/route.ts and its WhatsApp counterpart in
 * lib/whatsapp/intake.ts's startBatchAnalysis().
 */
export const WHATSAPP_DRAFT_CREDIT_COST = 3;

/**
 * Prepares a balance for a JSON API response (app/api/extension/account,
 * app/api/extension/fill) — `JSON.stringify(Infinity)` silently becomes
 * `null`, which the extension panel can't tell apart from "unknown". This
 * makes the unlimited case (admin accounts — see
 * lib/billing/extension-credits.ts) explicit instead.
 */
export function serializeCredits(balance: number): { value: number | null; unlimited: boolean } {
  if (!Number.isFinite(balance)) return { value: null, unlimited: true };
  return { value: balance, unlimited: false };
}
