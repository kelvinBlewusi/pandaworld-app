import { NextRequest, NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { PLANS, getPaystackPageUrl, type Plan } from "@/lib/billing/plans";
import { buildPaystackReference } from "@/lib/billing/paystack-reference";

// ─── POST /api/paystack/initialize ───────────────────────────────────────────
//
// Builds a Paystack Payment Page URL for the requested tier and returns it
// so the browser can redirect to Paystack's hosted checkout.
//
// Request: POST /api/paystack/initialize?tier=starter|pro|business
//          (or POST body { tier: "starter" } — both supported)
//
// May 2026 — switched from /transaction/initialize (API-driven) to
// Paystack Payment Pages (hosted URLs). Pages are created in Paystack
// Dashboard → Pages and their URLs are stored in env vars:
//   PAYSTACK_STARTER_PAGE_URL  e.g. https://paystack.com/pay/pandaworld-starter
//   PAYSTACK_PRO_PAGE_URL
//   PAYSTACK_BUSINESS_PAGE_URL
//
// We append these query params to the Page URL:
//   - email          — prefills the email field with the Clerk email so the
//                      seller doesn't retype it
//   - metadata       — JSON-encoded { user_id, plan } so the webhook can
//                      attribute the payment back to the right user + tier
//   - reference      — our generated reference for end-to-end correlation
//                      (also encodes user_id + tier so a fallback parse
//                      works even if Paystack drops the metadata field)
//   - redirect_url   — overrides the Page's configured callback so the
//                      seller lands back on /settings/billing on the
//                      current deployment (handles preview vs production
//                      without per-environment Paystack config)
//
// Returns: { authorization_url, reference, tier, amount_ghs }
//   The frontend (settings/billing page.tsx) reads authorization_url and
//   sets window.location.href = url — same shape as before so no UI
//   changes are needed.
//
// On success the seller pays on Paystack → Paystack redirects to
//   {redirect_url}?trxref=<ref>&reference=<ref>
// /settings/billing detects the trxref and calls /api/paystack/verify
// which validates the transaction with Paystack and activates the tier.

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

  // ── Resolve the tier from query string or body ───────────────────────────
  const url = new URL(req.url);
  let tier = url.searchParams.get("tier") as Plan | null;

  if (!tier) {
    try {
      const body = (await req.json().catch(() => ({}))) as { tier?: string };
      if (body.tier) tier = body.tier as Plan;
    } catch { /* no body — fine */ }
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
  const pageUrl = getPaystackPageUrl(tier);
  if (!pageUrl) {
    return NextResponse.json(
      {
        error:
          `Paystack Payment Page not configured for ${plan.name}. ` +
          `Create the page in Paystack Dashboard → Pages and set "${plan.paystack_page_url_env}" in Vercel env to the page URL ` +
          `(e.g. https://paystack.com/pay/pandaworld-${tier}).`,
      },
      { status: 500 }
    );
  }

  // ── Build callback URL ───────────────────────────────────────────────────
  //
  // Override the Page's configured success URL so preview deployments
  // self-redirect instead of bouncing back to the canonical production
  // domain. Three-step fallback:
  //   1. NEXT_PUBLIC_APP_URL — set this for the canonical domain
  //   2. VERCEL_URL — Vercel auto-injects for every deployment
  //   3. localhost — last-resort for unconfigured local dev
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL
      ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3002");

  const reference = buildPaystackReference(userId, tier);

  // ── Append query params to the Payment Page URL ──────────────────────────
  //
  // Paystack Payment Pages accept these as standard query params. URL
  // construction via URLSearchParams handles the encoding so brand names
  // with spaces or special chars in the email don't break the URL.
  const paymentUrl = new URL(pageUrl);
  paymentUrl.searchParams.set("email", email);
  paymentUrl.searchParams.set("reference", reference);
  paymentUrl.searchParams.set("redirect_url", `${appUrl}/settings/billing`);
  // Paystack accepts metadata as JSON-encoded — webhook decodes it
  paymentUrl.searchParams.set(
    "metadata",
    JSON.stringify({
      user_id:       userId,
      plan:          tier,
      cancel_action: `${appUrl}/settings/billing`,
    })
  );

  return NextResponse.json({
    authorization_url: paymentUrl.toString(),
    reference,
    tier,
    amount_ghs:        plan.price_ghs_pesewas / 100,
  });
}
