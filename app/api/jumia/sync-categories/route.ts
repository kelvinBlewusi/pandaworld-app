import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import { fetchAndCacheCategoryTree } from "@/lib/jumia/categories";
import { getValidJumiaCredentials } from "@/lib/jumia/api";

// Category-list-only sync walks ~10 pages with 260ms rate-limit delays
// between them — typically 5-10s. We allow 60s as the Hobby-tier ceiling
// for safety margin on slow Jumia API responses.
export const maxDuration = 60;

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

  // Use getValidJumiaCredentials which auto-refreshes tokens and marks
  // the connection as needs_reconnect if refresh fails (deleted app).
  let accessToken: string;
  try {
    const creds = await getValidJumiaCredentials(userId);
    accessToken = creds.accessToken;
  } catch (e) {
    const msg = (e as Error).message ?? "Unknown error";
    if (msg === "JUMIA_RECONNECT_REQUIRED" || msg === "JUMIA_OAUTH_REQUIRED") {
      return NextResponse.json(
        {
          error: "Jumia authorization expired. Please reconnect — your OAuth app may have been deleted from Vendor Center → Applications.",
          needsReconnect: true,
        },
        { status: 401 }
      );
    }
    if (msg === "JUMIA_NOT_CONNECTED") {
      return NextResponse.json({ error: "Jumia not connected." }, { status: 403 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  try {
    const result = await fetchAndCacheCategoryTree(accessToken, { syncAttributes: false });
    return NextResponse.json({
      success:    true,
      categories: result.categories,
      message:    `${result.categories} categories synced from Jumia`,
    });
  } catch (e) {
    const msg = (e as Error).message ?? "Unknown error";
    console.error("[sync-categories]", msg);

    // 401 from Jumia after a successful refresh = something else is wrong
    // (revoked token, deleted app). Mark needs_reconnect so the UI prompts.
    if (msg.includes("401") || msg.toLowerCase().includes("unauthor")) {
      await db.from("jumia_connections").update({
        status:     "needs_reconnect",
        updated_at: new Date().toISOString(),
      }).eq("user_id", userId);
      return NextResponse.json(
        {
          error: "Jumia rejected the request (401). Your OAuth app may have been deleted — please reconnect.",
          needsReconnect: true,
        },
        { status: 401 }
      );
    }

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
