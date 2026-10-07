/**
 * Jumia "Self Authorization" connections: the kind that stays connected.
 *
 * Jumia gives refresh tokens only to Self Authorization applications. A
 * "Web Application" (what sellers were first told to create) never gets
 * one, so its access token dies after about a day and the seller has to
 * log in again. See Jumia's own docs, vendorcenter.jumia.com/api-docs,
 * "Step-by-Step Authentication".
 *
 * With Self Authorization the seller creates the app with just a name,
 * clicks Generate Token (the orange lock icon in Vendor Center's
 * Actions column), and gives us the Client ID and that refresh token. We exchange it (grant_type=refresh_token, no client secret, no
 * browser), and every exchange returns a new refresh token that replaces
 * the old one. /api/worker/jumia-keepalive keeps rotating it before it
 * lapses, so the connection never expires.
 *
 * Plain server module (not "use server"): the WhatsApp webhook calls it
 * with a userId it resolved itself.
 */

import { createServerClient } from "@/lib/supabase/server";
import { encrypt } from "@/lib/security/token-crypto";
import { JumiaTokenError, fetchJumiaSellerProfile, refreshAccessToken } from "@/lib/jumia/oauth";
import { clearJumiaHealthCache } from "@/lib/jumia/api";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A Jumia Client ID is a UUID. */
export function looksLikeClientId(s: string): boolean {
  return UUID_RE.test(s.trim());
}

/**
 * A Client ID with a piece missing or extra: hex in dashed groups that
 * isn't a whole UUID. The owner's test (2026-10-07) pasted one a character
 * short, which was taken as the token.
 */
export function looksLikeBrokenClientId(s: string): boolean {
  const t = s.trim();
  return !UUID_RE.test(t) && /^[0-9a-f]+(?:-[0-9a-f]*){3,5}$/i.test(t) && t.length >= 20;
}

/**
 * Plausibly a token Vendor Center generated: one unbroken run of token
 * characters. Deliberately loose — Jumia's docs show a JWT ("eyJ…"), but
 * the lock icon hands out a short opaque one (43 characters, confirmed
 * 2026-09-28), and a Web Application's Client Secret looks much the same.
 * Which kind of app it is gets settled by asking Jumia, not by shape: see
 * the "web_app" reason below.
 */
export function looksLikeGeneratedToken(s: string): boolean {
  const t = s.trim();
  return t.length >= 20 && /^[A-Za-z0-9._~+/=-]+$/.test(t);
}

export type SelfAuthFailure =
  /** Jumia won't do this exchange for that Client ID: it's a Web Application (or not a real one). */
  | "web_app"
  /** The token was refused: expired, already used, or replaced by a newer one. */
  | "bad_token"
  | "bad_input"
  | "unreachable"
  | "save_failed";

export type SelfAuthResult =
  | { ok: true; storeName: string }
  | { ok: false; reason: SelfAuthFailure; error: string };

/** Why Jumia refused the pair, and what to tell the seller. */
function explain(e: unknown): { reason: SelfAuthFailure; error: string } {
  if (e instanceof JumiaTokenError) {
    // A Web Application's client can't use this grant, and without its
    // secret it fails client authentication: either way, not a Self
    // Authorization app (or a Client ID Jumia doesn't know).
    if (e.code === "unauthorized_client" || e.code === "invalid_client" || e.status === 401) {
      return {
        reason: "web_app",
        error: "Jumia wouldn't accept that Client ID here. Use the Client ID of a Self Authorization application (Web Applications can't stay connected).",
      };
    }
    if (e.code === "invalid_grant") {
      return {
        reason: "bad_token",
        error: "That token has expired or was already used. In Vendor Center, tap on the padlock icon next to PandaWorld again and paste the new token straight away.",
      };
    }
    return { reason: "bad_token", error: `Jumia refused the connection (${e.code ?? e.status}). Generate a new token and try again.` };
  }
  return { reason: "unreachable", error: "Couldn't reach Jumia just now. Try again in a minute." };
}

/**
 * Connect (or reconnect) a seller with a Self Authorization app: exchange
 * the generated refresh token, look up their shop, and save the rotated
 * tokens. Replaces whatever connection they had.
 */
export async function connectSelfAuthorization(
  userId:   string,
  clientId: string,
  refreshToken: string,
  country:  string,
): Promise<SelfAuthResult> {
  const cid = clientId.trim();
  const token = refreshToken.trim();
  if (!looksLikeClientId(cid)) {
    return { ok: false, reason: "bad_input", error: "That doesn't look like a Client ID. It's the long code with dashes shown next to your application in Vendor Center." };
  }
  if (!looksLikeGeneratedToken(token)) {
    return { ok: false, reason: "bad_input", error: "That doesn't look like a generated token. In Vendor Center, tap on the padlock icon next to your Self Authorization application and copy the whole token." };
  }

  let tokens: Awaited<ReturnType<typeof refreshAccessToken>>;
  try {
    // No client secret: Self Authorization apps don't have one.
    tokens = await refreshAccessToken(token, cid, undefined);
  } catch (e) {
    console.warn(`[jumia self-auth] exchange failed for ${userId}: ${(e as Error).message}`);
    return { ok: false, ...explain(e) };
  }
  if (!tokens.refresh_token) {
    // Only a Web Application answers without one, and it wouldn't have
    // accepted this grant in the first place — but if it ever did, saving
    // it would just be the old expires-daily connection again.
    return { ok: false, reason: "web_app", error: "Jumia didn't return a refresh token, so this connection couldn't stay on. Make sure the application is a Self Authorization one." };
  }

  const profile = await fetchJumiaSellerProfile(tokens.access_token);
  const now = Date.now();
  const storeName = profile.store_name ?? "Jumia Store";

  const db = createServerClient();
  const { error } = await db.from("jumia_connections").upsert(
    {
      user_id:                  userId,
      auth_type:                "self",
      access_token:             encrypt(tokens.access_token),
      refresh_token:            encrypt(tokens.refresh_token),
      token_expires_at:         new Date(now + tokens.expires_in * 1000).toISOString(),
      refresh_token_expires_at: tokens.refresh_expires_in
        ? new Date(now + tokens.refresh_expires_in * 1000).toISOString()
        : null,
      app_id:                   cid,
      app_secret:               null,
      country,
      seller_id:                profile.seller_id,
      seller_name:              profile.seller_name,
      seller_email:             profile.seller_email,
      store_name:               storeName,
      shop_id:                  profile.shop_id,
      status:                   "active",
      refresh_locked_at:        null,
      connected_at:             new Date(now).toISOString(),
      updated_at:               new Date(now).toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) {
    // The token Jumia just rotated is gone if this isn't saved; the seller
    // has to generate another.
    console.error(`[jumia self-auth] saving the connection for ${userId} failed: ${error.message}`);
    return { ok: false, reason: "save_failed", error: "Connected to Jumia but couldn't save it. Generate a new token and try again." };
  }
  // The dashboard layout caches connection health; drop it so the next page
  // sees the new connection straight away.
  clearJumiaHealthCache(userId);
  return { ok: true, storeName };
}
