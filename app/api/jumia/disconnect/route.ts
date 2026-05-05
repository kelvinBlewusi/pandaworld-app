import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import { revokeToken } from "@/lib/jumia/oauth";

// ─── POST /api/jumia/disconnect ───────────────────────────────────────────────
// Revokes the Jumia access token with Jumia Connect IdM, then marks the
// connection as revoked in Supabase.

export async function POST() {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  const db = createServerClient();

  // Fetch the stored tokens so we can revoke them
  const { data: conn } = await db
    .from("jumia_connections")
    .select("access_token, refresh_token")
    .eq("user_id", userId)
    .maybeSingle();

  if (conn?.access_token) {
    await revokeToken(conn.access_token);
  }
  if (conn?.refresh_token) {
    await revokeToken(conn.refresh_token);
  }

  const { error } = await db
    .from("jumia_connections")
    .update({ status: "revoked", updated_at: new Date().toISOString() })
    .eq("user_id", userId);

  if (error) {
    console.error("[Jumia] Disconnect DB error:", error);
    return NextResponse.json({ success: false, error: "Database error" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
