import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";

// ─── GET /api/listings/batch?ids=a,b,c ────────────────────────────────────────
//
// Returns minimal sibling info for a set of listing IDs — used by the review
// page's product-switcher pills so the seller can hop between products
// they just created in a batch (mirroring the batch-upload tab bar).
//
// Response: [{ id, title, sku, status, thumbnail }]
//
// Respects ownership: only returns listings owned by the calling user.
// Preserves the order of `ids` in the query string so prdt1 → prdt2 → prdt3
// stays predictable.

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  const idsParam = req.nextUrl.searchParams.get("ids") ?? "";
  const ids = idsParam.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 50);
  if (ids.length === 0) {
    return NextResponse.json({ listings: [] });
  }

  const db = createServerClient();
  const { data } = await db
    .from("listings")
    .select("id, title, sku, status, images")
    .eq("user_id", userId)
    .in("id", ids);

  // Sort by the order of `ids` in the request so the UI tab order is stable
  const byId = new Map((data ?? []).map((row) => [row.id as string, row]));
  const listings = ids
    .map((id) => byId.get(id))
    .filter((r): r is NonNullable<typeof r> => r != null)
    .map((r) => ({
      id:        r.id,
      title:     r.title ?? "",
      sku:       r.sku,
      status:    r.status,
      thumbnail: Array.isArray(r.images) && r.images.length > 0 ? r.images[0] : null,
    }));

  return NextResponse.json({ listings });
}
