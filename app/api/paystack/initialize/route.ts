import { NextRequest, NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { PLANS, getPaystackPlanCode, type Plan } from "@/lib/billing/plans";

// ─── POST /api/paystack/initialize ───────────────────────────────────────────
//
// Creates a Paystack transaction that subscribes the user to a paid tier.
//
// Request: POST /api/paystack/initialize?tier=starter|pro|business
//          (or POST body { tier: "starter" } — both supported)
//
// Behaviour:
//   - Looks up the requested tier in lib/billing/plans.ts.
//   - Reads the matching Paystack plan_code from env (e.g. PAYSTACK_PRO_PLAN_CODE).
//   - If plan_code is set → recurring monthly subscription via Paystack's
//     auto-charge engine.
//   - If plan_code is missing → one-time charge for the tier's price.
//     The user still gets the tier (webhook + verify reconcile), but
//     no auto-renewal. Useful in dev before plans are created.
//
// Refuses to initialise for "free" (nothing to charge).
//
// Returns: { authorization_url, reference, recurring, tier }
// The frontend redirects to authorization_url; user pays on Paystack;
// browser comes back via callback_url (/settings/billing); verify route
// confirms the transaction; webhook makes the plan change durable.

const VALID_PAID_TIERS: Plan[] = ["starter", "pro", "business"];

function isValidPaidTier(value: unknown): value is Plan {
  return typeof value === "string" && VALID_PAID_TIERS.includes(value as Plan);
}

export async function POST(req: NextRequest) {
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

  // ── Resolve the tier from query string or body ───────────────────────────
  //
  // Prefer query string for new code paths; fall back to body for
  // backwards compatibility with the legacy "upgrade to Pro" button
  // that POSTed with no params.
  const url = new URL(req.url);
  let tier = url.searchParams.get("tier") as Plan | null;

  if (!tier) {
    try {
      const body = (await req.json().catch(() => ({}))) as { tier?: string };
      if (body.tier) tier = body.tier as Plan;
    } catch { /* no body — that's fine */ }
  }

  // Default to "pro" so existing clients that POST without a tier param
  // keep working. New tier-aware buttons should always pass ?tier=.
  if (!tier) tier = "pro";

  if (!isValidPaidTier(tier)) {
    return NextResponse.json(
      { error: `Tier "${tier}" cannot be purchased. Valid options: ${VALID_PAID_TIERS.join(", ")}.` },
      { status: 400 }
    );
  }

  const plan = PLANS[tier];
  const planCode = getPaystackPlanCode(tier);

  // App URL for the Paystack callback. Three-step fallback:
  //   1. NEXT_PUBLIC_APP_URL — set this for the canonical domain
  //      (e.g. pandaworld.gh). Recommended for production.
  //   2. VERCEL_URL — Vercel auto-injects this for every deployment
  //      (e.g. pandaworld-app-xyz.vercel.app). Keeps preview deploys
  //      self-redirecting instead of bouncing back to localhost.
  //   3. localhost — last-resort for unconfigured local dev.
  //
  // The previous fallback was localhost only, which meant users on
  // any deployment without NEXT_PUBLIC_APP_URL got redirected to
  // http://localhost:3002 after payment — broken in prod.
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL
      ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3002");

  // ── Build transaction payload ─────────────────────────────────────────────
  // Paystack uses the smallest currency unit, so GHS 30 = 3000 pesewas.
  // channels: card + all Ghana mobile money networks (MTN, Vodafone, AirtelTigo)
  const body: Record<string, unknown> = {
    email,
    amount: plan.price_ghs_pesewas,
    currency: "GHS",
    channels: ["card", "mobile_money"],
    callback_url: `${appUrl}/settings/billing`,
    metadata: {
      user_id: userId,
      plan: tier,                           // webhook reads this to set the right tier
      cancel_action: `${appUrl}/settings/billing`,
    },
  };

  if (planCode) {
    // Attach plan code → Paystack auto-creates a recurring subscription
    body.plan = planCode;
  } else {
    // No plan code configured — warn in server logs but proceed as one-time charge
    console.warn(
      `[Paystack] No plan_code configured for tier "${tier}" ` +
        `(env var "${plan.paystack_plan_code_env}" not set). ` +
        `Payment will be a one-time charge — no automatic monthly renewal. ` +
        `Create a plan at paystack.com/dashboard for ${plan.display_price}/month and set the env var.`
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
    reference:         data.data.reference,
    recurring:         !!planCode,
    tier,
    amount_ghs:        plan.price_ghs_pesewas / 100,
  });
}
