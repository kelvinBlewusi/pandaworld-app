import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import type { JumiaConnectionPublic } from "@/lib/types/jumia";

// ─── GET /api/jumia/status ────────────────────────────────────────────────────
// Returns the current user's Jumia connection status.
// Never exposes tokens to the client.

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const db = createServerClient();
  const { data, error } = await db
    .from("jumia_connections")
    .select(
      "status, auth_type, access_token, refresh_token, seller_name, seller_email, store_name, seller_id, connected_at, token_expires_at"
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("[Jumia] Status fetch error:", error);
    return NextResponse.json({ connected: false, status: null } as JumiaConnectionPublic);
  }

  if (!data) {
    return NextResponse.json({
      connected:        false,
      status:           null,
      seller_name:      null,
      seller_email:     null,
      store_name:       null,
      seller_id:        null,
      connected_at:     null,
      token_expires_at: null,
    } satisfies JumiaConnectionPublic);
  }

  // oauth_required = credentials saved but OAuth flow not yet completed
  const oauthRequired   = data.access_token === "credential_auth";
  // needs_reconnect = OAuth was completed but refresh failed (usually
  // because the seller deleted the app from Vendor Center → Applications).
  // UI shows a persistent banner directing back to onboarding.
  //
  // Also true for a connection whose access token has run out with nothing
  // to renew it: a Web Application never gets a refresh token, so its row
  // still says "active" long after it stopped working, and only the next
  // push would find out. Reported as it is instead of "Connected".
  const tokenDead = !data.refresh_token
    && !!data.token_expires_at
    && new Date(data.token_expires_at as string).getTime() <= Date.now();
  const needsReconnect  = data.status === "needs_reconnect" || (!oauthRequired && tokenDead);

  return NextResponse.json({
    connected:        data.status === "active" && !oauthRequired && !tokenDead,
    oauth_required:   oauthRequired,
    needs_reconnect:  needsReconnect,
    auth_type:        data.auth_type === "self" ? "self" : "web",
    status:           data.status,
    seller_name:      data.seller_name,
    seller_email:     data.seller_email,
    store_name:       data.store_name,
    seller_id:        data.seller_id,
    connected_at:     data.connected_at,
    token_expires_at: data.token_expires_at,
  } satisfies JumiaConnectionPublic);
}
