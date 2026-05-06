import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";

// ─── POST /api/jumia/save-credentials ─────────────────────────────────────────
// Saves the user's per-app Jumia credentials after a successful test.
// Upserts a row in jumia_connections with status="active".

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  const { appId, secretKey, storeName, country } = await req.json();

  if (!appId || !secretKey) {
    return NextResponse.json({ error: "App ID and Secret Key are required." }, { status: 400 });
  }

  const db = createServerClient();

  const { error } = await db.from("jumia_connections").upsert(
    {
      user_id:      userId,
      app_id:       appId,
      app_secret:   secretKey,
      store_name:   storeName || "Jumia Store",
      country:      country ?? "GH",
      status:       "active",
      connected_at: new Date().toISOString(),
      updated_at:   new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );

  if (error) {
    console.error("[save-credentials] DB error:", error);

    // Gracefully handle missing columns (migration not yet run)
    if (error.code === "42703") {
      return NextResponse.json(
        { error: "Database migration pending. Please run supabase/add_onboarding.sql first." },
        { status: 500 }
      );
    }

    return NextResponse.json({ error: "Failed to save credentials." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
