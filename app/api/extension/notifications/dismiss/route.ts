/**
 * POST /api/extension/notifications/dismiss — hides one notification from
 * the dashboard bell dropdown (components/extension/shell.tsx) for good,
 * via its "x" button. The underlying extension_credit_transactions row is
 * kept (it's still part of the credit balance's audit trail) — this only
 * sets dismissed_at so getRecentTransactions() stops returning it. With
 * `kind: "notice"` it hides a message from us instead (lib/notices.ts).
 */

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { dismissNotification } from "@/lib/billing/extension-credits";
import { dismissUserNotice } from "@/lib/notices";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { userId, actor } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let id: string | undefined;
  let kind: string | undefined;
  try {
    const body = (await req.json()) as { id?: string; kind?: string };
    id = body.id;
    kind = body.kind;
  } catch {
    return NextResponse.json({ error: "Missing notification id" }, { status: 400 });
  }
  if (!id) return NextResponse.json({ error: "Missing notification id" }, { status: 400 });

  if (kind === "notice") {
    // Someone signed in AS the seller (the owner, from the Clerk dashboard's
    // Impersonate user) must not use up a message meant for the seller: it
    // was dismissed that way on 2026-10-06 before he had seen it. `actor`
    // is only set for an impersonated session.
    if (!actor) await dismissUserNotice(userId, id);
  } else {
    await dismissNotification(userId, id);
  }
  return NextResponse.json({ success: true });
}
