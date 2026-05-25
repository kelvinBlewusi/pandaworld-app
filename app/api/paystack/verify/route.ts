import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import { type Plan } from "@/lib/billing/plans";
import { parsePaystackReference } from "@/lib/billing/paystack-reference";

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
    // Diagnostic log — when a real seller hits this, the Vercel log
    // entry has enough info to fix the cause without re-running them
    // through another payment.
    //
    // Reveals the most common failure modes:
    //   - 404 from Paystack → reference doesn't exist in this account
    //     (wrong secret-key mode: live key vs test transaction, or vice
    //     versa)
    //   - 401 from Paystack → secret key invalid / expired
    //   - tx.status = "failed" → MoMo declined, card refused
    //   - tx.status = "abandoned" → user closed the page before paying
    //
    // Secret-key prefix is logged WITHOUT the rest of the key so an
    // ops engineer can confirm the mode without exposing credentials.
    console.error(
      "[Paystack verify] failed", JSON.stringify({
        reference,
        userId,
        paystack_http_status: res.status,
        paystack_message:     data?.message,
        tx_status:            data?.data?.status,
        secret_key_prefix:    secretKey.slice(0, 8),  // "sk_live_" or "sk_test_"
        paystack_body:        data,  // full body for forensic
      }, null, 2)
    );

    // Paystack returns "Transaction reference not found" for both
    // genuinely-missing references AND for mode mismatch (live tx vs
    // test secret key). The latter is by far the most common when
    // a real seller hits this, so we surface a fix-oriented error.
    const isNotFound =
      res.status === 404 ||
      /transaction reference not found/i.test(data?.message ?? "");

    const ourMode = secretKey.startsWith("sk_live_") ? "LIVE" : "TEST";

    return NextResponse.json(
      {
        error: data?.data?.status === "failed"
          ? "Payment failed at Paystack (the card or wallet was declined). Try again."
          : data?.data?.status === "abandoned"
            ? "Payment was abandoned — the Paystack window was closed before completing. Try again."
            : isNotFound
              ? `Paystack cannot find this transaction with your ${ourMode}-mode secret key. The Payment Page that received the payment was probably in the OTHER mode. Fix: in Vercel → Settings → Environment Variables, set PAYSTACK_SECRET_KEY to the secret key from the same mode (Live or Test) as your Paystack Page, then redeploy.`
              : data?.message
                ? `Paystack error: ${data.message}`
                : "Payment not successful",
        status: data?.data?.status,
        paystack_http_status: res.status,
        secret_key_mode: ourMode,
      },
      { status: 400 }
    );
  }

  const tx = data.data;

  // Extract subscription info if Paystack attached one
  const subscriptionCode = tx.subscription?.subscription_code ?? null;
  const emailToken = tx.subscription?.email_token ?? null;
  const customerCode = tx.customer?.customer_code ?? null;

  // Tier resolution — three-tier fallback (May 2026 Payment Pages fix):
  //   1. Read from tx.metadata.plan — the canonical source set by /initialize
  //   2. If missing, parse from tx.reference (format: pw.<userId>.<tier>.<rand>)
  //      Paystack Payment Pages occasionally drop the metadata URL param,
  //      but the reference itself round-trips verbatim, so encoding the
  //      tier in the reference too gives us a working fallback.
  //   3. Fall back to "pro" if both fail. Webhook is authoritative; verify
  //      is just the fast-path so the UI doesn't wait for the webhook
  //      round-trip before showing "you're upgraded".
  const metadataPlan = tx.metadata?.plan as string | undefined;
  const referenceParsed = parsePaystackReference(tx.reference);
  const requestedPlan = metadataPlan ?? referenceParsed.tier ?? "pro";
  const plan: Plan = VALID_PLANS.includes(requestedPlan as Plan)
    ? (requestedPlan as Plan)
    : "pro";

  if (!metadataPlan && referenceParsed.tier) {
    console.warn(
      `[Paystack verify] metadata.plan missing; recovered tier "${referenceParsed.tier}" from reference "${tx.reference}".`,
    );
  }

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
