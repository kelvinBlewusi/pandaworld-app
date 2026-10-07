import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { assistantMessages, listingAssistantFor } from "@/lib/whatsapp/listing-assistant";

/** The Listing Assistant's conversation: the latest messages, or those after `?after=<ISO time>` (the page polls). */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  if (!(await listingAssistantFor(userId))) return NextResponse.json({ error: "The Jumia Listing Assistant isn't on for your account yet." }, { status: 403 });
  const after = req.nextUrl.searchParams.get("after");
  const valid = after && !Number.isNaN(Date.parse(after)) ? after : null;
  return NextResponse.json({ messages: await assistantMessages(userId, { after: valid }) });
}
