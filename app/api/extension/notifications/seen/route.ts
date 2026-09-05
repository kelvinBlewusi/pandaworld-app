/**
 * POST /api/extension/notifications/seen — marks the dashboard notification
 * bell (components/extension/shell.tsx) as viewed right now. Called when
 * the dropdown opens; clears the bell's alert dot and each item's "new"
 * marker on the next render.
 */

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { markNotificationsSeen } from "@/lib/billing/extension-credits";

export const runtime = "nodejs";

export async function POST() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await markNotificationsSeen(userId);
  return NextResponse.json({ success: true });
}
