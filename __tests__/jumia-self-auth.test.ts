/**
 * Jumia Self Authorization connections — the kind that stays connected
 * (lib/jumia/self-auth.ts, lib/jumia/keepalive.ts).
 *
 * Jumia gives refresh tokens only to Self Authorization apps; the Web
 * Applications sellers used to create never get one, which is why every
 * connection died a day after connecting. These cover: connecting with a
 * Client ID and generated token, refreshing without a client secret,
 * keeping connections renewed in the background, and telling a seller
 * which fix they need when a connection has gone.
 */

import { FakeDb } from "./helpers/fake-supabase";

const db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({ createServerClient: () => db }));
jest.mock("@/lib/security/token-crypto", () => ({
  encrypt: (s: string) => `enc(${s})`,
  decrypt: (s: string) => s.replace(/^enc\((.*)\)$/, "$1"),
}));

const refreshJumiaConnection = jest.fn();
const getValidJumiaCredentials = jest.fn();
jest.mock("@/lib/jumia/api", () => ({
  refreshJumiaConnection: (...args: unknown[]) => refreshJumiaConnection(...args),
  getValidJumiaCredentials: (...args: unknown[]) => getValidJumiaCredentials(...args),
  clearJumiaHealthCache: () => {},
}));

import { connectSelfAuthorization, looksLikeClientId, looksLikeGeneratedToken } from "@/lib/jumia/self-auth";
import { refreshAccessToken } from "@/lib/jumia/oauth";
import { isDueForRenewal, renewExpiringConnections, RENEW_WITHIN_MS } from "@/lib/jumia/keepalive";
import { getJumiaConnectionKind } from "@/lib/jumia/credentials";

const CLIENT_ID = "ed0b5856-3612-5829-b8de-d95774bfcf17";
const jwt = (tag: string) => `eyJhbGciOiJIUzI1NiIsInR5cCIgOiAiSldUIn0.${tag.padEnd(120, "x")}.signature`;
// What Vendor Center's lock icon actually hands out: a short opaque token,
// not the JWT Jumia's docs show (a made-up one of the same shape).
const OPAQUE_TOKEN = "Zq7Rk2Vn8Tw3Xb5Yc9Pd1Lf4Hg6Jm0Ns-Qa_Uv2Ew8Ko";

let tokenCalls: URLSearchParams[] = [];
let tokenResponse: { status: number; body: Record<string, unknown> } = { status: 200, body: {} };

beforeEach(() => {
  db.tables.jumia_connections = [];
  tokenCalls = [];
  refreshJumiaConnection.mockReset();
  getValidJumiaCredentials.mockReset();
  tokenResponse = {
    status: 200,
    body: { access_token: "access-1", expires_in: 86399, refresh_token: jwt("rotated"), refresh_expires_in: 86400 },
  };
  global.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/connect/token")) {
      tokenCalls.push(new URLSearchParams(String(init?.body)));
      return new Response(JSON.stringify(tokenResponse.body), { status: tokenResponse.status });
    }
    if (u.endsWith("/shops")) {
      return new Response(JSON.stringify([{ id: "shop-9", name: "Kelvin's Store", sellerId: "seller-9" }]), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
});

describe("recognising what the seller pasted", () => {
  it("accepts a Client ID and a generated token in either format Jumia uses", () => {
    expect(looksLikeClientId(CLIENT_ID)).toBe(true);
    expect(looksLikeGeneratedToken(OPAQUE_TOKEN)).toBe(true);
    expect(looksLikeGeneratedToken(jwt("a"))).toBe(true);
  });

  it("rejects chat replies", () => {
    expect(looksLikeClientId("Okay")).toBe(false);
    expect(looksLikeGeneratedToken("Okay")).toBe(false);
    expect(looksLikeGeneratedToken("here is my token thanks")).toBe(false);
  });
});

describe("refreshAccessToken", () => {
  it("sends no client secret for a seller's app that has none (Self Authorization)", async () => {
    await refreshAccessToken(jwt("a"), CLIENT_ID, undefined);
    expect(tokenCalls[0].get("grant_type")).toBe("refresh_token");
    expect(tokenCalls[0].get("client_id")).toBe(CLIENT_ID);
    expect(tokenCalls[0].has("client_secret")).toBe(false);
  });

  it("sends the app's own secret when it has one", async () => {
    await refreshAccessToken(jwt("a"), CLIENT_ID, "secret-1");
    expect(tokenCalls[0].get("client_secret")).toBe("secret-1");
  });
});

describe("connectSelfAuthorization", () => {
  it("exchanges the generated token and saves the rotated one, marked as self-renewing", async () => {
    const result = await connectSelfAuthorization("user_1", CLIENT_ID, jwt("generated"), "NG");

    expect(result).toEqual({ ok: true, storeName: "Kelvin's Store" });
    expect(tokenCalls[0].get("refresh_token")).toBe(jwt("generated"));
    expect(db.tables.jumia_connections[0]).toMatchObject({
      user_id:       "user_1",
      auth_type:     "self",
      status:        "active",
      country:       "NG",
      app_id:        CLIENT_ID,
      app_secret:    null,
      shop_id:       "shop-9",
      access_token:  "enc(access-1)",
      refresh_token: `enc(${jwt("rotated")})`,
    });
    expect(db.tables.jumia_connections[0].refresh_token_expires_at).toBeTruthy();
  });

  it("connects with the short token the lock icon hands out", async () => {
    const result = await connectSelfAuthorization("user_1", CLIENT_ID, OPAQUE_TOKEN, "GH");
    expect(result).toMatchObject({ ok: true });
    expect(tokenCalls[0].get("refresh_token")).toBe(OPAQUE_TOKEN);
  });

  it("says when the Client ID is a Web Application's, so WhatsApp can fall back to that flow", async () => {
    for (const refusal of [
      { status: 400, body: { error: "unauthorized_client" } },
      { status: 401, body: { error: "invalid_client" } },
    ]) {
      tokenResponse = refusal;
      const result = await connectSelfAuthorization("user_1", CLIENT_ID, OPAQUE_TOKEN, "GH");
      expect(result).toMatchObject({ ok: false, reason: "web_app", error: expect.stringContaining("Self Authorization") });
    }
    expect(db.tables.jumia_connections).toHaveLength(0);
  });

  it("asks for a new token when Jumia says it's expired or used", async () => {
    tokenResponse = { status: 400, body: { error: "invalid_grant" } };
    const result = await connectSelfAuthorization("user_1", CLIENT_ID, OPAQUE_TOKEN, "GH");
    expect(result).toMatchObject({ ok: false, reason: "bad_token", error: expect.stringContaining("padlock icon") });
  });

  it("rejects something that isn't a token without calling Jumia", async () => {
    const result = await connectSelfAuthorization("user_1", CLIENT_ID, "Okay", "GH");
    expect(result).toMatchObject({ ok: false, reason: "bad_input" });
    expect(tokenCalls).toHaveLength(0);
  });
});

describe("keep-alive", () => {
  const now = Date.parse("2026-09-28T12:00:00Z");
  const inHours = (h: number) => new Date(now + h * 3600_000).toISOString();

  it("renews when either token is within the window, and when an expiry is unknown", () => {
    expect(RENEW_WITHIN_MS).toBe(6 * 3600_000);
    expect(isDueForRenewal({ token_expires_at: inHours(20), refresh_token_expires_at: inHours(20) }, now)).toBe(false);
    expect(isDueForRenewal({ token_expires_at: inHours(5), refresh_token_expires_at: inHours(20) }, now)).toBe(true);
    expect(isDueForRenewal({ token_expires_at: inHours(20), refresh_token_expires_at: inHours(5) }, now)).toBe(true);
    expect(isDueForRenewal({ token_expires_at: inHours(20), refresh_token_expires_at: null }, now)).toBe(true);
  });

  it("renews only due Self Authorization connections, and counts what happened", async () => {
    const row = (user_id: string, extra: Record<string, unknown>) => ({
      user_id, auth_type: "self", status: "active", refresh_token: `enc(${jwt(user_id)})`, app_id: CLIENT_ID,
      token_expires_at: inHours(2), refresh_token_expires_at: inHours(2), ...extra,
    });
    db.tables.jumia_connections = [
      row("due-ok", {}),
      row("due-dead", {}),
      row("due-blip", {}),
      row("not-due", { token_expires_at: inHours(20), refresh_token_expires_at: inHours(20) }),
      row("web", { auth_type: "web", refresh_token: null }),
      row("already-dead", { status: "needs_reconnect" }),
    ];
    refreshJumiaConnection.mockImplementation(async (_db: unknown, userId: string) => {
      if (userId === "due-dead") throw new Error("JUMIA_RECONNECT_REQUIRED");
      if (userId === "due-blip") throw new Error("JUMIA_REFRESH_TRANSIENT");
      return { accessToken: "x", tokenExpiresAt: inHours(24) };
    });

    const result = await renewExpiringConnections(now);

    expect(result).toEqual({ checked: 4, renewed: 1, lost: 1, failed: 1 });
    const renewedUsers = refreshJumiaConnection.mock.calls.map((c) => c[1]).sort();
    expect(renewedUsers).toEqual(["due-blip", "due-dead", "due-ok"]);
    // The decrypted refresh token, the app's Client ID, and no secret.
    const okCall = refreshJumiaConnection.mock.calls.find((c) => c[1] === "due-ok")!;
    expect(okCall.slice(2)).toEqual([jwt("due-ok"), CLIENT_ID, undefined]);
  });
});

describe("getJumiaConnectionKind", () => {
  const past = new Date(Date.now() - 3600_000).toISOString();

  it("catches an expired Web Application connection that still says active", async () => {
    db.tables.jumia_connections = [{ user_id: "u", status: "active", auth_type: "web", access_token: "enc(a)", refresh_token: null, token_expires_at: past }];
    expect(await getJumiaConnectionKind("u")).toBe("needs_reconnect");
  });

  it("asks a Self Authorization seller for a new token when Jumia refused theirs", async () => {
    db.tables.jumia_connections = [{ user_id: "u", status: "needs_reconnect", auth_type: "self", access_token: "enc(a)", refresh_token: "enc(r)", token_expires_at: past }];
    getValidJumiaCredentials.mockRejectedValue(new Error("JUMIA_RECONNECT_REQUIRED"));
    expect(await getJumiaConnectionKind("u")).toBe("needs_new_token");
  });

  it("treats a live Self Authorization connection as connected", async () => {
    db.tables.jumia_connections = [{
      user_id: "u", status: "active", auth_type: "self", access_token: "enc(a)", refresh_token: "enc(r)",
      token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    }];
    expect(await getJumiaConnectionKind("u")).toBe("connected");
  });
});
