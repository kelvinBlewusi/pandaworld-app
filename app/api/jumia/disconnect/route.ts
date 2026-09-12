import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { disconnectJumiaForUser } from "@/lib/jumia/credentials";
import { getWhatsAppConnection } from "@/lib/whatsapp/link";
import { sendTextIfConfigured } from "@/lib/whatsapp/client";
import { appUrl } from "@/lib/whatsapp/app-url";

// ─── POST /api/jumia/disconnect ───────────────────────────────────────────────
// Revokes the Jumia access token, then DELETES the connection row so that:
//  - The user's store data is fully removed
//  - The root page redirect (app/page.tsx) sends them back to onboarding
//
// Thin wrapper — the actual revoke + delete lives in
// lib/jumia/credentials.ts's disconnectJumiaForUser, shared with the
// WhatsApp chat's "confirm disconnect" command — that command already
// sends its own follow-up message, so the notice below is web-triggered
// only (kept here, not inside the shared function) to avoid double-texting
// a seller who disconnected from chat in the first place.

export async function POST() {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  const result = await disconnectJumiaForUser(userId);
  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.error }, { status: 500 });
  }

  try {
    const wa = await getWhatsAppConnection(userId);
    if (wa.connected && wa.phoneNumber) {
      await sendTextIfConfigured(
        wa.phoneNumber,
        `🔌 Your Jumia store was disconnected from PandaWorld from the website. Message me here whenever you're ready to reconnect, or visit ${appUrl()}/extension/settings.`,
      );
    }
  } catch (e) {
    console.warn(`[Jumia disconnect] WhatsApp notify failed for user=${userId}: ${(e as Error).message}`);
  }

  return NextResponse.json({ success: true });
}
