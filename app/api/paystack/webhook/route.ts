import { NextResponse } from "next/server";
import { creditPurchase } from "@/lib/billing/extension-credits";
import { recordDonation } from "@/lib/billing/donations";
import { creditsPaidFor, verifyPaystackSignature } from "@/lib/billing/paystack-purchase";
import { logAppError } from "@/lib/observability/errors";

// ─── POST /api/paystack/webhook ───────────────────────────────────────────────
// Paystack calls this URL for every event on the account. Two kinds of
// charge are ours: credit packs (app/api/extension/credits/checkout) and
// donations (app/api/donations/checkout). The monthly plan subscriptions
// this also used to handle were removed 2026-09-28.
// Configure in: Paystack Dashboard → Settings → Webhooks

export async function POST(request: Request) {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    return new NextResponse("Webhook not configured", { status: 500 });
  }

  // ── Verify the request came from Paystack (HMAC SHA-512) ─────────────────
  const rawBody = await request.text();

  if (!verifyPaystackSignature(rawBody, request.headers.get("x-paystack-signature"), secretKey)) {
    console.warn("[Paystack webhook] Invalid signature — rejected");
    return new NextResponse("Invalid signature", { status: 401 });
  }

  const event = JSON.parse(rawBody);

  console.log(`[Paystack webhook] Received: ${event.event}`);

  switch (event.event) {
    case "charge.success": {
      const tx = event.data;

      // ── Donations branch off first ──────────────────────────────────────
      // See app/api/donations/checkout/route.ts. Grants nothing back — just
      // a record for our own accounting/thank-you purposes.
      if (tx.metadata?.type === "donation") {
        const donorUserId = tx.metadata?.user_id as string | undefined;
        const amountGhs = Number(tx.metadata?.amount_ghs) || tx.amount / 100;
        if (!donorUserId || amountGhs <= 0) {
          console.error(
            "[Paystack webhook] donation charge.success missing user_id/amount",
            { reference: tx.reference, metadata: tx.metadata },
          );
          break;
        }
        const result = await recordDonation({ userId: donorUserId, amountGhs, reference: tx.reference });
        if (!result.ok) {
          console.error("[Paystack webhook] donation record failed:", result.error);
        } else {
          console.info(
            `[Paystack webhook] recorded GHS ${amountGhs} donation from ${donorUserId} ` +
              `(reference ${tx.reference})${result.alreadyProcessed ? " — already processed" : ""}`,
          );
        }
        break;
      }

      // ── Credit-pack purchases ───────────────────────────────────────────
      // See app/api/extension/credits/checkout/route.ts. Metadata is
      // reliable here (API-driven transaction/initialize, not a Payment
      // Page).
      if (tx.metadata?.type === "extension_credits") {
        const creditUserId = tx.metadata?.user_id as string | undefined;
        const paidFor = creditsPaidFor(tx);
        if (!creditUserId || !paidFor.ok) {
          // Answered 200: a retry can't change what was paid. Logged for an
          // admin to look at (a repriced pack, or a forged transaction).
          const why = !creditUserId ? "no user_id" : paidFor.ok ? "" : paidFor.error;
          console.error(`[Paystack webhook] extension_credits ${tx.reference} not credited: ${why}`);
          logAppError("paystack-webhook", `credit pack not credited: ${why}`, { reference: tx.reference, metadata: tx.metadata, amount: tx.amount, currency: tx.currency });
          break;
        }
        const credits = paidFor.credits;
        const result = await creditPurchase({
          userId: creditUserId,
          credits,
          reference: tx.reference,
          description: `Purchased ${credits} credits (${paidFor.packId} pack)`,
        });
        if (!result.ok) {
          // A paid pack that didn't land: answer non-2xx so Paystack
          // retries (creditPurchase is idempotent on the reference).
          console.error("[Paystack webhook] extension_credits credit failed:", result.error);
          return new NextResponse("Credit failed, retry", { status: 500 });
        } else {
          console.info(
            `[Paystack webhook] credited ${credits} extension credits to ${creditUserId} ` +
              `(reference ${tx.reference})${result.alreadyProcessed ? " — already processed" : ""}`,
          );
        }
        break;
      }

      console.log(`[Paystack webhook] charge.success ${tx.reference} isn't a credit pack or donation — ignored`);
      break;
    }

    default:
      console.log(`[Paystack webhook] Unhandled event: ${event.event} — ignored`);
      break;
  }

  // 200 for everything handled or ignored, so Paystack doesn't retry it
  return NextResponse.json({ received: true });
}
