/**
 * Extension credit-pack pricing — the "Buy Credits" flow on
 * /extension/dashboard, separate from the classic app's plan tiers
 * (lib/billing/plans.ts). Flat rate: 1 GHS = 1 credit (Kelvin: "50 credits
 * for 50 GHS"), no per-tier discount.
 */

export interface CreditPack {
  id: string;
  credits: number;
  amountGhs: number;
}

export const CREDIT_PACKS: CreditPack[] = [
  { id: "small",  credits: 50,  amountGhs: 50 },
  { id: "medium", credits: 150, amountGhs: 150 },
  { id: "large",  credits: 500, amountGhs: 500 },
];

export function getCreditPack(id: string): CreditPack | undefined {
  return CREDIT_PACKS.find((p) => p.id === id);
}

/** Every sign-up starts with this many free credits (lib/billing/extension-credits.ts). */
export const FREE_SIGNUP_CREDITS = 5;

/** One extension autofill costs this many credits. */
export const LISTING_CREDIT_COST = 2.5;
