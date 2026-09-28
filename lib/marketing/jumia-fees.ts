/**
 * Jumia Ghana's pricing formula, for the public calculator and commission
 * pages. Rates come from lib/mock/categories (Jumia VendorHub GH's
 * commission schedule, commission inclusive of VAT).
 */

import { mockCategories, type JumiaCategory } from "@/lib/mock/categories";

export type { JumiaCategory };

/** Every category with a published rate, in the schedule's order. */
export const JUMIA_GH_CATEGORIES: JumiaCategory[] = mockCategories;

/**
 * The price to list at on Jumia so the seller receives `payout` after
 * commission and shipping contribution, rounded up to the pesewa like
 * Vendor Center: (payout + shipping) ÷ (1 − commission).
 */
export function listingPriceFor(payout: number, shipping: number, commissionPct: number): number {
  return Math.ceil(((payout + shipping) / (1 - commissionPct / 100)) * 100) / 100;
}

/** Commission percentages across the schedule, for "from X% to Y%" copy. */
export function commissionRange(): { min: number; max: number } {
  const rates = JUMIA_GH_CATEGORIES.map((c) => c.commissionRate);
  return { min: Math.min(...rates), max: Math.max(...rates) };
}
