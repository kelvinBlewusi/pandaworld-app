/**
 * /api/donations/checkout — starts a one-time, free-form-amount donation
 * from the extension dashboard / marketing page's "Donate" modal
 * (components/extension/donate-modal.tsx).
 *
 * Stands in for app/api/extension/credits/checkout while billing is off
 * (lib/billing/mode.ts). A donation grants nothing back — see
 * lib/billing/donations.ts.
 */

import { NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { randomBytes } from "node:crypto";
import { MIN_DONATION_GHS, MAX_DONATION_GHS } from "@/lib/billing/donation-limits";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Same guard the credit checkout uses — a donation initialize call is
  // cheap, but an unbounded loop here can still spam a seller's own
  // Paystack account with pending transactions.
  const limited = checkRateLimit(`donation-checkout:${userId}`, RATE_LIMITS.extensionCheckout);
  if (limited) return limited;

  const user = await currentUser();
  const email = user?.primaryEmailAddress?.emailAddress;
  if (!email) {
    return NextResponse.json({ error: "No email address on account" }, { status: 400 });
  }

  let amountGhs: number;
  try {
    const body = (await req.json()) as { amountGhs?: number };
    amountGhs = Number(body.amountGhs);
  } catch {
    return NextResponse.json({ error: "Missing donation amount" }, { status: 400 });
  }

  if (!Number.isFinite(amountGhs) || amountGhs < MIN_DONATION_GHS || amountGhs > MAX_DONATION_GHS) {
    return NextResponse.json(
      { error: `Enter an amount between GHS ${MIN_DONATION_GHS} and GHS ${MAX_DONATION_GHS}.` },
      { status: 400 },
    );
  }

  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    return NextResponse.json(
      { error: "Payments aren't configured yet — set PAYSTACK_SECRET_KEY in Vercel." },
      { status: 500 },
    );
  }

  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL
      ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3002");

  const reference = `pwdn_${randomBytes(8).toString("hex")}`;

  const res = await fetch("https://api.paystack.co/transaction/initialize", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      amount: Math.round(amountGhs * 100), // pesewas
      currency: "GHS",
      reference,
      callback_url: `${appUrl}/extension/dashboard?donation_ref=${reference}`,
      metadata: {
        type: "donation",
        user_id: userId,
        amount_ghs: amountGhs,
      },
    }),
  });

  const data = await res.json();
  if (!res.ok || !data.status) {
    console.error("[donations checkout] Paystack initialize failed:", data);
    return NextResponse.json(
      { error: data?.message || "Could not start checkout." },
      { status: 502 },
    );
  }

  return NextResponse.json({ url: data.data.authorization_url, reference });
}
