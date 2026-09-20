/**
 * Jumia Vendor API — OAuth 2.0 helpers (server-only)
 *
 * API base:   https://vendor-api.jumia.com  (product / feed / order APIs)
 * OAuth IdM:  https://auth-external.jumia.com  (Keycloak — Authorization Code Flow)
 * Spec:       https://vendorcenter.jumia.com/api-docs/openapi.yaml
 */

// ─── Endpoints ────────────────────────────────────────────────────────────────
// OAuth 2.0 / OIDC lives on auth-external.jumia.com (Keycloak IdM)
const JUMIA_AUTH_URL     = "https://auth-external.jumia.com/connect/auth";
const JUMIA_TOKEN_URL    = "https://auth-external.jumia.com/connect/token";
// All Vendor API calls (products, feeds, orders) go to vendor-api.jumia.com.
// Set JUMIA_API_ENV=staging to point to vendor-api-staging.jumia.com instead.
// Useful for testing without touching real seller inventory.
export const JUMIA_API_BASE =
  process.env.JUMIA_API_ENV === "staging"
    ? "https://vendor-api-staging.jumia.com"
    : "https://vendor-api.jumia.com";

// openid is required; offline_access requests a refresh_token
const SCOPES = "openid offline_access";

// ─── Build the URL the user is redirected to ─────────────────────────────────

export function buildAuthorizationUrl(
  state: string,
  clientId?: string,
  redirectUri?: string,
): string {
  const cid = clientId   ?? process.env.JUMIA_CLIENT_ID!;
  const rdi = redirectUri ?? process.env.JUMIA_REDIRECT_URI!;

  const params = new URLSearchParams({
    client_id:     cid,
    response_type: "code",
    scope:         SCOPES,
    prompt:        "login",   // always show login screen (per Jumia spec)
    redirect_uri:  rdi,
    state,
  });

  return `${JUMIA_AUTH_URL}?${params.toString()}`;
}

// ─── Exchange the one-time code for tokens ────────────────────────────────────

export async function exchangeCodeForTokens(
  code: string,
  clientId?: string,
  clientSecret?: string,
  redirectUri?: string,
): Promise<{
  access_token:   string;
  id_token?:      string;
  refresh_token?: string;
  expires_in:     number;
  token_type:     string;
}> {
  const cid = clientId     ?? process.env.JUMIA_CLIENT_ID!;
  const sec = clientSecret ?? process.env.JUMIA_CLIENT_SECRET!;
  const rdi = redirectUri  ?? process.env.JUMIA_REDIRECT_URI!;

  const body = new URLSearchParams({
    grant_type:    "authorization_code",
    code,
    redirect_uri:  rdi,
    client_id:     cid,
    client_secret: sec,
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

/**
 * A refresh attempt that reached Jumia's token endpoint and got a real
 * error response back — as opposed to a network failure, timeout, or 5xx,
 * none of which say anything about whether the refresh_token itself is
 * still good. Callers classify `code` against Jumia's documented error
 * values (invalid_grant, invalid_token, unauthorized_client) to decide
 * whether this is the definitive "the connection is really dead" signal
 * that justifies asking the seller to reconnect — see isDefinitiveAuthDeath
 * in lib/jumia/api.ts.
 */
export class JumiaTokenError extends Error {
  status: number;
  code:   string | undefined;

  constructor(status: number, body: unknown) {
    const b = (typeof body === "object" && body !== null) ? (body as Record<string, unknown>) : {};
    const code = typeof b.error === "string" ? b.error : undefined;
    const description = typeof b.error_description === "string" ? b.error_description : undefined;
    super(`Jumia token error (${status}): ${code ?? "unknown"}${description ? ` — ${description}` : ""}`);
    // This project compiles to ES5 (tsconfig's target), where `super(...)`
    // into a built-in like Error doesn't wire up the prototype chain —
    // every instance otherwise comes out as a plain Error at runtime, and
    // `e instanceof JumiaTokenError` silently returns false for callers
    // that need it to classify a failure as definitive vs. transient.
    Object.setPrototypeOf(this, JumiaTokenError.prototype);
    this.name   = "JumiaTokenError";
    this.status = status;
    this.code   = code;
  }
}

export async function refreshAccessToken(
  refreshToken: string,
  clientId?: string,
  clientSecret?: string,
): Promise<{
  access_token:   string;
  refresh_token?: string;
  expires_in:     number;
}> {
  const cid = clientId     ?? process.env.JUMIA_CLIENT_ID!;
  const sec = clientSecret ?? process.env.JUMIA_CLIENT_SECRET!;

  const body = new URLSearchParams({
    grant_type:    "refresh_token",
    refresh_token: refreshToken,
    client_id:     cid,
    client_secret: sec,
  });

  const res = await fetch(JUMIA_TOKEN_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    body.toString(),
  });

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}));
    throw new JumiaTokenError(res.status, errorBody);
  }

  return res.json();
}

// ─── Revoke a token ───────────────────────────────────────────────────────────

export async function revokeToken(
  token: string,
  clientId?: string,
  clientSecret?: string,
): Promise<void> {
  const cid = clientId     ?? process.env.JUMIA_CLIENT_ID!;
  const sec = clientSecret ?? process.env.JUMIA_CLIENT_SECRET!;

  // Keycloak revoke endpoint pattern
  await fetch(`${JUMIA_TOKEN_URL.replace("/token", "/revoke")}`, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams({
      token,
      client_id:     cid,
      client_secret: sec,
    }).toString(),
  }).catch(() => {});
  // Best-effort — don't throw
}
