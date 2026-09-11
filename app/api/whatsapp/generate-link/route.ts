import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createLinkCode } from "@/lib/whatsapp/link";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

// ─── POST /api/whatsapp/generate-link ─────────────────────────────────────────
// Creates a fresh, 15-minute link code for the current user and returns the
// wa.me deep link the Settings page renders as a button. Rate-limited —
// this is a low-cost DB insert, but there's no reason a client should ever
// need to call it in a tight loop.

export async function POST() {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  const limited = checkRateLimit(`whatsapp-link:${userId}`, RATE_LIMITS.whatsappLink);
  if (limited) return limited;

  try {
    const { code, waLink } = await createLinkCode(userId);
    return NextResponse.json({ code, waLink });
  } catch (e) {
    console.error("[whatsapp generate-link]", e);
    return NextResponse.json(
      { error: (e as Error).message ?? "Failed to generate a link code." },
      { status: 500 },
    );
  }
}
