import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { connectSelfAuthorization } from "@/lib/jumia/self-auth";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { COUNTRY_CURRENCY, DEFAULT_JUMIA_COUNTRY } from "@/lib/jumia/api";
import { notifyWhatsAppJumiaConnected } from "@/lib/whatsapp/jumia-connected";

// ─── POST /api/jumia/self-auth ────────────────────────────────────────────────
// Connect Jumia with a Self Authorization app: body { clientId,
// refreshToken, country }. The connection then renews itself and never
// needs the seller to log in again. See lib/jumia/self-auth.ts.

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  const limited = checkRateLimit(`jumia-connect:${userId}`, RATE_LIMITS.jumiaConnect);
  if (limited) return limited;

  let body: { clientId?: unknown; refreshToken?: unknown; country?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Missing Client ID and token." }, { status: 400 });
  }
  const clientId = typeof body.clientId === "string" ? body.clientId : "";
  const refreshToken = typeof body.refreshToken === "string" ? body.refreshToken : "";
  const country = typeof body.country === "string" && body.country in COUNTRY_CURRENCY ? body.country : DEFAULT_JUMIA_COUNTRY;
  if (!clientId || !refreshToken) {
    return NextResponse.json({ error: "Paste both the Client ID and the generated token." }, { status: 400 });
  }

  const result = await connectSelfAuthorization(userId, clientId, refreshToken, country);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  await notifyWhatsAppJumiaConnected(userId, result.storeName);
  return NextResponse.json({ ok: true, storeName: result.storeName });
}
