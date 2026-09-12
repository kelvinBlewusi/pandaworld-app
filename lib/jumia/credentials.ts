/**
 * Jumia app-credential test + save — the core orchestration behind
 * POST /api/jumia/test-credentials and POST /api/jumia/save-credentials,
 * extracted so a caller with no Clerk session (the WhatsApp webhook) can
 * run the exact same flow by passing userId directly instead of it being
 * read from request cookies. Same reasoning as lib/jumia/push-listing.ts,
 * lib/actions/auto-analyze.ts, and lib/listings/create.ts.
 */

import { createServerClient } from "@/lib/supabase/server";
import { encrypt } from "@/lib/security/token-crypto";

const JUMIA_TOKEN_URL = "https://auth-external.jumia.com/connect/token";

export type CredentialTestResult = { ok: true; message: string } | { ok: false; error: string };

/**
 * Verifies an App ID + Secret Key against Jumia's token endpoint. Uses
 * client_credentials grant — if Jumia returns invalid_client we know the
 * creds are wrong; if it returns unsupported_grant_type the creds are
 * valid (Jumia doesn't support client_credentials but the error confirms
 * the app exists).
 */
export async function testJumiaCredentials(appId: string, secretKey: string): Promise<CredentialTestResult> {
  try {
    const body = new URLSearchParams({
      grant_type:    "client_credentials",
      client_id:     appId,
      client_secret: secretKey,
    });

    const res = await fetch(JUMIA_TOKEN_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    body.toString(),
    });

    const data = await res.json().catch(() => ({}));

    if (res.ok && data.access_token) {
      return { ok: true, message: "Credentials verified successfully." };
    }

    const errorCode = data.error ?? "";

    if (errorCode === "unsupported_grant_type" || errorCode === "unauthorized_client") {
      return { ok: true, message: "Credentials verified. Proceed to connect." };
    }

    if (errorCode === "invalid_client" || res.status === 401) {
      return { ok: false, error: "Invalid App ID or Secret Key. Double-check your Vendor Center credentials." };
    }

    return { ok: false, error: `Jumia returned: ${errorCode || res.status}. Check your credentials.` };
  } catch (e) {
    console.error("[credentials] testJumiaCredentials error:", e);
    return { ok: false, error: "Could not reach Jumia servers. Try again." };
  }
}

export type JumiaConnectionKind = "connected" | "needs_credentials" | "needs_oauth";

/**
 * Classifies a seller's Jumia connection for the WhatsApp connect-from-chat
 * gate (lib/whatsapp/intake.ts / app/api/whatsapp/webhook/route.ts):
 *   - no row, or status "revoked"           -> needs_credentials (start
 *     from scratch: create the app in Vendor Center, paste creds here).
 *   - access_token is the "credential_auth" sentinel -> needs_oauth
 *     (creds already saved — either from the web form or from a previous
 *     chat attempt — just needs the browser OAuth consent step).
 *   - anything else (active with a real token, OR needs_reconnect) ->
 *     connected. needs_reconnect deliberately isn't gated here — it's a
 *     working setup whose token expired, and the seller's existing
 *     one-click "Re-authorise" flow (Settings -> Integrations, or the web
 *     onboarding reconnect screen) already handles it; the chat flow only
 *     exists to get a NEVER-connected seller unblocked.
 */
export async function getJumiaConnectionKind(userId: string): Promise<JumiaConnectionKind> {
  const db = createServerClient();
  const { data: conn } = await db
    .from("jumia_connections")
    .select("status, access_token")
    .eq("user_id", userId)
    .maybeSingle();

  if (!conn || conn.status === "revoked") return "needs_credentials";
  if (conn.access_token === "credential_auth") return "needs_oauth";
  return "connected";
}

export type SaveCredentialsResult = { ok: true; migrationPending?: boolean } | { ok: false; error: string };

/**
 * Saves per-user Jumia app credentials (credential-based auth, not OAuth
 * itself — the OAuth authorize/callback round trip still has to happen
 * separately). access_token is required NOT NULL in the table — we use a
 * sentinel value "credential_auth" to indicate this row was created via
 * app credentials, not the traditional OAuth flow. The real auth is
 * app_id + app_secret.
 */
export async function saveJumiaCredentialsForUser(
  userId: string,
  appId: string,
  secretKey: string,
  storeName?: string,
  country?: string,
): Promise<SaveCredentialsResult> {
  const db  = createServerClient();
  const now = new Date().toISOString();

  // Encrypt the app_secret at rest. Same OAuth-power as the access
  // token — a leak gives an attacker the ability to mint new tokens
  // for this seller indefinitely. See lib/security/token-crypto.ts.
  const encryptedSecret = encrypt(secretKey);

  // Try full upsert with new columns (requires add_onboarding.sql migration)
  const { error: fullError } = await db.from("jumia_connections").upsert(
    {
      user_id:      userId,
      access_token: "credential_auth",   // sentinel — real auth via app_id/app_secret
      app_id:       appId,
      app_secret:   encryptedSecret,
      store_name:   storeName || "Jumia Store",
      country:      country ?? "GH",
      status:       "active",
      connected_at: now,
      updated_at:   now,
    },
    { onConflict: "user_id" }
  );

  if (!fullError) return { ok: true };

  console.warn("[credentials] Full upsert failed, trying minimal:", fullError.code, fullError.message);

  // If the new columns don't exist yet (migration not run), fall back to a
  // minimal upsert that only touches columns guaranteed to exist.
  const isMissingColumn =
    fullError.code === "42703" || fullError.message?.includes("column");

  if (!isMissingColumn) {
    console.error("[credentials] Unexpected DB error:", fullError);
    return { ok: false, error: "Failed to save credentials. Please try again." };
  }

  // (note: this minimal fallback skips app_secret because the
  // installation hasn't run the add_onboarding.sql migration yet.
  // It's a degraded path used only on fresh deploys; the seller will
  // need to re-save credentials after the migration runs.)
  const { error: minError } = await db.from("jumia_connections").upsert(
    {
      user_id:      userId,
      access_token: "credential_auth",
      store_name:   storeName || "Jumia Store",
      status:       "active",
      connected_at: now,
      updated_at:   now,
    },
    { onConflict: "user_id" }
  );

  if (minError) {
    console.error("[credentials] Minimal upsert also failed:", minError);
    return { ok: false, error: "Failed to save credentials. Please try again." };
  }

  return { ok: true, migrationPending: true };
}
