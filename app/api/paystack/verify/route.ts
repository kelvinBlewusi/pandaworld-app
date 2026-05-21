import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import { type Plan } from "@/lib/billing/plans";

const VALID_PLANS: Plan[] = ["starter", "pro", "business"];

// ─── GET /api/paystack/verify?reference=xxx ───────────────────────────────────
// Called after Paystack redirects back to the billing page.
// Verifies the transaction with Paystack, then upgrades the user's plan.

export async function GET(request: Request) {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  const { searchParams } = new URL(request.url);
  const reference = searchParams.get("reference");

  if (!reference) {
    return NextResponse.json({ error: "Missing reference" }, { status: 400 });
  }

  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    return NextResponse.json(
      { error: "Paystack not configured" },
      { status: 500 }
    );
  }

  // Verify with Paystack
  const res = await fetch(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
    {
      headers: { Authorization: `Bearer ${secretKey}` },
    }
  );

  const data = await res.json();

  if (!res.ok || data.data?.status !== "success") {
    return NextResponse.json(
      { error: "Payment not successful", status: data.data?.status },
      { status: 400 }
    );
  }

  const tx = data.data;

  // Extract subscription info if Paystack attached one
  const subscriptionCode = tx.subscription?.subscription_code ?? null;
  const emailToken = tx.subscription?.email_token ?? null;
  const customerCode = tx.customer?.customer_code ?? null;

  // Tier comes from the metadata we attached during initialize.
  // Default to "pro" so callers that never set metadata still upgrade
  // sensibly (matches old behaviour). Webhook is authoritative — verify
  // is just the fast-path so the UI doesn't have to wait for the
  // webhook round-trip before showing "you're upgraded".
  const requestedPlan = (tx.metadata?.plan as string | undefined) ?? "pro";
  const plan: Plan = VALID_PLANS.includes(requestedPlan as Plan)
    ? (requestedPlan as Plan)
    : "pro";

  // Calculate period end (30 days from now)
  const periodEnd = new Date();
  periodEnd.setDate(periodEnd.getDate() + 30);

  // Upsert subscription record. Reset the quota window since this is
  // a fresh billing period.
  const db = createServerClient();
  const { error } = await db.from("subscriptions").upsert(
    {
      user_id: userId,
      plan,
      status: "active",
      paystack_customer_code: customerCode,
      paystack_subscription_code: subscriptionCode,
      paystack_email_token: emailToken,
      current_period_end: periodEnd.toISOString(),
      period_start: new Date().toISOString(),
      listings_used_this_period: 0,
      polishes_used_this_period: 0,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );

  if (error) {
    console.error("Subscription upsert error:", error);
    return NextResponse.json(
      { error: "Failed to save subscription" },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true, plan });
}
