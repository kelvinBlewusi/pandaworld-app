import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";

// ─── POST /api/jumia/save-credentials ─────────────────────────────────────────
// Saves the user's Jumia credentials after a successful test.
// Tries to save app_id/app_secret/country (requires migration); if those
// columns don't exist yet, falls back to saving just store_name + status
// so the user can still pass the onboarding gate.

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  const { appId, secretKey, storeName, country } = await req.json();

  if (!appId || !secretKey) {
    return NextResponse.json({ error: "App ID and Secret Key are required." }, { status: 400 });
  }

  const db  = createServerClient();
  const now = new Date().toISOString();

  // Try full upsert (requires add_onboarding.sql migration)
  const { error: fullError } = await db.from("jumia_connections").upsert(
    {
      user_id:      userId,
      app_id:       appId,
      app_secret:   secretKey,
      store_name:   storeName || "Jumia Store",
      country:      country ?? "GH",
      status:       "active",
      connected_at: now,
      updated_at:   now,
    },
    { onConflict: "user_id" }
  );

  if (!fullError) return NextResponse.json({ ok: true });

  console.warn("[save-credentials] Full upsert failed, trying minimal:", fullError.code, fullError.message);

  // Column-not-found means migration hasn't run — fall back to columns we know exist
  const isMissingColumn = fullError.code === "42703" || fullError.message?.includes("column");
  if (!isMissingColumn) {
    console.error("[save-credentials] Unexpected DB error:", fullError);
    return NextResponse.json({ error: "Failed to save credentials. Please try again." }, { status: 500 });
  }

  // Minimal upsert — works without migration
  const { error: minError } = await db.from("jumia_connections").upsert(
    {
      user_id:      userId,
      store_name:   storeName || "Jumia Store",
      status:       "active",
      connected_at: now,
    },
    { onConflict: "user_id" }
  );

  if (minError) {
    console.error("[save-credentials] Minimal upsert also failed:", minError);
    return NextResponse.json({ error: "Failed to save credentials. Please try again." }, { status: 500 });
  }

  // Saved OK, but remind them to run the migration so full credentials persist
  return NextResponse.json({ ok: true, migrationPending: true });
}
