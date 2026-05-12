import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import {
  getValidJumiaCredentials,
  markNeedsReconnect,
} from "@/lib/jumia/api";
import { JUMIA_API_BASE } from "@/lib/jumia/oauth";

// ─── GET /api/jumia/verify ────────────────────────────────────────────────────
//
// Proactive health check for the seller's Jumia connection. Called by the
// frontend (ReconnectBanner) on every page mount so we detect a dead OAuth
// app within seconds rather than waiting until the seller tries to push a
// listing.
//
// Pipeline:
//   1. getValidJumiaCredentials — auto-refreshes token; marks
//      needs_reconnect on its own if refresh fails.
//   2. Hit GET /shops with the (possibly fresh) token — this is the
//      cheapest endpoint that requires auth. 200 = good, 401/403 = dead.
//   3. On 401/403: mark needs_reconnect, return { ok: false, reason }.
//
// Response shapes:
//   { ok: true }                                  — connection is healthy
//   { ok: false, reason: "not_connected" }        — never connected
//   { ok: false, reason: "oauth_required" }       — credentials saved, no OAuth yet
//   { ok: false, reason: "needs_reconnect" }      — OAuth dead, must redo
//   { ok: false, reason: "no_shop_id" }           — connected but Shop ID missing

export async function GET() {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  const db = createServerClient();

  // Quick DB check first — if there's no row OR status is already
  // needs_reconnect, no need to ping Jumia.
  const { data: conn } = await db
    .from("jumia_connections")
    .select("status, access_token")
    .eq("user_id", userId)
    .maybeSingle();

  if (!conn) {
    return NextResponse.json({ ok: false, reason: "not_connected" });
  }
  if (conn.status === "needs_reconnect") {
    return NextResponse.json({ ok: false, reason: "needs_reconnect" });
  }
  if (conn.access_token === "credential_auth") {
    return NextResponse.json({ ok: false, reason: "oauth_required" });
  }
  if (conn.status === "revoked") {
    return NextResponse.json({ ok: false, reason: "not_connected" });
  }

  // Try to grab a fresh token. If this fails with JUMIA_RECONNECT_REQUIRED,
  // getValidJumiaCredentials has already marked the row as needs_reconnect.
  let accessToken: string;
  try {
    const creds = await getValidJumiaCredentials(userId);
    accessToken = creds.accessToken;
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === "JUMIA_RECONNECT_REQUIRED") {
      return NextResponse.json({ ok: false, reason: "needs_reconnect" });
    }
    if (msg === "JUMIA_OAUTH_REQUIRED") {
      return NextResponse.json({ ok: false, reason: "oauth_required" });
    }
    if (msg === "JUMIA_NO_SHOP_ID") {
      return NextResponse.json({ ok: false, reason: "no_shop_id" });
    }
    return NextResponse.json({ ok: false, reason: "error", detail: msg });
  }

  // Ping the lightest authed endpoint we can. /shops requires a valid
  // token and returns quickly. Anything other than 200 ⇒ the token is bad.
  try {
    const res = await fetch(`${JUMIA_API_BASE}/shops`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      signal:  AbortSignal.timeout(8_000),
    });
    if (res.status === 401 || res.status === 403) {
      await markNeedsReconnect(db, userId);
      return NextResponse.json({ ok: false, reason: "needs_reconnect" });
    }
    if (!res.ok) {
      return NextResponse.json({ ok: false, reason: "error", detail: `Jumia /shops returned ${res.status}` });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: "error", detail: (e as Error).message });
  }
}
