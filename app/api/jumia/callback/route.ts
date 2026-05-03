import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { exchangeCodeForTokens, fetchJumiaSellerProfile } from "@/lib/jumia/oauth";

// ─── GET /api/jumia/callback ──────────────────────────────────────────────────
// Jumia redirects here after the user authorises PandaWorld.
// Query params: ?code=<one-time-code>&state=<base64-encoded-state>
//
// Flow:
//  1. Decode the `state` to recover the Clerk userId (set in /connect)
//  2. Exchange the code for access + refresh tokens
//  3. Fetch the seller's profile from Jumia API
//  4. Upsert the connection row in Supabase
//  5. Redirect to /settings/integrations with ?connected=1

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const code     = searchParams.get("code");
  const stateRaw = searchParams.get("state");
  const error    = searchParams.get("error");

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3002";
  const failUrl    = `${appUrl}/settings/integrations?jumia_error=`;
  const successUrl = `${appUrl}/settings/integrations?connected=1`;

  // ── User denied access ─────────────────────────────────────────────────────
  if (error) {
    console.warn("[Jumia OAuth] User denied access or error from Jumia:", error);
    return NextResponse.redirect(`${failUrl}${encodeURIComponent(error)}`);
  }

  if (!code || !stateRaw) {
    return NextResponse.redirect(`${failUrl}${encodeURIComponent("Missing code or state parameter")}`);
  }

  // ── Decode state → recover userId ─────────────────────────────────────────
  let userId: string;
  try {
    const decoded = JSON.parse(Buffer.from(stateRaw, "base64url").toString("utf-8"));
    userId = decoded.userId;
    if (!userId) throw new Error("No userId in state");
  } catch (e) {
    console.error("[Jumia OAuth] Invalid state param:", e);
    return NextResponse.redirect(`${failUrl}${encodeURIComponent("Invalid state parameter — please try again")}`);
  }

  // ── Exchange code for tokens ───────────────────────────────────────────────
  let tokens: { access_token: string; refresh_token?: string; expires_in: number };
  try {
    tokens = await exchangeCodeForTokens(code);
  } catch (e) {
    console.error("[Jumia OAuth] Token exchange failed:", e);
    return NextResponse.redirect(
      `${failUrl}${encodeURIComponent("Token exchange failed — check your Jumia app credentials")}`
    );
  }

  // ── Fetch seller profile (best-effort) ────────────────────────────────────
  const profile = await fetchJumiaSellerProfile(tokens.access_token);

  // ── Compute token expiry time ─────────────────────────────────────────────
  const tokenExpiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null;

  // ── Upsert into Supabase ───────────────────────────────────────────────────
  const db = createServerClient();

  const { error: dbError } = await db.from("jumia_connections").upsert(
    {
      user_id:          userId,
      access_token:     tokens.access_token,
      refresh_token:    tokens.refresh_token ?? null,
      token_expires_at: tokenExpiresAt,
      seller_id:        profile.seller_id,
      seller_name:      profile.seller_name,
      seller_email:     profile.seller_email,
      store_name:       profile.store_name,
      shop_id:          profile.shop_id,          // required for product API calls
      status:           "active",
      updated_at:       new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );

  if (dbError) {
    console.error("[Jumia OAuth] DB upsert failed:", dbError);
    return NextResponse.redirect(
      `${failUrl}${encodeURIComponent("Database error — please try again")}`
    );
  }

  console.info(`[Jumia OAuth] Connected seller=${profile.seller_name ?? "unknown"} for user=${userId}`);
  return NextResponse.redirect(successUrl);
}
