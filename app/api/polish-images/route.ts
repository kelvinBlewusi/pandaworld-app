import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import { polishImages, isPhotoRoomEnabled } from "@/lib/photoroom";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

// ─── POST /api/polish-images ──────────────────────────────────────────────────
//
// Polishes the images on a listing using PhotoRoom:
//   - removes the background
//   - replaces with white (or transparent if requested)
//   - adds a soft AI shadow
//   - centers the product with padding
//   - resizes to 2000×2000 JPG (Jumia-compliant)
//
// Body: { listingId: string, background?: "white" | "transparent" }
// Returns: { polished: string[], errors: string[], replaced: number }

export async function POST(req: NextRequest) {
  if (!isPhotoRoomEnabled()) {
    return NextResponse.json(
      { error: "Image polishing not available — PHOTOROOM_API_KEY is not configured." },
      { status: 503 }
    );
  }

  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  // Rate limit — PhotoRoom is paid per image (~$0.025-0.05). Less
  // expensive than Gemini image-gen, so a looser cap.
  const blocked = checkRateLimit(`polish-images:${userId}`, RATE_LIMITS.polishImages);
  if (blocked) return blocked;

  let listingId: string;
  let background: "white" | "transparent" = "white";

  try {
    const body = await req.json();
    listingId = body.listingId;
    if (!listingId) throw new Error("missing listingId");
    if (body.background === "transparent") background = "transparent";
  } catch {
    return NextResponse.json({ error: "listingId is required" }, { status: 400 });
  }

  const db = createServerClient();

  // Fetch listing — must belong to this user
  const { data: listing, error: listingErr } = await db
    .from("listings")
    .select("id, images")
    .eq("id", listingId)
    .eq("user_id", userId)
    .single();

  if (listingErr || !listing) {
    return NextResponse.json({ error: "Listing not found" }, { status: 404 });
  }

  const sourceUrls = (listing.images ?? []) as string[];
  if (sourceUrls.length === 0) {
    return NextResponse.json({ error: "Listing has no images to polish" }, { status: 400 });
  }

  // Polish each image (parallel, up to 4 at a time)
  const { polished, errors } = await polishImages(sourceUrls, userId, { background });

  // Update listing.images with the polished URLs (preserving order)
  await db
    .from("listings")
    .update({ images: polished, updated_at: new Date().toISOString() })
    .eq("id", listingId);

  const replaced = polished.filter((u, i) => u !== sourceUrls[i]).length;

  return NextResponse.json({
    polished,
    errors,
    replaced,
    total: sourceUrls.length,
  });
}
