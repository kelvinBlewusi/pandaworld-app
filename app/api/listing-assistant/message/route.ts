import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { listingAssistantFor, receiveAssistantMessage } from "@/lib/whatsapp/listing-assistant";
import { logAppError } from "@/lib/observability/errors";

/**
 * A message to the Listing Assistant: text, photos (their media ids from
 * /api/listing-assistant/upload, up to 8 as one album, with an optional
 * caption), or a tap on one
 * of the bot's buttons (the button's id as text, its words as `label`).
 * Handled by the WhatsApp bot under the seller's web address; its replies
 * appear in GET /api/listing-assistant/messages.
 */

// The same budget as the WhatsApp webhook, which runs the same handling.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  if (!(await listingAssistantFor(userId))) return NextResponse.json({ error: "The Jumia Listing Assistant isn't on for your account yet." }, { status: 403 });
  const blocked = checkRateLimit(`assistant-message:${userId}`, RATE_LIMITS.assistantMessage);
  if (blocked) return blocked;

  const body = (await req.json().catch(() => null)) as { id?: unknown; text?: unknown; mediaId?: unknown; mediaIds?: unknown; label?: unknown; last?: unknown } | null;
  const id = typeof body?.id === "string" && /^[\w-]{8,80}$/.test(body.id) ? body.id : null;
  if (!id) return NextResponse.json({ error: "Missing message id." }, { status: 400 });
  const str = (v: unknown) => (typeof v === "string" ? v : null);

  try {
    const r = await receiveAssistantMessage(userId, {
      id, text: str(body?.text), mediaId: str(body?.mediaId), label: str(body?.label),
      // Several photos sent at once: one message, an album.
      mediaIds: Array.isArray(body?.mediaIds) ? body.mediaIds.filter((m): m is string => typeof m === "string").slice(0, 8) : null,
      // Photos of one upload: false on all but the last, which gets the bot's count.
      last: typeof body?.last === "boolean" ? body.last : null,
    });
    return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r.error }, { status: 400 });
  } catch (e) {
    console.error(`[listing assistant] ${userId}: ${(e as Error).message}`);
    logAppError("listing-assistant", e, { userId });
    return NextResponse.json({ error: "Something went wrong handling that. Try again in a moment." }, { status: 500 });
  }
}
