import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { storeAssistantUpload } from "@/lib/whatsapp/media";
import { listingAssistantFor } from "@/lib/whatsapp/listing-assistant";

/**
 * A photo for the Listing Assistant (lib/whatsapp/listing-assistant.ts):
 * checked like a WhatsApp photo and stored; the page then sends its media id
 * as a message.
 */

/** WhatsApp's own limit for an image, kept the same here. */
const MAX_BYTES = 5 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  if (!(await listingAssistantFor(userId))) return NextResponse.json({ error: "The Jumia Listing Assistant isn't on for your account yet." }, { status: 403 });
  const blocked = checkRateLimit(`assistant-upload:${userId}`, RATE_LIMITS.assistantUpload);
  if (blocked) return blocked;

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file === "string") return NextResponse.json({ error: "Attach a photo." }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "That photo is over 5 MB. Send a smaller one." }, { status: 413 });

  const stored = await storeAssistantUpload(userId, Buffer.from(await file.arrayBuffer()), file.name || "photo");
  if (!stored) return NextResponse.json({ error: "That file isn't a photo I can use (JPEG, PNG or WebP)." }, { status: 415 });
  return NextResponse.json(stored);
}
