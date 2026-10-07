import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { purchaseBlock } from "@/lib/billing/connections";

/**
 * GET /api/extension/credits/eligibility — whether this seller can buy
 * credits now, for the Buy credits modal to check before it shows a Buy
 * button (owner, 2026-10-07: "when users click on Buy credits our
 * conditions should be checked before proceeding"). `missing` names what to
 * connect first: "whatsapp", "jumia". The checkout route checks it again.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const block = await purchaseBlock(userId);
  return NextResponse.json(block ? { ok: false, missing: block.missing, message: block.message } : { ok: true, missing: [] });
}
