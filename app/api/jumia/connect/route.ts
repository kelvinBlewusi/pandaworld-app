import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { buildAuthorizationUrl } from "@/lib/jumia/oauth";

// ─── GET /api/jumia/connect ───────────────────────────────────────────────────
// Generates the Jumia OAuth authorization URL and redirects the browser to it.
// A random `state` token is embedded in the URL — the callback verifies it
// to prevent CSRF.

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  if (!process.env.JUMIA_CLIENT_ID || !process.env.JUMIA_REDIRECT_URI) {
    return NextResponse.json(
      { error: "Jumia OAuth is not configured. Add JUMIA_CLIENT_ID and JUMIA_REDIRECT_URI to .env.local." },
      { status: 500 }
    );
  }

  // Generate a random CSRF state token and embed userId so the callback
  // can associate the tokens with the right user without a separate session store.
  const nonce = crypto.randomUUID();
  const state = Buffer.from(JSON.stringify({ userId, nonce })).toString("base64url");

  const authUrl = buildAuthorizationUrl(state);

  return NextResponse.redirect(authUrl);
}
