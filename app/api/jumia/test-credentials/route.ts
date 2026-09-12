import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { testJumiaCredentials } from "@/lib/jumia/credentials";

// ─── POST /api/jumia/test-credentials ─────────────────────────────────────────
// Thin HTTP wrapper around lib/jumia/credentials.ts's testJumiaCredentials()
// — see that module for the actual verification logic against Jumia's
// token endpoint. This route's only jobs: authenticate via Clerk, parse
// the body, call the shared function, map its result to an HTTP response.

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  const { appId, secretKey } = await req.json();

  if (!appId || !secretKey) {
    return NextResponse.json({ ok: false, error: "App ID and Secret Key are required." }, { status: 400 });
  }

  const result = await testJumiaCredentials(appId, secretKey);
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
