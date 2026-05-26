import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import { uploadProductImages } from "@/lib/actions/upload";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

// ─── POST /api/listings/[id]/images ─────────────────────────────────────────
//
// Append one or more uploaded images to an existing listing's `images`
// array. Used by the review page so sellers can add MORE photos after
// AI analysis (the "+" tiles in the 8-slot grid weren't wired up before).
//
// Body: multipart/form-data
//   files[]   the File objects to upload (1 or more)
//
// Limits:
//   - Auth required (ownership enforced via listings.user_id = userId)
//   - Reuses uploadProductImages's MIME / size validation
//   - Caps total per-listing images at 8 (matches Jumia's slot limit)
//   - Reuses the standard upload rate limit
//
// Returns: { images: string[] }  // the listing's NEW full images array
//                                  after appending (or 4xx with error)

const MAX_LISTING_IMAGES = 8;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  // Re-use the polish rate limit bucket — image upload is cheaper but
  // the limit (50/hour) is appropriate for protecting Storage from
  // accidental spam (e.g. a stuck retry loop).
  const blocked = checkRateLimit(`add-image:${userId}`, RATE_LIMITS.polishImages);
  if (blocked) return blocked;

  const { id: listingId } = await params;
  if (!listingId) {
    return NextResponse.json({ error: "Missing listing id" }, { status: 400 });
  }

  const db = createServerClient();

  // 1. Verify ownership + fetch current images
  const { data: listing, error: listingErr } = await db
    .from("listings")
    .select("id, images")
    .eq("id", listingId)
    .eq("user_id", userId)
    .single();

  if (listingErr || !listing) {
    return NextResponse.json({ error: "Listing not found" }, { status: 404 });
  }

  const current = (listing.images ?? []) as string[];

  // 2. Enforce per-listing image cap
  if (current.length >= MAX_LISTING_IMAGES) {
    return NextResponse.json(
      {
        error:  `This listing already has ${MAX_LISTING_IMAGES} images (Jumia's max). Remove one first.`,
        images: current,
      },
      { status: 409 },
    );
  }

  // 3. Parse multipart body. We delegate validation + storage write to
  //    uploadProductImages which already handles magic-byte checks,
  //    size caps, and Supabase upload.
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message ?? "Invalid form body" },
      { status: 400 },
    );
  }

  // Trim incoming files to whatever space we have left in the slot grid.
  const incoming = formData.getAll("files") as File[];
  if (incoming.length === 0) {
    return NextResponse.json({ error: "No files provided" }, { status: 400 });
  }
  const slotsLeft = MAX_LISTING_IMAGES - current.length;
  if (incoming.length > slotsLeft) {
    // Build a new FormData with only the first slotsLeft files. We
    // can't mutate the incoming files list directly.
    const trimmed = new FormData();
    for (const f of incoming.slice(0, slotsLeft)) trimmed.append("files", f);
    formData = trimmed;
  }

  // 4. Upload to Supabase Storage
  let uploaded: string[];
  try {
    uploaded = await uploadProductImages(formData);
  } catch (e) {
    return NextResponse.json(
      { error: `Upload failed: ${(e as Error).message}` },
      { status: 500 },
    );
  }

  if (uploaded.length === 0) {
    return NextResponse.json(
      { error: "All uploaded files were rejected (size or type). Use JPG/PNG/WEBP under 5 MB." },
      { status: 400 },
    );
  }

  // 5. Append to listing.images
  const next = [...current, ...uploaded].slice(0, MAX_LISTING_IMAGES);

  const { error: updateErr } = await db
    .from("listings")
    .update({ images: next, updated_at: new Date().toISOString() })
    .eq("id", listingId);

  if (updateErr) {
    return NextResponse.json(
      { error: `Listing update failed: ${updateErr.message}`, uploaded_urls: uploaded },
      { status: 500 },
    );
  }

  return NextResponse.json({ images: next });
}

// ─── DELETE /api/listings/[id]/images?url=<url> ─────────────────────────────
//
// Remove a single image from a listing's images array. We don't delete
// the underlying storage object (it might be referenced elsewhere or be
// useful as audit history); we just unlink it from the listing.

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  const { id: listingId } = await params;
  if (!listingId) {
    return NextResponse.json({ error: "Missing listing id" }, { status: 400 });
  }

  const target = req.nextUrl.searchParams.get("url");
  if (!target) {
    return NextResponse.json({ error: "Missing ?url= parameter" }, { status: 400 });
  }

  const db = createServerClient();

  const { data: listing, error: listingErr } = await db
    .from("listings")
    .select("id, images")
    .eq("id", listingId)
    .eq("user_id", userId)
    .single();

  if (listingErr || !listing) {
    return NextResponse.json({ error: "Listing not found" }, { status: 404 });
  }

  const current = (listing.images ?? []) as string[];
  const next    = current.filter((u) => u !== target);

  if (next.length === current.length) {
    return NextResponse.json({ error: "Image URL not found on this listing" }, { status: 404 });
  }

  const { error: updateErr } = await db
    .from("listings")
    .update({ images: next, updated_at: new Date().toISOString() })
    .eq("id", listingId);

  if (updateErr) {
    return NextResponse.json(
      { error: `Listing update failed: ${updateErr.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ images: next });
}
