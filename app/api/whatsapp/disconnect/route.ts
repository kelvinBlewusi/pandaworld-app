import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { disconnectWhatsApp } from "@/lib/whatsapp/link";

// ─── POST /api/whatsapp/disconnect ────────────────────────────────────────────
// Removes the current user's WhatsApp connection. The number simply stops
// resolving to a user afterwards — no revocation needed on Meta's side
// (there's no per-user token to revoke, only the shared bot access token).

export async function POST() {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  await disconnectWhatsApp(userId);
  return NextResponse.json({ ok: true });
}
