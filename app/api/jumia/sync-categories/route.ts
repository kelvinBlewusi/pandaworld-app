import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import { fetchAndCacheCategoryTree } from "@/lib/jumia/categories";

// ─── POST /api/jumia/sync-categories ─────────────────────────────────────────
// User-facing category sync endpoint (non-admin).
// Requires an active Jumia connection with a real access token (not credential_auth).
// Syncs the category list; attribute sync is triggered separately (slow).
//
// Returns: { categories: number, message: string }

export async function POST() {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  const db = createServerClient();

  // Get the user's active Jumia connection
  const { data: conn } = await db
    .from("jumia_connections")
    .select("access_token, status")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();

  if (!conn) {
    return NextResponse.json({ error: "No active Jumia connection found." }, { status: 403 });
  }

  if (!conn.access_token || conn.access_token === "credential_auth") {
    return NextResponse.json(
      {
        error: "OAuth not completed. Your credentials are saved but you need to complete the Jumia OAuth flow to sync categories.",
        needsOAuth: true,
      },
      { status: 403 }
    );
  }

  try {
    const result = await fetchAndCacheCategoryTree(conn.access_token, { syncAttributes: false });
    return NextResponse.json({
      success:    true,
      categories: result.categories,
      message:    `${result.categories} categories synced from Jumia`,
    });
  } catch (e) {
    const msg = (e as Error).message ?? "Unknown error";
    console.error("[sync-categories]", msg);
    return NextResponse.json({ error: `Sync failed: ${msg}` }, { status: 502 });
  }
}

// ─── GET /api/jumia/sync-categories ──────────────────────────────────────────
// Returns the current cached category count and last-synced timestamp.

export async function GET() {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  const db = createServerClient();
  const { count, data } = await db
    .from("jumia_categories")
    .select("synced_at", { count: "exact" })
    .order("synced_at", { ascending: false })
    .limit(1);

  return NextResponse.json({
    count:      count ?? 0,
    lastSynced: data?.[0]?.synced_at ?? null,
  });
}
