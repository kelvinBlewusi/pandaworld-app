import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import {
  type Plan,
  findTierByAmount,
  findTierByPaystackPageSlug,
} from "@/lib/billing/plans";
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

  // Tier resolution — FIVE-step fallback (May 2026 robustness pass):
  //   1. findTierByPaystackPageSlug(tx.paymentpage.slug) — PRIMARY.
  //      The Page slug is stable across price changes. If you bump the
  //      Starter Page price in Paystack from GHS 30 → GHS 35 without
  //      updating price_ghs_pesewas here, this match still wins and
  //      the right tier activates. Slug only changes if you rename
  //      the Page URL in Paystack, which is a deliberate action.
  //   2. findTierByAmount(tx.amount) — fallback when the page slug
  //      can't be resolved (e.g. legacy transactions from before the
  //      slug-match was wired). Brittle to price changes — that's why
  //      it's not first any more.
  //   3. tx.metadata.plan — what we set in /initialize. Often dropped
  //      by Payment Pages but checked in case it survived.
  //   4. parsePaystackReference(tx.reference) — Payment Pages override
  //      our reference with their own (T...), so this rarely fires
  //      for new transactions. Kept for legacy /transaction/initialize.
  //   5. Hard fall back to "pro" and log loudly. Means none of the
  //      above worked — investigate via Vercel logs.
  const slugTier        = findTierByPaystackPageSlug(tx.paymentpage?.slug);
  const amountTier      = findTierByAmount(tx.amount);
  const metadataPlan    = tx.metadata?.plan as string | undefined;
  const referenceParsed = parsePaystackReference(tx.reference);
  const requestedPlan   =
    slugTier ?? amountTier ?? metadataPlan ?? referenceParsed.tier ?? "pro";

  const plan: Plan = VALID_PLANS.includes(requestedPlan as Plan)
    ? (requestedPlan as Plan)
    : "pro";

  // Telemetry: log how the tier was resolved on each successful verify.
  // Helps us notice if the slug-match path is doing its job (it should
  // be the only one used in steady state), or if we've drifted into
  // amount-only / default-fallback territory.
  const resolver =
    slugTier ? `slug match ("${tx.paymentpage?.slug}")`
    : amountTier ? `amount match (${tx.amount} pesewas)`
    : metadataPlan ? "metadata.plan"
    : referenceParsed.tier ? "reference parse"
    : "default fallback (CHECK ME)";
  console.info(
    `[Paystack verify] resolved tier "${plan}" via ${resolver} for user ${userId}, reference ${tx.reference}`,
  );

  // Drift warning: slug + amount disagree means the Paystack price
  // was changed without updating price_ghs_pesewas here. Slug wins
  // (price-change resilience) but we surface the drift so someone
  // notices and reconciles.
  if (slugTier && amountTier && slugTier !== amountTier) {
    console.warn(
      `[Paystack verify] PRICE DRIFT: slug "${tx.paymentpage?.slug}" → tier "${slugTier}" but tx.amount ${tx.amount} → tier "${amountTier}". Update lib/billing/plans.ts price_ghs_pesewas to match the new Paystack price for ${slugTier}.`,
    );
  }
  if (!slugTier && !amountTier && metadataPlan) {
    console.warn(
      `[Paystack verify] neither slug nor amount resolved a tier; falling back to metadata.plan "${metadataPlan}". paymentpage.slug=${tx.paymentpage?.slug}, amount=${tx.amount}`,
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
