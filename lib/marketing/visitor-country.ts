/**
 * Which Jumia country a visitor sells in, for sending them to the right
 * price calculator. Server only: it reads the seller's Jumia connection
 * and the request's headers.
 */

import { headers } from "next/headers";
import { sellerCountry } from "@/lib/jumia/unlistable-categories";
import { jumiaCountryByCode, type JumiaCountry } from "@/lib/marketing/countries";

/**
 * The seller's own connection decides when they have one. Otherwise the
 * country Vercel locates the request in (x-vercel-ip-country), so a
 * logged-out visitor in Lagos lands on Nigeria. Undefined when neither is
 * a Jumia country.
 */
export async function visitorJumiaCountry(userId: string | null | undefined): Promise<JumiaCountry | undefined> {
  if (userId) {
    const own = jumiaCountryByCode(await sellerCountry(userId).catch(() => null));
    if (own) return own;
  }
  return jumiaCountryByCode(headers().get("x-vercel-ip-country"));
}
