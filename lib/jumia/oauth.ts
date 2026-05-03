/**
 * Jumia Vendor API — OAuth 2.0 helpers (server-only)
 *
 * API base: https://vendor-api.jumia.com
 * Spec:     https://vendorcenter.jumia.com/api-docs/openapi.yaml
 *
 * Auth type: Authorization Code Flow
 * Token engine: Keycloak embedded in vendor-api.jumia.com
 */

// ─── Confirmed endpoints from the official OpenAPI spec ──────────────────────
const JUMIA_AUTH_URL     = "https://vendor-api.jumia.com/login";
const JUMIA_TOKEN_URL    = "https://vendor-api.jumia.com/token";
export const JUMIA_API_BASE = "https://vendor-api.jumia.com";

// openid is required; offline_access requests a refresh_token
const SCOPES = "openid offline_access";

// ─── Build the URL the user is redirected to ─────────────────────────────────

export function buildAuthorizationUrl(state: string): string {
  const clientId    = process.env.JUMIA_CLIENT_ID!;
  const redirectUri = process.env.JUMIA_REDIRECT_URI!;

  const params = new URLSearchParams({
    client_id:     clientId,
    response_type: "code",
    scope:         SCOPES,
    prompt:        "login",   // always show login screen (per Jumia spec)
    redirect_uri:  redirectUri,
    state,
  });

  return `${JUMIA_AUTH_URL}?${params.toString()}`;
}

// ─── Exchange the one-time code for tokens ────────────────────────────────────

export async function exchangeCodeForTokens(code: string): Promise<{
  access_token:   string;
  id_token?:      string;
  refresh_token?: string;
  expires_in:     number;
  token_type:     string;
}> {
  const clientId     = process.env.JUMIA_CLIENT_ID!;
  const clientSecret = process.env.JUMIA_CLIENT_SECRET!;
  const redirectUri  = process.env.JUMIA_REDIRECT_URI!;

  const body = new URLSearchParams({
    grant_type:    "authorization_code",
    code,
    redirect_uri:  redirectUri,
    client_id:     clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(JUMIA_TOKEN_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jumia token exchange failed (${res.status}): ${text}`);
  }

  return res.json();
}

// ─── Fetch seller profile + shop ID ──────────────────────────────────────────

export async function fetchJumiaSellerProfile(accessToken: string): Promise<{
  seller_id:    string | null;
  seller_name:  string | null;
  seller_email: string | null;
  store_name:   string | null;
  shop_id:      string | null;
}> {
  let seller_id: string | null    = null;
  let seller_name: string | null  = null;
  let seller_email: string | null = null;
  let store_name: string | null   = null;
  let shop_id: string | null      = null;

  // 1. GET /shops — returns the vendor's shop(s); we need shopId for all API calls
  try {
    const shopsRes = await fetch(`${JUMIA_API_BASE}/shops`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept:        "application/json",
      },
    });
    if (shopsRes.ok) {
      const shops = await shopsRes.json();
      // Response is likely an array or { shops: [...] }
      const list = Array.isArray(shops) ? shops : (shops.shops ?? shops.data ?? []);
      if (list.length > 0) {
        const shop  = list[0];
        shop_id     = shop.id        ?? shop.shopId    ?? shop.shop_id    ?? null;
        store_name  = shop.name      ?? shop.shopName  ?? shop.store_name ?? null;
        seller_id   = shop.sellerId  ?? shop.seller_id ?? shop.id         ?? null;
        seller_email= shop.email                                            ?? null;
        seller_name = shop.sellerName ?? shop.seller_name                  ?? null;
      }
      console.info("[Jumia OAuth] Shops response:", JSON.stringify(shops).slice(0, 300));
    } else {
      console.warn("[Jumia OAuth] GET /shops failed:", shopsRes.status, await shopsRes.text().catch(() => ""));
    }
  } catch (e) {
    console.warn("[Jumia OAuth] GET /shops error:", e);
  }

  return { seller_id, seller_name, seller_email, store_name, shop_id };
}

// ─── Refresh an expired access token ─────────────────────────────────────────

export async function refreshAccessToken(refreshToken: string): Promise<{
  access_token:   string;
  refresh_token?: string;
  expires_in:     number;
}> {
  const clientId     = process.env.JUMIA_CLIENT_ID!;
  const clientSecret = process.env.JUMIA_CLIENT_SECRET!;

  const body = new URLSearchParams({
    grant_type:    "refresh_token",
    refresh_token: refreshToken,
    client_id:     clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(JUMIA_TOKEN_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jumia token refresh failed (${res.status}): ${text}`);
  }

  return res.json();
}

// ─── Revoke a token ───────────────────────────────────────────────────────────

export async function revokeToken(token: string): Promise<void> {
  const clientId     = process.env.JUMIA_CLIENT_ID!;
  const clientSecret = process.env.JUMIA_CLIENT_SECRET!;

  // Keycloak revoke endpoint pattern
  await fetch(`${JUMIA_TOKEN_URL.replace("/token", "/revoke")}`, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams({
      token,
      client_id:     clientId,
      client_secret: clientSecret,
    }).toString(),
  }).catch(() => {});
  // Best-effort — don't throw
}
