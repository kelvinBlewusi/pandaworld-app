/**
 * Regression coverage for the Jumia reconnect-storm fix, 2026-09-20.
 *
 * Live data showed every real jumia_connections row had NEVER had a
 * successful token refresh recorded, and separately that
 * jumia_connections.status could never actually be written as
 * 'needs_reconnect' at all (the table's own check constraint silently
 * rejected it). Both are fixed by the migration + this rewrite of
 * refreshJumiaConnection, the one place a token is ever refreshed now.
 *
 * These tests exercise the contract that matters: a successful refresh
 * always persists whatever Jumia rotated in, two concurrent refreshes for
 * the same connection never both hit Jumia, and only a genuinely
 * definitive auth error — never a network blip, a timeout, or a 5xx —
 * ever flips a seller to needs_reconnect.
 */

jest.mock("@/lib/security/token-crypto", () => ({
  encrypt: (s: string) => s,
  decrypt: (s: string) => s,
}));

import { refreshJumiaConnection, isDefinitiveAuthDeath } from "@/lib/jumia/api";

interface ConnRow {
  user_id:           string;
  access_token:      string;
  refresh_token:     string | null;
  token_expires_at:  string | null;
  status:            string;
  refresh_locked_at: string | null;
}

function makeFakeDb(initial: ConnRow) {
  const table: ConnRow = { ...initial };

  return {
    table,
    async rpc(name: string, args: { p_user_id: string }) {
      if (name !== "claim_jumia_refresh_lock") throw new Error(`unexpected rpc ${name}`);
      if (args.p_user_id !== table.user_id) return { data: [], error: null };
      const locked = !!table.refresh_locked_at
        && Date.now() - new Date(table.refresh_locked_at).getTime() < 30_000;
      if (locked) return { data: [], error: null };
      table.refresh_locked_at = new Date().toISOString();
      return { data: [{ ...table }], error: null };
    },
    from(name: string) {
      if (name !== "jumia_connections") throw new Error(`unexpected table ${name}`);
      return {
        select() {
          return {
            eq(_col: string, val: string) {
              return {
                async maybeSingle() {
                  return { data: val === table.user_id ? { ...table } : null, error: null };
                },
              };
            },
          };
        },
        update(patch: Partial<ConnRow>) {
          return {
            eq(_col: string, val: string) {
              if (val === table.user_id) Object.assign(table, patch);
              return Promise.resolve({ data: null, error: null });
            },
          };
        },
      };
    },
  };
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const activeRow = (): ConnRow => ({
  user_id:           "u1",
  access_token:      "old-access",
  refresh_token:     "old-refresh",
  token_expires_at:  new Date(Date.now() - 1_000).toISOString(),
  status:            "active",
  refresh_locked_at: null,
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe("isDefinitiveAuthDeath", () => {
  it("treats Jumia's documented revocation codes as definitive", () => {
    expect(isDefinitiveAuthDeath(400, "invalid_grant")).toBe(true);
    expect(isDefinitiveAuthDeath(400, "invalid_token")).toBe(true);
    expect(isDefinitiveAuthDeath(401, "unauthorized_client")).toBe(true);
  });

  it("treats a deleted application as definitive, though Jumia calls it a server_error", () => {
    // What Jumia answered every refresh with after a seller deleted their
    // Self Authorization app in Vendor Center (2026-10-04).
    expect(isDefinitiveAuthDeath(400, "server_error", "client not found")).toBe(true);
    expect(isDefinitiveAuthDeath(500, "server_error", "something went wrong")).toBe(false);
  });

  it("treats everything else — including an unrecognised 400 — as transient", () => {
    expect(isDefinitiveAuthDeath(503, undefined)).toBe(false);
    expect(isDefinitiveAuthDeath(500, "server_error")).toBe(false);
    expect(isDefinitiveAuthDeath(400, "some_future_error_code")).toBe(false);
  });
});

describe("refreshJumiaConnection", () => {
  it("rotates and persists the new access + refresh token on success", async () => {
    const db = makeFakeDb(activeRow());
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(200, { access_token: "new-access", refresh_token: "new-refresh", expires_in: 43_200 }),
    ) as unknown as typeof fetch;

    const result = await refreshJumiaConnection(db as never, "u1", "old-refresh", "seller-app", "seller-secret");

    expect(result.accessToken).toBe("new-access");
    expect(db.table.access_token).toBe("new-access");
    expect(db.table.refresh_token).toBe("new-refresh");
    expect(db.table.status).toBe("active");
    expect(db.table.refresh_locked_at).toBeNull();
  });

  it("refreshes with the connection's OWN app credentials, not platform defaults", async () => {
    const db = makeFakeDb(activeRow());
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse(200, { access_token: "new-access", refresh_token: "new-refresh", expires_in: 43_200 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await refreshJumiaConnection(db as never, "u1", "old-refresh", "seller-app-id", "seller-app-secret");

    const [, opts] = fetchMock.mock.calls[0];
    const body = String(opts.body);
    expect(body).toContain("client_id=seller-app-id");
    expect(body).toContain("client_secret=seller-app-secret");
  });

  it("does NOT mark needs_reconnect on a transient 503", async () => {
    const db = makeFakeDb(activeRow());
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(503, {})) as unknown as typeof fetch;

    await expect(
      refreshJumiaConnection(db as never, "u1", "old-refresh", "a", "s"),
    ).rejects.toThrow("JUMIA_REFRESH_TRANSIENT");

    expect(db.table.status).toBe("active");
    expect(db.table.refresh_locked_at).toBeNull();
  });

  it("does NOT mark needs_reconnect on a network failure", async () => {
    const db = makeFakeDb(activeRow());
    global.fetch = jest.fn().mockRejectedValue(new Error("fetch failed: ECONNRESET")) as unknown as typeof fetch;

    await expect(
      refreshJumiaConnection(db as never, "u1", "old-refresh", "a", "s"),
    ).rejects.toThrow("JUMIA_REFRESH_TRANSIENT");

    expect(db.table.status).toBe("active");
    expect(db.table.refresh_locked_at).toBeNull();
  });

  it("marks needs_reconnect only on a definitive invalid_grant", async () => {
    const db = makeFakeDb(activeRow());
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(400, { error: "invalid_grant" })) as unknown as typeof fetch;

    await expect(
      refreshJumiaConnection(db as never, "u1", "old-refresh", "a", "s"),
    ).rejects.toThrow("JUMIA_RECONNECT_REQUIRED");

    expect(db.table.status).toBe("needs_reconnect");
    expect(db.table.refresh_locked_at).toBeNull();
  });

  it("marks needs_reconnect when the seller's application was deleted in Vendor Center", async () => {
    const db = makeFakeDb(activeRow());
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(400, { error: "server_error", error_description: "client not found" }),
    ) as unknown as typeof fetch;

    await expect(
      refreshJumiaConnection(db as never, "u1", "old-refresh", "deleted-app", undefined),
    ).rejects.toThrow("JUMIA_RECONNECT_REQUIRED");

    expect(db.table.status).toBe("needs_reconnect");
  });

  it("only one of two concurrent refreshes calls Jumia; the other reuses its result", async () => {
    jest.useFakeTimers();
    const db = makeFakeDb(activeRow());

    let resolveFetch!: (v: unknown) => void;
    const pending = new Promise((resolve) => { resolveFetch = resolve; });
    global.fetch = jest.fn().mockReturnValue(pending) as unknown as typeof fetch;

    const callA = refreshJumiaConnection(db as never, "u1", "old-refresh", "a", "s");
    // Let call A's lock-claim RPC resolve and reach its (pending) fetch.
    await Promise.resolve();
    await Promise.resolve();

    const callB = refreshJumiaConnection(db as never, "u1", "old-refresh", "a", "s");
    // Let call B's lock-claim RPC resolve (it should lose — A holds it).
    await Promise.resolve();
    await Promise.resolve();

    resolveFetch(jsonResponse(200, { access_token: "new-access", refresh_token: "new-refresh", expires_in: 43_200 }));
    const resultA = await callA;

    // Call B is polling on a timer for the lock to clear — advance past
    // its poll interval so it re-reads the now-fresh row.
    await jest.advanceTimersByTimeAsync(500);
    const resultB = await callB;

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(resultA.accessToken).toBe("new-access");
    expect(resultB.accessToken).toBe("new-access");
    expect(db.table.status).toBe("active");
  });
});
