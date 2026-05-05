import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { createHmac } from "crypto";

// ─── POST /api/paystack/webhook ───────────────────────────────────────────────
// Paystack calls this URL for all subscription lifecycle events.
// Configure in: Paystack Dashboard → Settings → Webhooks

export async function POST(request: Request) {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    return new NextResponse("Webhook not configured", { status: 500 });
  }

  // ── Verify the request came from Paystack (HMAC SHA-512) ─────────────────
  const signature = request.headers.get("x-paystack-signature");
  const rawBody = await request.text();

  const hash = createHmac("sha512", secretKey)
    .update(rawBody)
    .digest("hex");

  if (hash !== signature) {
    console.warn("[Paystack webhook] Invalid signature — rejected");
    return new NextResponse("Invalid signature", { status: 401 });
  }

  const event = JSON.parse(rawBody);
  const db = createServerClient();

  console.log(`[Paystack webhook] Received: ${event.event}`);

  switch (event.event) {
    // ── Successful charge (initial payment OR monthly renewal) ────────────
    case "charge.success": {
      const tx = event.data;
      const userId = tx.metadata?.user_id as string | undefined;

      if (!userId) {
        console.error(
          "[Paystack webhook] charge.success: missing user_id in metadata",
          { reference: tx.reference, email: tx.customer?.email }
        );
        break;
      }

      const subscriptionCode = tx.subscription?.subscription_code ?? null;
      const emailToken = tx.subscription?.email_token ?? null;
      const customerCode = tx.customer?.customer_code ?? null;

      const periodEnd = new Date();
      periodEnd.setDate(periodEnd.getDate() + 30);

      // Upgrade (or renew) user plan
      const { error: subError } = await db.from("subscriptions").upsert(
        {
          user_id: userId,
          plan: "pro",
          status: "active",
          paystack_customer_code: customerCode,
          paystack_subscription_code: subscriptionCode,
          paystack_email_token: emailToken,
          current_period_end: periodEnd.toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      );

      if (subError) {
        console.error(
          "[Paystack webhook] Failed to save subscription for user",
          userId,
          subError
        );
      }

      // Record in billing history
      const { error: histError } = await db.from("billing_events").insert({
        user_id: userId,
        event_type: "payment_success",
        amount_ghs: tx.amount / 100,
        reference: tx.reference,
        description: "Pro plan — monthly subscription",
      });

      if (histError) {
        console.error(
          "[Paystack webhook] Failed to record billing event for user",
          userId,
          histError
        );
      }

      break;
    }

    // ── Subscription created (Paystack confirms recurring setup) ──────────
    case "subscription.create": {
      const sub = event.data;
      const customerCode = sub.customer?.customer_code as string | undefined;

      if (!customerCode) {
        console.warn("[Paystack webhook] subscription.create: no customer_code");
        break;
      }

      // Find user by customer code saved during charge.success
      const { data: existing, error: findError } = await db
        .from("subscriptions")
        .select("user_id")
        .eq("paystack_customer_code", customerCode)
        .maybeSingle();

      if (findError) {
        console.error(
          "[Paystack webhook] subscription.create: DB lookup error",
          findError
        );
        break;
      }

      if (!existing?.user_id) {
        console.warn(
          "[Paystack webhook] subscription.create: no user found for customer",
          customerCode
        );
        break;
      }

      const { error: updateError } = await db
        .from("subscriptions")
        .update({
          paystack_subscription_code: sub.subscription_code,
          paystack_email_token: sub.email_token,
          plan: "pro",
          status: "active",
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", existing.user_id);

      if (updateError) {
        console.error(
          "[Paystack webhook] subscription.create: update error",
          updateError
        );
      }

      break;
    }

    // ── Subscription cancelled or disabled ────────────────────────────────
    case "subscription.disable":
    case "subscription.not_renew": {
      const sub = event.data;
      const subscriptionCode = sub.subscription_code as string | undefined;

      if (!subscriptionCode) {
        console.warn(`[Paystack webhook] ${event.event}: no subscription_code`);
        break;
      }

      const { data: existing, error: findError } = await db
        .from("subscriptions")
        .select("user_id")
        .eq("paystack_subscription_code", subscriptionCode)
        .maybeSingle();

      if (findError) {
        console.error(
          `[Paystack webhook] ${event.event}: DB lookup error`,
          findError
        );
        break;
      }

      if (!existing?.user_id) {
        console.warn(
          `[Paystack webhook] ${event.event}: no user found for subscription`,
          subscriptionCode
        );
        break;
      }

      const { error: updateError } = await db
        .from("subscriptions")
        .update({
          plan: "free",
          status: "cancelled",
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", existing.user_id);

      if (updateError) {
        console.error(
          `[Paystack webhook] ${event.event}: update error`,
          updateError
        );
      }

      break;
    }

    default:
      console.log(`[Paystack webhook] Unhandled event: ${event.event} — ignored`);
      break;
  }

  // Always return 200 so Paystack doesn't retry
  return NextResponse.json({ received: true });
}
