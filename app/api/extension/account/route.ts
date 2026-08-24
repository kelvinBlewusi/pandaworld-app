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
import { getOrCreateCreditBalance } from "@/lib/billing/extension-credits";
import { serializeCredits } from "@/lib/billing/credit-packs";
import { getQuotaSummary } from "@/lib/billing/quota";

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

  const [balance, quota] = await Promise.all([
    getOrCreateCreditBalance(authResult.userId),
    getQuotaSummary(authResult.userId),
  ]);

  const credits = serializeCredits(balance);
  return NextResponse.json(
    { plan: quota.plan, credits: credits.value, unlimitedCredits: credits.unlimited },
    { status: 200, headers: CORS },
  );
}
