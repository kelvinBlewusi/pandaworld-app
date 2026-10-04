/**
 * Jumia's lowest allowed price in each country, learned from its own
 * rejections: "The Global Price [3] GHS must be equal or more than [8.81]
 * GHS." Jumia doesn't publish these, and each country's is in its own
 * currency, so the first rejection that names one is the only source.
 * Table jumia_price_minimums (supabase/migrations/2026-10-04_jumia-price-
 * minimums.sql), one row per country, the latest figure Jumia gave.
 *
 * Used to catch a price below it before it goes (pushListingToJumia), to
 * hold a draft priced below it and ask for the price (lib/whatsapp/
 * readiness.ts, lib/whatsapp/intake.ts), and to check a seller's answer
 * before resubmitting. Failures never block anything: without a known
 * minimum, Jumia's own check still applies and its message is relayed.
 *
 * Per country, not per category: the rule names no category, and the only
 * one seen so far (GHS 8.81) reads as a currency conversion of one
 * platform-wide floor. Each row keeps the category it was seen in, should
 * that ever turn out wrong.
 */

import { createServerClient } from "@/lib/supabase/server";
import { priceLimitInRejection } from "@/lib/jumia/rejection-remedy";
import { sellerCountry } from "@/lib/jumia/unlistable-categories";

export interface PriceMinimum {
  min:      number;
  currency: string | null;
}

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; value: PriceMinimum | null }>();

/** Tests only: forget what's been read. */
export function _resetPriceMinimumCache(): void {
  cache.clear();
}

/** The minimum Jumia has named for this country, or null if none yet. */
export async function priceMinimumFor(country: string | null | undefined): Promise<PriceMinimum | null> {
  if (!country) return null;
  const hit = cache.get(country);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  try {
    const { data, error } = await createServerClient()
      .from("jumia_price_minimums")
      .select("min_price, currency")
      .eq("country", country)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const value = data ? { min: Number(data.min_price), currency: (data.currency as string | null) ?? null } : null;
    cache.set(country, { at: Date.now(), value });
    return value;
  } catch (e) {
    console.warn(`[price-minimums] couldn't read ${country}'s minimum: ${(e as Error).message}`);
    return null;
  }
}

/** The minimum for the country this seller's Jumia shop is in. */
export async function priceMinimumForUser(userId: string | null | undefined): Promise<PriceMinimum | null> {
  if (!userId) return null;
  return priceMinimumFor(await sellerCountry(userId));
}

/** Save the minimum a rejection named. Best-effort: runs inside outcome logging, which must not fail a push. */
export async function rememberPriceMinimum(
  country:      string | null | undefined,
  categoryCode: number | null,
  rawError:     string | null | undefined,
): Promise<void> {
  const limit = priceLimitInRejection(rawError);
  if (!country || !limit || limit.bound !== "min" || !(limit.limit > 0)) return;
  const value = { min: limit.limit, currency: limit.currency };
  cache.set(country, { at: Date.now(), value });
  try {
    const { error } = await createServerClient().from("jumia_price_minimums").upsert(
      {
        country,
        currency:      limit.currency,
        min_price:     limit.limit,
        category_code: categoryCode,
        last_error:    rawError?.slice(0, 500) ?? null,
        last_seen_at:  new Date().toISOString(),
      },
      { onConflict: "country" },
    );
    if (error) throw new Error(error.message);
    console.info(`[price-minimums] ${country}: Jumia's lowest allowed price is ${money(limit.limit, limit.currency)}`);
  } catch (e) {
    console.warn(`[price-minimums] couldn't save ${country}'s minimum: ${(e as Error).message}`);
  }
}

/** True when a price is set and is below the minimum. */
export function isBelowMinimum(price: number | string | null | undefined, minimum: PriceMinimum | null): minimum is PriceMinimum {
  const n = Number(price);
  return minimum != null && Number.isFinite(n) && n > 0 && n < minimum.min;
}

/** "GHS 8.81", or just "8.81" when the currency isn't known. */
export function money(amount: number | string, currency: string | null | undefined): string {
  return currency ? `${currency} ${amount}` : String(amount);
}

/** For a Held reason or a question: "the price (GHS 3) is below the lowest Jumia allows (GHS 8.81)". */
export function belowMinimumText(price: number | string, minimum: PriceMinimum): string {
  return `the price (${money(price, minimum.currency)}) is below the lowest Jumia allows (${money(minimum.min, minimum.currency)})`;
}
