/**
 * /api/extension/credits/checkout — starts a one-time credit-pack purchase
 * for the extension dashboard's "Buy Credits" modal.
 *
 * Separate FLOW from the classic app's plan-subscription checkout
 * (app/api/paystack/initialize, which uses pre-created Paystack Payment
 * Pages) — same Paystack account/secret key, but this uses the
 * transaction/initialize API directly since credit packs are one-time
 * charges with a fixed small set of amounts, not recurring subscriptions.
 * Paystack reliably passes metadata through on this API-driven flow (the
 * dropped-metadata issue noted in lib/billing/paystack-reference.ts is
 * specific to Payment Pages), so no reference-encoding fallback is needed
 * here — the webhook and /verify both read tx.metadata directly.
 */

import { NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { randomBytes } from "node:crypto";
import { getCreditPack } from "@/lib/billing/credit-packs";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await currentUser();
  const email = user?.primaryEmailAddress?.emailAddress;
  if (!email) {
    return NextResponse.json({ error: "No email address on account" }, { status: 400 });
  }

  let packId: string | undefined;
  try {
    const body = (await req.json()) as { tier?: string };
    packId = body.tier;
  } catch {
    return NextResponse.json({ error: "Missing credit pack" }, { status: 400 });
  }

  const pack = getCreditPack(packId ?? "");
  if (!pack) {
    return NextResponse.json({ error: "Unknown credit pack" }, { status: 400 });
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

  const reference = `pwcr_${randomBytes(8).toString("hex")}`;

  const res = await fetch("https://api.paystack.co/transaction/initialize", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      amount: pack.amountGhs * 100, // pesewas
      currency: "GHS",
      reference,
      callback_url: `${appUrl}/extension/dashboard?credits_ref=${reference}`,
      metadata: {
        type: "extension_credits",
        user_id: userId,
        credits: pack.credits,
        pack: pack.id,
      },
    }),
  });

  const data = await res.json();
  if (!res.ok || !data.status) {
    console.error("[extension credits checkout] Paystack initialize failed:", data);
    return NextResponse.json(
      { error: data?.message || "Could not start checkout." },
      { status: 502 },
    );
  }

  return NextResponse.json({ url: data.data.authorization_url, reference });
}
