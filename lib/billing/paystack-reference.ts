/**
 * Paystack transaction reference encoder + decoder.
 *
 * Why this exists: when we redirect a seller to a Paystack Payment Page,
 * we want to identify them when Paystack calls us back (webhook +
 * verify). The standard mechanism is metadata — we attach
 * `{ user_id, plan }` to the URL as a JSON-encoded `metadata` query
 * param, and Paystack passes it through to the transaction's
 * `metadata` field.
 *
 * BUT: Paystack Payment Pages occasionally drop the metadata field
 * (some configurations strip non-standard URL params, and a few real
 * sellers reported "subscription not activating" symptoms on the
 * subscription→Payment-Pages migration). Belt-and-braces: encode the
 * same data in the transaction REFERENCE, which Paystack guarantees
 * to round-trip verbatim because it's used as the primary key for
 * the transaction on both sides.
 *
 * Reference format:
 *   pw.<userId>.<tier>.<random>
 *
 * Why `.` as separator:
 *   - Paystack references support a-z, A-Z, 0-9, `.`, `-`, `=`, `_`
 *   - Clerk user ids look like `user_2abc...` — they contain `_` but
 *     never `.`, so splitting on `.` cleanly separates the fields
 *   - `-` is also safe but used inside some other refs; `.` is unique
 *     to our scheme
 *
 * Both ends:
 *   /api/paystack/initialize → buildPaystackReference()
 *   /api/paystack/verify     → parsePaystackReference() fallback
 *   /api/paystack/webhook    → parsePaystackReference() fallback
 */

import type { Plan } from "@/lib/billing/plans";

const PREFIX = "pw";
const SEPARATOR = ".";

// Match the paid tiers in plans.ts. Free isn't a valid charge target,
// so it doesn't appear here even though it's a Plan value.
const PARSEABLE_TIERS: Plan[] = ["starter", "pro", "business"];

/**
 * Build a Paystack reference that encodes the user + tier. The
 * `random` suffix prevents collisions on rapid retries.
 *
 * @example
 *   buildPaystackReference("user_2abc123", "starter")
 *     → "pw.user_2abc123.starter.x7k9aq"
 */
export function buildPaystackReference(userId: string, tier: Plan): string {
  // Paystack references allow [a-zA-Z0-9.=_-]. Sanitise the userId to
  // strip any chars outside that set. Clerk's user ids stay intact
  // (they only use alphanumeric + underscore).
  const safeUserId = userId.replace(/[^a-zA-Z0-9_-]/g, "");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${PREFIX}${SEPARATOR}${safeUserId}${SEPARATOR}${tier}${SEPARATOR}${rand}`;
}

/**
 * Parse a Paystack reference back into { userId, tier }. Returns
 * { userId: null, tier: null } if the reference doesn't match our
 * format (e.g. it's a legacy subscription reference, a manual
 * Paystack-dashboard payment, or a corrupt string).
 *
 * Callers should:
 *   1. Read metadata first (`tx.metadata?.user_id`, `tx.metadata?.plan`)
 *   2. Fall back to this parser when metadata is missing
 *   3. If both fail, log + skip the activation (don't write a corrupt row)
 */
export function parsePaystackReference(
  reference: string | null | undefined,
): { userId: string | null; tier: Plan | null } {
  if (!reference) return { userId: null, tier: null };

  const parts = reference.split(SEPARATOR);
  if (parts.length < 4) return { userId: null, tier: null };
  if (parts[0] !== PREFIX) return { userId: null, tier: null };

  const userId = parts[1] && parts[1].length > 0 ? parts[1] : null;
  const rawTier = parts[2] as Plan;
  const tier = PARSEABLE_TIERS.includes(rawTier) ? rawTier : null;

  if (!userId || !tier) return { userId: null, tier: null };
  return { userId, tier };
}
