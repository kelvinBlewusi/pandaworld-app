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
  { id: "starter", credits: 50,  amountGhs: 50 },
  { id: "small",   credits: 130, amountGhs: 100 },
  { id: "medium",  credits: 200, amountGhs: 150 },
];

/** Pack id shown with the "Popular" badge in the Buy Credits modal. */
export const POPULAR_PACK_ID = "small";

export function getCreditPack(id: string): CreditPack | undefined {
  return CREDIT_PACKS.find((p) => p.id === id);
}

/** Every sign-up starts with this many free credits (lib/billing/extension-credits.ts). */
export const FREE_SIGNUP_CREDITS = 5;

/** One extension autofill costs this many credits. */
export const LISTING_CREDIT_COST = 2.5;

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
