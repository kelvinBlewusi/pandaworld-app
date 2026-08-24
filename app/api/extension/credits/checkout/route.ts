/**
 * /api/extension/credits/checkout — starts a one-time credit-pack purchase
 * for the extension dashboard's "Buy Credits" modal.
 *
 * Not wired to a real payment provider yet. Kelvin asked for a payment
 * system separate from the classic app's Paystack checkout (app/api/
 * paystack/*) — likely Stripe, per the reference UI ("Secure checkout by
 * Stripe") — but that needs real decisions first: a live Stripe account +
 * API keys, the actual credit-pack pricing/currency, and how a purchased
 * credit interacts with the existing plan-based quota (lib/billing/quota.ts)
 * — a separate top-up balance, or additional headroom on the same counter.
 * Until those are settled this always returns "not configured" rather than
 * silently taking a real card payment against undecided numbers.
 */

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";

export const runtime = "nodejs";

export async function POST() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  return NextResponse.json(
    { error: "Credit purchases aren't connected to a payment provider yet — check back soon." },
    { status: 501 },
  );
}
