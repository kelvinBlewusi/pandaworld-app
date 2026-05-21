import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { createHmac } from "crypto";
import { clerkClient } from "@clerk/nextjs/server";
import { sendEmail } from "@/lib/email/send";
import { paymentConfirmationEmail } from "@/lib/email/templates";
import { PLANS, type Plan } from "@/lib/billing/plans";

// Valid tier names the webhook is allowed to upsert into the plan
// column. We refuse anything else so a malformed metadata field can't
// quietly land an unknown tier in the DB.
const VALID_PLANS: Plan[] = ["starter", "pro", "business"];

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

      // Tier comes from the metadata we attached during /initialize.
      // Fall back to "pro" if missing — legacy Paystack subscriptions
      // (created before the tier param existed) ALL paid GHS 50/mo so
      // their renewals should keep landing on pro. That keeps existing
      // Pro renewals working through the migration window.
      const requestedPlan = (tx.metadata?.plan as string | undefined) ?? "pro";
      const plan: Plan = VALID_PLANS.includes(requestedPlan as Plan)
        ? (requestedPlan as Plan)
        : "pro";

      // Upgrade (or renew) user plan + reset quota counters so the new
      // billing window starts at 0 used. period_start tracks the quota
      // window separately from current_period_end (Paystack's renewal
      // anchor); we sync them here when a payment lands.
      const { error: subError } = await db.from("subscriptions").upsert(
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

      if (subError) {
        console.error(
          "[Paystack webhook] Failed to save subscription for user",
          userId,
          subError
        );
      }

      // Record in billing history
      const planConfig = PLANS[plan];
      const { error: histError } = await db.from("billing_events").insert({
        user_id: userId,
        event_type: "payment_success",
        amount_ghs: tx.amount / 100,
        reference: tx.reference,
        description: `${planConfig.name} plan — monthly subscription`,
      });

      if (histError) {
        console.error(
          "[Paystack webhook] Failed to record billing event for user",
          userId,
          histError
        );
      }

      // Send the payment-confirmation email. Fire-and-forget — if the
      // email fails (Resend down, key missing, address invalid), the
      // user is still on the Pro plan, they just don't get a receipt.
      // We pull the email + first name from Clerk so we don't have to
      // store them in our own DB just for transactional mail.
      try {
        const client = await clerkClient();
        const clerkUser = await client.users.getUser(userId);
        const recipientEmail =
          clerkUser.primaryEmailAddress?.emailAddress ??
          clerkUser.emailAddresses[0]?.emailAddress;
        if (recipientEmail) {
          const appUrl =
            process.env.NEXT_PUBLIC_APP_URL ??
            (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://pandaworld.gh");
          const tpl = paymentConfirmationEmail({
            firstName: clerkUser.firstName,
            amount:    `GHS ${(tx.amount / 100).toFixed(2)}`,
            reference: tx.reference,
            plan:      `${planConfig.name} plan — monthly subscription`,
            appUrl,
          });
          await sendEmail({
            to:       recipientEmail,
            subject:  tpl.subject,
            html:     tpl.html,
            text:     tpl.text,
            category: "payment-confirmation",
          });
        }
      } catch (e) {
        console.warn(`[Paystack webhook] payment-confirmation email skipped: ${(e as Error).message}`);
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

      // Paystack subscription.create lands after charge.success on
      // recurring flows. We DON'T want to overwrite the plan the user
      // actually picked back to "pro" — the charge.success handler
      // already set it from metadata. Just attach the recurring codes.
      const { error: updateError } = await db
        .from("subscriptions")
        .update({
          paystack_subscription_code: sub.subscription_code,
          paystack_email_token: sub.email_token,
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
