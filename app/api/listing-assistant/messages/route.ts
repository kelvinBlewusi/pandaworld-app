import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { assistantMessages, creditLock, jumiaGate, listingAssistantFor } from "@/lib/whatsapp/listing-assistant";
import { chatClearedAt } from "@/lib/whatsapp/chat-clear";
import { webAddress } from "@/lib/whatsapp/channel";

/**
 * The Listing Assistant's conversation: the latest messages, or those after
 * `?after=<ISO time>` (the page polls), and `locked` while the seller is at 0
 * credits (the page locks its composer; it unlocks once the balance is above 0),
 * and `connectJumia` while the chat waits for the Jumia connection (jumiaGate:
 * its steps go in the conversation the first time), and `clearedAt`, when
 * the chat was last cleared (the page drops what it has from before).
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  if (!(await listingAssistantFor(userId))) return NextResponse.json({ error: "The Jumia Listing Assistant isn't on for your account yet." }, { status: 403 });
  const after = req.nextUrl.searchParams.get("after");
  const valid = after && !Number.isNaN(Date.parse(after)) ? after : null;
  // First, so what they say goes in the messages read below.
  const locked = await creditLock(userId).catch(() => false);
  const connectJumia = !locked && (await jumiaGate(userId).catch(() => false));
  const clearedAt = await chatClearedAt(webAddress(userId)).catch(() => null);
  return NextResponse.json({ messages: await assistantMessages(userId, { after: valid, clearedAt }), locked, connectJumia, clearedAt });
}
