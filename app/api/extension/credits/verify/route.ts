/**
 * GET /api/extension/credits/verify?reference=xxx
 *
 * Called by components/extension/credits-purchase-handler.tsx when Paystack
 * redirects back to /extension/dashboard?credits_ref=... after checkout.
 * Verifies the transaction with Paystack, then credits the ledger.
 *
 * This is the fast/immediate path for the UI; app/api/paystack/webhook's
 * "extension_credits" branch is the durable path (covers a seller closing
 * the tab before the redirect completes). Both call the same
 * creditPurchase(), which is idempotent on `reference`, so whichever fires
 * first wins and the other is a safe no-op.
 */

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { creditPurchase } from "@/lib/billing/extension-credits";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const reference = searchParams.get("reference");
  if (!reference) {
    return NextResponse.json({ error: "Missing reference" }, { status: 400 });
  }

  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    return NextResponse.json({ error: "Payments not configured" }, { status: 500 });
  }

  const res = await fetch(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
    { headers: { Authorization: `Bearer ${secretKey}` } },
  );
  const data = await res.json();

  if (!res.ok || data.data?.status !== "success") {
    return NextResponse.json(
      { error: data?.message || "Payment not successful", status: data?.data?.status },
      { status: 400 },
    );
  }

  const tx = data.data;
  if (tx.metadata?.type !== "extension_credits" || tx.metadata?.user_id !== userId) {
    return NextResponse.json({ error: "Reference does not match this purchase" }, { status: 400 });
  }

  const credits = Number(tx.metadata?.credits) || 0;
  if (credits <= 0) {
    return NextResponse.json({ error: "Invalid credit amount on transaction" }, { status: 400 });
  }

  const result = await creditPurchase({
    userId,
    credits,
    reference,
    description: `Purchased ${credits} credits (${tx.metadata?.pack ?? "custom"} pack)`,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }
  return NextResponse.json({ success: true, balance: result.balance, credited: credits });
}
