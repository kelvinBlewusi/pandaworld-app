import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { listingAssistantFor } from "@/lib/whatsapp/listing-assistant";
import { clearWebChat } from "@/lib/whatsapp/chat-clear";
import { logAppError } from "@/lib/observability/errors";

/**
 * "Clear chat" on the Listing Assistant (lib/whatsapp/chat-clear.ts): the
 * conversation starts over, as on a first visit. Answers the time it was
 * cleared; GET /api/listing-assistant/messages then shows only what's after.
 */
export async function POST() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  if (!(await listingAssistantFor(userId))) return NextResponse.json({ error: "The Jumia Listing Assistant isn't on for your account yet." }, { status: 403 });
  try {
    return NextResponse.json({ ok: true, clearedAt: await clearWebChat(userId) });
  } catch (e) {
    logAppError("listing-assistant-clear", e, { userId });
    return NextResponse.json({ error: "The chat didn't clear. Try again in a moment." }, { status: 500 });
  }
}
