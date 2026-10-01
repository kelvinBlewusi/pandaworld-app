import { createHmac, timingSafeEqual } from "node:crypto";
import { getCreditPack } from "@/lib/billing/credit-packs";

/** The parts of a Paystack transaction a credit-pack purchase reads. */
export interface PaystackTransaction {
  amount?:   number;  // pesewas
  currency?: string;
  metadata?: { type?: string; user_id?: string; credits?: unknown; pack?: unknown } | null;
}

/**
 * How many credits a successful Paystack charge buys, checked against the
 * money actually paid.
 *
 * The metadata normally comes from our own transaction/initialize call
 * (app/api/extension/credits/checkout), but Paystack also accepts a
 * transaction a browser starts with the account's public key, amount and
 * metadata included. So a charge only counts when it was paid in GHS and
 * at least the price of the pack it names, and it never buys more credits
 * than that pack holds. A pack repriced between checkout and payment can
 * fail this; the error says so and an admin can credit it by hand.
 */
export function creditsPaidFor(tx: PaystackTransaction): { ok: true; credits: number; packId: string } | { ok: false; error: string } {
  const pack = getCreditPack(String(tx.metadata?.pack ?? ""));
  const credits = Number(tx.metadata?.credits) || 0;
  if (!pack || credits <= 0) return { ok: false, error: `unknown pack "${String(tx.metadata?.pack)}" or credits "${String(tx.metadata?.credits)}"` };
  if (tx.currency !== "GHS") return { ok: false, error: `paid in ${tx.currency ?? "no currency"}, not GHS` };
  const paid = Number(tx.amount) || 0;
  if (paid < pack.amountGhs * 100) return { ok: false, error: `paid GHS ${paid / 100}, the ${pack.id} pack costs GHS ${pack.amountGhs}` };
  if (credits > pack.credits) return { ok: false, error: `asks for ${credits} credits, the ${pack.id} pack holds ${pack.credits}` };
  return { ok: true, credits, packId: pack.id };
}

/** Paystack's x-paystack-signature: HMAC-SHA512 of the raw body, keyed with the secret key. */
export function verifyPaystackSignature(rawBody: string, signature: string | null, secretKey: string): boolean {
  if (!signature) return false;
  const expected = Buffer.from(createHmac("sha512", secretKey).update(rawBody).digest("hex"), "hex");
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
