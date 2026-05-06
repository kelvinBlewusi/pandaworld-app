import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import {
  getCategoryAttributes,
  fetchAttributesFromJumia,
  upsertAttributes,
  type JumiaCategoryAttribute,
} from "@/lib/jumia/categories";

// Cache TTL: re-fetch from Jumia API if cache is older than this
const CACHE_TTL_HOURS = 24;

// ─── POST /api/listings/category-attributes ───────────────────────────────────
// Cache-first attribute fetch. If the cache is stale or empty, calls the
// live Jumia API (requires a connected store) and refreshes the cache.
//
// Body: { categoryId: string, storeId?: string }
// Response: { attributes: JumiaCategoryAttribute[], fromCache: boolean }

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  const { categoryId } = await req.json() as { categoryId: string; storeId?: string };

  if (!categoryId) {
    return NextResponse.json({ error: "categoryId is required" }, { status: 400 });
  }

  const categoryCode = parseInt(categoryId, 10);
  if (isNaN(categoryCode)) {
    return NextResponse.json({ error: "categoryId must be a numeric Jumia category code" }, { status: 400 });
  }

  // ── 1. Check cache freshness ──────────────────────────────────────────────
  const db = createServerClient();

  const { data: cached } = await db
    .from("jumia_category_attributes")
    .select("synced_at")
    .eq("category_code", categoryCode)
    .limit(1)
    .maybeSingle();

  const cacheAge = cached?.synced_at
    ? (Date.now() - new Date(cached.synced_at).getTime()) / (1000 * 60 * 60)
    : Infinity;

  // Cache is fresh — return from DB
  if (cacheAge < CACHE_TTL_HOURS) {
    const attributes = await getCategoryAttributes(categoryCode);
    return NextResponse.json({ attributes, fromCache: true });
  }

  // ── 2. Cache is stale — try to fetch live from Jumia ─────────────────────
  // Get the attributeSet sid for this category
  const { data: cat } = await db
    .from("jumia_categories")
    .select("attribute_set_sid, name")
    .eq("code", categoryCode)
    .maybeSingle();

  if (!cat?.attribute_set_sid) {
    // No attribute_set_sid available — return cached (possibly empty) data
    const attributes = await getCategoryAttributes(categoryCode);
    return NextResponse.json({ attributes, fromCache: true });
  }

  // Get the user's Jumia access token
  const { data: conn } = await db
    .from("jumia_connections")
    .select("access_token, status")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();

  // No active connection or credential-based connection (no real token)
  if (!conn?.access_token || conn.access_token === "credential_auth") {
    const attributes = await getCategoryAttributes(categoryCode);
    return NextResponse.json({ attributes, fromCache: true, note: "Jumia not connected; serving cached data" });
  }

  // ── 3. Live fetch and re-cache ────────────────────────────────────────────
  let freshAttributes: JumiaCategoryAttribute[] = [];
  try {
    freshAttributes = await fetchAttributesFromJumia(conn.access_token, cat.attribute_set_sid);
    if (freshAttributes.length > 0) {
      await upsertAttributes(categoryCode, freshAttributes);
    }
    return NextResponse.json({ attributes: freshAttributes, fromCache: false });
  } catch (e) {
    console.warn("[category-attributes] Live fetch failed, using cache:", e);
    const attributes = await getCategoryAttributes(categoryCode);
    return NextResponse.json({ attributes, fromCache: true });
  }
}
