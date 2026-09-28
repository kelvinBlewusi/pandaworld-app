"use server";

/**
 * Donation ledger — the "Donate" flow that temporarily stands in for
 * paid credit-pack purchases (components/extension/donate-modal.tsx)
 * while billing is off (lib/billing/mode.ts). A
 * donation grants nothing back (no credits, no plan change) — it's
 * just goodwill support money, recorded for our own accounting.
 */

import { createServerClient } from "@/lib/supabase/server";

/**
 * Record a successful donation. Idempotent on `reference` (unique
 * constraint) — the webhook can safely fire more than once for the
 * same Paystack transaction (retries, or a future /verify call landing
 * around the same time) without double-counting.
 */
export async function recordDonation(args: {
  userId: string;
  amountGhs: number;
  reference: string;
}): Promise<{ ok: true; alreadyProcessed?: boolean } | { ok: false; error: string }> {
  const db = createServerClient();

  const { error } = await db.from("donations").insert({
    user_id:    args.userId,
    amount_ghs: args.amountGhs,
    reference:  args.reference,
  });

  if (error) {
    if (error.code === "23505") return { ok: true, alreadyProcessed: true };
    console.error("[donations] recordDonation failed:", error.message);
    return { ok: false, error: error.message };
  }

  return { ok: true };
}
