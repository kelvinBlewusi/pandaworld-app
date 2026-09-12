import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { exchangeCodeForTokens, fetchJumiaSellerProfile } from "@/lib/jumia/oauth";
import { encrypt, decrypt } from "@/lib/security/token-crypto";
import { clearJumiaHealthCache } from "@/lib/jumia/api";
import { getWhatsAppConnection } from "@/lib/whatsapp/link";
import { sendTextIfConfigured } from "@/lib/whatsapp/client";
import { updateSession } from "@/lib/whatsapp/session";

// ─── GET /api/jumia/callback ──────────────────────────────────────────────────
// Jumia redirects here after the user authorises PandaWorld.
// Query params: ?code=<one-time-code>&state=<base64-encoded-state>
//
// Flow:
//  1. Decode `state` to recover Clerk userId (set in /connect)
//  2. Look up the seller's app_id + app_secret from Supabase
//  3. Exchange the code for access + refresh tokens using their credentials
//  4. Fetch the seller's profile from Jumia API
//  5. Upsert the connection row in Supabase
//  6. Redirect to /onboarding/done (from onboarding) or /settings/integrations

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const code     = searchParams.get("code");
  const stateRaw = searchParams.get("state");
  const error    = searchParams.get("error");

  const origin  = req.nextUrl.origin;
  const failUrl = `${origin}/settings/integrations?jumia_error=`;

  // ── User denied access ─────────────────────────────────────────────────────
  if (error) {
    console.warn("[Jumia OAuth] User denied access or error from Jumia:", error);
    return NextResponse.redirect(`${failUrl}${encodeURIComponent(error)}`);
  }

  if (!code || !stateRaw) {
    return NextResponse.redirect(
      `${failUrl}${encodeURIComponent("Missing code or state parameter")}`
    );
  }

  // ── Decode state → recover userId ─────────────────────────────────────────
  let userId: string;
  let storeName: string = "";
  try {
    const decoded = JSON.parse(
      Buffer.from(stateRaw, "base64url").toString("utf-8")
    );
    userId = decoded.userId;
    storeName = decoded.storeName ?? "";
    if (!userId) throw new Error("No userId in state");
  } catch (e) {
    console.error("[Jumia OAuth] Invalid state param:", e);
    return NextResponse.redirect(
      `${failUrl}${encodeURIComponent("Invalid state parameter — please try again")}`
    );
  }

  // ── Look up seller's app credentials ─────────────────────────────────────
  const db = createServerClient();
  const { data: conn, error: dbLookupError } = await db
    .from("jumia_connections")
    .select("app_id, app_secret, store_name")
    .eq("user_id", userId)
    .maybeSingle();

  if (dbLookupError || !conn?.app_id || !conn?.app_secret) {
    console.error("[Jumia OAuth] Could not load seller credentials:", dbLookupError);
    return NextResponse.redirect(
      `${failUrl}${encodeURIComponent("Seller credentials not found — please reconnect")}`
    );
  }

  // ── Build redirect URI (must match what was sent in /connect) ─────────────
  const redirectUri = `${origin}/api/jumia/callback`;

  // ── Exchange code for tokens using the seller's own app credentials ────────
  let tokens: { access_token: string; refresh_token?: string; expires_in: number };
  try {
    tokens = await exchangeCodeForTokens(
      code,
      conn.app_id,
      // Decrypt — credentials saved via /save-credentials are now stored
      // encrypted; pre-encryption rows still pass through unchanged.
      decrypt(conn.app_secret as string),
      redirectUri,
    );
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

  // ── Upsert connection — real access_token replaces credential_auth sentinel
  const resolvedStoreName =
    profile.store_name ?? conn.store_name ?? storeName ?? "Jumia Store";

  const { error: dbError } = await db.from("jumia_connections").upsert(
    {
      user_id:          userId,
      // Encrypted at rest — see lib/security/token-crypto.ts. A
      // breach of jumia_connections no longer hands an attacker the
      // seller's vendor-center access. Encryption is idempotent so
      // re-running this code path is safe.
      access_token:     encrypt(tokens.access_token),
      refresh_token:    tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
      token_expires_at: tokenExpiresAt,
      seller_id:        profile.seller_id,
      seller_name:      profile.seller_name,
      seller_email:     profile.seller_email,
      store_name:       resolvedStoreName,
      shop_id:          profile.shop_id,
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

  // Bust the layout's health cache so the seller's NEXT navigation
  // hits Jumia for a fresh probe (otherwise they could see the
  // dashboard layout loop them back to onboarding for up to 60s after
  // a successful reconnect, because the cache still says "broken").
  clearJumiaHealthCache(userId);

  console.info(
    `[Jumia OAuth] Connected seller=${profile.seller_name ?? "unknown"} for user=${userId}`
  );

  // NOTE: category sync used to fire here as a fire-and-forget background
  // task. That's been replaced by the admin-controlled batched sync at
  // /admin/categories. Categories are pre-seeded from the bundled JSON
  // snapshot, so by the time this seller reaches the listing flow the
  // picker is already populated. Per-category attribute schemas still
  // load on demand via /api/jumia/categories/[code]/attributes.

  // If this seller was specifically waiting on THIS OAuth step from the
  // WhatsApp connect-from-chat flow (lib/whatsapp/intake.ts's
  // awaiting_jumia_oauth state — reached by tapping the one-time link the
  // bot sent after they pasted their app credentials), unblock the
  // listing flow and tell them here, not just on whatever browser
  // happened to complete this redirect. Gated on that exact state so an
  // unrelated re-authorise (e.g. a needs_reconnect fix from the web
  // Settings page) never resets a seller's in-progress batch. Best-effort
  // — never let a WhatsApp hiccup break the OAuth flow itself.
  try {
    const wa = await getWhatsAppConnection(userId);
    if (wa.connected && wa.phoneNumber) {
      const { data: session } = await db
        .from("whatsapp_sessions")
        .select("state")
        .eq("phone_number", wa.phoneNumber)
        .maybeSingle();
      if (session?.state === "awaiting_jumia_oauth") {
        await updateSession(wa.phoneNumber, { state: "awaiting_count", listingId: null });
        await sendTextIfConfigured(
          wa.phoneNumber,
          `🎉 Jumia connected${resolvedStoreName ? ` — ${resolvedStoreName}` : ""}! How many products are you listing today? Reply with a number to get started.`,
        );
      }
    }
  } catch (e) {
    console.warn(`[Jumia OAuth] WhatsApp notify failed for user=${userId}: ${(e as Error).message}`);
  }

  // Redirect to done page (onboarding flow) with store name
  const successUrl = `${origin}/onboarding/done?store=${encodeURIComponent(resolvedStoreName)}`;
  return NextResponse.redirect(successUrl);
}
