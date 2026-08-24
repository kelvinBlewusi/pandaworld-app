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
  { id: "small",  credits: 130, amountGhs: 100 },
  { id: "medium", credits: 200, amountGhs: 150 },
];

export function getCreditPack(id: string): CreditPack | undefined {
  return CREDIT_PACKS.find((p) => p.id === id);
}

/** Every sign-up starts with this many free credits (lib/billing/extension-credits.ts). */
export const FREE_SIGNUP_CREDITS = 5;

/** One extension autofill costs this many credits. */
export const LISTING_CREDIT_COST = 2.5;
