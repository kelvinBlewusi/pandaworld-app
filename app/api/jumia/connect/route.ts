import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import { buildAuthorizationUrl } from "@/lib/jumia/oauth";
import { redeemConnectToken } from "@/lib/jumia/connect-token";
import { sanitizeReturnTo } from "@/lib/jumia/return-to";

// ─── GET /api/jumia/connect ───────────────────────────────────────────────────
// Looks up the seller's stored app_id, builds the Jumia OAuth authorization
// URL using it as the client_id, and redirects the browser there.
//
// Normally identifies the seller via their Clerk session (the Settings ->
// Integrations / onboarding "Authorise" buttons). A `wa_token` query param
// is the alternative entry point for the WhatsApp connect-Jumia-from-chat
// flow (lib/whatsapp/intake.ts) — a one-time token so tapping the link the
// bot sent works even if this browser has no active PandaWorld session.
// See lib/jumia/connect-token.ts for why that's safe: single-use,
// short-lived, and it only ever triggers a redirect to Jumia's OWN
// login/consent page.

export async function GET(req: NextRequest) {
  const waToken = req.nextUrl.searchParams.get("wa_token");
  const userId = waToken ? await redeemConnectToken(waToken) : (await auth()).userId;

  if (!userId) {
    return new NextResponse(
      waToken ? "This link has expired or was already used — ask the bot for a new one." : "Unauthorized",
      { status: waToken ? 400 : 401 },
    );
  }

  // Derive origin from the actual request so redirect_uri always matches
  // what the onboarding page displayed (window.location.origin).
  const origin   = req.nextUrl.origin;
  // returnTo (see lib/jumia/return-to.ts) — computed up front (it's a plain
  // query param, no DB round trip needed) so even an early failure below
  // sends the seller back to where they started (e.g. /extension/settings)
  // instead of always the old web dashboard's Settings → Integrations.
  const returnTo = sanitizeReturnTo(req.nextUrl.searchParams.get("return_to"));
  const failUrl  = `${origin}${returnTo ?? "/settings/integrations"}?jumia_error=`;

  // ── Look up the seller's stored Jumia credentials ─────────────────────────
  const db = createServerClient();
  const { data: conn, error: dbError } = await db
    .from("jumia_connections")
    .select("app_id, store_name")
    .eq("user_id", userId)
    .maybeSingle();

  if (dbError) {
    console.error("[Jumia connect] DB error:", dbError);
    return NextResponse.redirect(
      `${failUrl}${encodeURIComponent("Database error — please try again")}`
    );
  }

  if (!conn?.app_id) {
    return NextResponse.redirect(
      `${failUrl}${encodeURIComponent("No Jumia credentials found. Please complete onboarding first.")}`
    );
  }

  // ── Build redirect URI — must match what the seller registered in Vendor Center
  const redirectUri = `${origin}/api/jumia/callback`;

  // ── Generate CSRF state — encodes userId + nonce ──────────────────────────
  // returnTo rides along in the same blob so /api/jumia/callback knows
  // where to send the seller back to once OAuth finishes.
  const nonce = crypto.randomUUID();
  const state = Buffer.from(
    JSON.stringify({ userId, nonce, storeName: conn.store_name ?? "", returnTo })
  ).toString("base64url");

  const authUrl = buildAuthorizationUrl(state, conn.app_id, redirectUri);

  return NextResponse.redirect(authUrl);
}
