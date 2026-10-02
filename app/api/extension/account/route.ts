/**
 * GET /api/extension/account — account status for the extension side panel.
 *
 * API-key-authed (same as /api/extension/fill, NOT a Clerk session — the
 * extension calls this from Jumia's origin). Returns just enough for the
 * panel's status row (plan + credit balance) so it can show "Plan: Free ·
 * 12 credits" without needing a fill request first.
 */

import { NextResponse } from "next/server";
import { authenticateExtensionKey } from "@/lib/security/extension-keys";
import { getOrCreateCreditBalance, getMostRecentCreditPack } from "@/lib/billing/extension-credits";
import { serializeCredits } from "@/lib/billing/credit-packs";
import { isAdmin } from "@/lib/auth/is-admin";
import { hasFeature } from "@/lib/billing/features";
import { visitorJumiaCountry } from "@/lib/marketing/visitor-country";

export const runtime = "nodejs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(req: Request) {
  const authResult = await authenticateExtensionKey(req.headers.get("authorization"));
  if (!authResult.ok) {
    return NextResponse.json({ error: authResult.error }, { status: 401, headers: CORS });
  }

  const userId = authResult.userId;
  const [balance, recentPack, imagePolish, feeCalculator, country] = await Promise.all([
    getOrCreateCreditBalance(userId),
    getMostRecentCreditPack(userId),
    hasFeature(userId, "image_polish_extension"),
    hasFeature(userId, "fee_calc_extension"),
    // The seller's Jumia connection, else where this request comes from:
    // the panel's calculator is for this one country only.
    visitorJumiaCountry(userId).catch(() => undefined),
  ]);

  // Same as the dashboard's Plan pill (app/extension/(app)/layout.tsx): the
  // pack the seller last bought, or "free". Kept as `plan` because the
  // published extension panel reads that field.
  const plan = recentPack?.id ?? "free";

  const credits = serializeCredits(balance);
  return NextResponse.json(
    {
      plan,
      credits:          credits.value,
      unlimitedCredits: credits.unlimited,
      // The panel's pack tools (Pro and up, lib/billing/features.ts). Panels
      // before 0.2.53 show Polish images from isAdmin instead.
      features:         { imagePolish, feeCalculator },
      country:          { code: country?.code ?? "GH", name: country?.name ?? "Ghana" },
      isAdmin:          isAdmin(userId),
    },
    { status: 200, headers: CORS },
  );
}
