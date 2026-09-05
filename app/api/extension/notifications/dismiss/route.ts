/**
 * POST /api/extension/notifications/dismiss — hides one notification from
 * the dashboard bell dropdown (components/extension/shell.tsx) for good,
 * via its "x" button. The underlying extension_credit_transactions row is
 * kept (it's still part of the credit balance's audit trail) — this only
 * sets dismissed_at so getRecentTransactions() stops returning it.
 */

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { dismissNotification } from "@/lib/billing/extension-credits";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let id: string | undefined;
  try {
    const body = (await req.json()) as { id?: string };
    id = body.id;
  } catch {
    return NextResponse.json({ error: "Missing notification id" }, { status: 400 });
  }
  if (!id) return NextResponse.json({ error: "Missing notification id" }, { status: 400 });

  await dismissNotification(userId, id);
  return NextResponse.json({ success: true });
}
