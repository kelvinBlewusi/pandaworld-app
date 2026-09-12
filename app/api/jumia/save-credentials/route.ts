import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { saveJumiaCredentialsForUser } from "@/lib/jumia/credentials";

// ─── POST /api/jumia/save-credentials ─────────────────────────────────────────
// Thin HTTP wrapper around lib/jumia/credentials.ts's
// saveJumiaCredentialsForUser() — see that module for the actual upsert
// logic. This route's only jobs: authenticate via Clerk, parse the body,
// call the shared function, map its result to an HTTP response.

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  const { appId, secretKey, storeName, country } = await req.json();

  if (!appId || !secretKey) {
    return NextResponse.json({ error: "App ID and Secret Key are required." }, { status: 400 });
  }

  const result = await saveJumiaCredentialsForUser(userId, appId, secretKey, storeName, country);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }
  return NextResponse.json({ ok: true, ...(result.migrationPending ? { migrationPending: true } : {}) });
}
