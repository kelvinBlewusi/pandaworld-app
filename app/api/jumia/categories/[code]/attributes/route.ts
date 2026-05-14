import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import {
  getCategoryAttributes,
  getCategoryByCode,
  fetchAttributesFromJumia,
  upsertAttributes,
} from "@/lib/jumia/categories";
import { getValidJumiaCredentials } from "@/lib/jumia/api";

// ─── GET /api/jumia/categories/[code]/attributes ──────────────────────────────
//
// Returns the attribute schema for a Jumia category from Supabase cache. On
// cache miss, transparently fetches that one category's attributes from
// Jumia, stores them, and returns them in the same response. This means the
// review form NEVER shows an empty-state "no fields cached" prompt — the
// schema is always live by the time the user lands on the page.
//
// Response: { attributes: JumiaCategoryAttribute[], source: "cache" | "live" }

export async function GET(
  _req: NextRequest,
  { params }: { params: { code: string } }
) {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  const code = parseInt(params.code, 10);
  if (isNaN(code)) {
    return NextResponse.json({ error: "Invalid category code" }, { status: 400 });
  }

  // 1. Try the cache first — this is the hot path. ~5ms.
  let attributes = await getCategoryAttributes(code);
  if (attributes.length > 0) {
    return NextResponse.json({ attributes, source: "cache" });
  }

  // 2. Cache miss → fetch this one category's schema from Jumia and store it.
  //    Slow path (~500-900ms) but only ever runs once per category per seller.
  const category = await getCategoryByCode(code);
  if (!category) {
    return NextResponse.json({ error: "Unknown category code" }, { status: 404 });
  }
  if (!category.attribute_set_sid) {
    // Category exists but Jumia didn't expose an attribute_set — return
    // empty schema (the form will render no fields, which is correct).
    return NextResponse.json({ attributes: [], source: "live" });
  }

  try {
    const { accessToken } = await getValidJumiaCredentials(userId);
    attributes = await fetchAttributesFromJumia(accessToken, category.attribute_set_sid);
    if (attributes.length > 0) {
      await upsertAttributes(code, attributes);
    }
    return NextResponse.json({ attributes, source: "live" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    // Surface auth / reconnect errors distinctly so the client can route to
    // the onboarding banner instead of showing a vague failure.
    if (msg.startsWith("JUMIA_AUTH_FAILED") || msg.includes("RECONNECT")) {
      return NextResponse.json(
        { error: "JUMIA_RECONNECT_REQUIRED", attributes: [] },
        { status: 401 }
      );
    }
    console.error(`[attributes] live fetch failed for category ${code}:`, msg);
    // Graceful fallback: empty schema (form renders nothing) rather than
    // breaking the whole review page.
    return NextResponse.json({ attributes: [], source: "live", warning: msg });
  }
}
