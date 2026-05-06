import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import { buildAuthorizationUrl } from "@/lib/jumia/oauth";

// ─── GET /api/jumia/connect ───────────────────────────────────────────────────
// Looks up the seller's stored app_id, builds the Jumia OAuth authorization
// URL using it as the client_id, and redirects the browser there.

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const appUrl  = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3002";
  const failUrl = `${appUrl}/settings/integrations?jumia_error=`;

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

  // ── Build redirect URI ─────────────────────────────────────────────────────
  const redirectUri = `${appUrl}/api/jumia/callback`;

  // ── Generate CSRF state — encodes userId + nonce ──────────────────────────
  const nonce = crypto.randomUUID();
  const state = Buffer.from(
    JSON.stringify({ userId, nonce, storeName: conn.store_name ?? "" })
  ).toString("base64url");

  const authUrl = buildAuthorizationUrl(state, conn.app_id, redirectUri);

  return NextResponse.redirect(authUrl);
}
