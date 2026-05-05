import { NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";

// ─── POST /api/paystack/initialize ───────────────────────────────────────────
// Creates a Paystack transaction that subscribes the user to the Pro plan.
// If PAYSTACK_PRO_PLAN_CODE is set → recurring monthly subscription.
// If not set → one-time charge of GHS 50 (still upgrades, no auto-renewal).
// Returns { authorization_url } — redirect the browser there.

export async function POST() {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  const user = await currentUser();
  const email = user?.primaryEmailAddress?.emailAddress;
  if (!email) {
    return NextResponse.json(
      { error: "No email address on account" },
      { status: 400 }
    );
  }

  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    return NextResponse.json(
      { error: "Paystack is not configured. Add PAYSTACK_SECRET_KEY to .env.local." },
      { status: 500 }
    );
  }

  const planCode = process.env.PAYSTACK_PRO_PLAN_CODE;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3002";

  // ── Build transaction payload ─────────────────────────────────────────────
  // GHS 50/month = 5000 pesewas (Paystack uses the smallest currency unit)
  // channels: card + all Ghana mobile money networks (MTN, Vodafone, AirtelTigo)
  const body: Record<string, unknown> = {
    email,
    amount: 5000,
    currency: "GHS",
    channels: ["card", "mobile_money"],
    callback_url: `${appUrl}/settings/billing`,
    metadata: {
      user_id: userId,
      plan: "pro",
      cancel_action: `${appUrl}/settings/billing`,
    },
  };

  if (planCode) {
    // Attach plan code → Paystack auto-creates a recurring subscription
    body.plan = planCode;
  } else {
    // No plan code configured — warn in server logs but proceed as one-time charge
    console.warn(
      "[Paystack] PAYSTACK_PRO_PLAN_CODE is not set. " +
        "Payment will be a one-time charge — no automatic monthly renewal. " +
        "Create a plan at paystack.com/dashboard and set PAYSTACK_PRO_PLAN_CODE."
    );
  }

  const res = await fetch("https://api.paystack.co/transaction/initialize", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!res.ok || !data.data?.authorization_url) {
    console.error("[Paystack] Initialize error:", data);
    return NextResponse.json(
      { error: data.message ?? "Failed to initialise payment. Try again." },
      { status: 500 }
    );
  }

  return NextResponse.json({
    authorization_url: data.data.authorization_url,
    reference: data.data.reference,
    recurring: !!planCode,
  });
}
