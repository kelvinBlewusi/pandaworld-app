import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import { revokeToken } from "@/lib/jumia/oauth";

// ─── POST /api/jumia/disconnect ───────────────────────────────────────────────
// Revokes the Jumia access token, then DELETES the connection row so that:
//  - The user's store data is fully removed
//  - The root page redirect (app/page.tsx) sends them back to onboarding

export async function POST() {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  const db = createServerClient();

  // Fetch tokens first so we can revoke them with Jumia
  const { data: conn } = await db
    .from("jumia_connections")
    .select("access_token, refresh_token")
    .eq("user_id", userId)
    .maybeSingle();

  // Best-effort token revocation (don't fail if Jumia is unreachable)
  if (conn?.access_token && conn.access_token !== "credential_auth") {
    await revokeToken(conn.access_token);
  }
  if (conn?.refresh_token) {
    await revokeToken(conn.refresh_token);
  }

  // Delete the row entirely — this clears all shop data and
  // causes the root page to redirect the user to /onboarding/channel on next login
  const { error } = await db
    .from("jumia_connections")
    .delete()
    .eq("user_id", userId);

  if (error) {
    console.error("[Jumia] Disconnect DB error:", error);
    return NextResponse.json({ success: false, error: "Database error" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
