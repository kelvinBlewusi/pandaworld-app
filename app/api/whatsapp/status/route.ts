import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getWhatsAppConnection } from "@/lib/whatsapp/link";

// ─── GET /api/whatsapp/status ─────────────────────────────────────────────────
// Returns the current user's WhatsApp connection status, for the
// Settings → Integrations page.

export async function GET() {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  const conn = await getWhatsAppConnection(userId);
  return NextResponse.json(conn);
}
