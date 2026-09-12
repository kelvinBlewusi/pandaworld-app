import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { disconnectJumiaForUser } from "@/lib/jumia/credentials";

// ─── POST /api/jumia/disconnect ───────────────────────────────────────────────
// Revokes the Jumia access token, then DELETES the connection row so that:
//  - The user's store data is fully removed
//  - The root page redirect (app/page.tsx) sends them back to onboarding
//
// Thin wrapper — the actual revoke + delete lives in
// lib/jumia/credentials.ts's disconnectJumiaForUser, shared with the
// WhatsApp chat's "confirm disconnect" global command.

export async function POST() {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  const result = await disconnectJumiaForUser(userId);
  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.error }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
