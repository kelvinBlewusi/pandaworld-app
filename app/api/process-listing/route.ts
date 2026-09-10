import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { uploadProductImages } from "@/lib/actions/upload";
import { createListing, updateListing } from "@/lib/actions/listings";

/**
 * POST /api/process-listing
 *
 * Creates a bare draft listing from uploaded images (or, for the
 * text-to-image flow, zero images — the seller generates one afterwards via
 * /api/generate-product-image). The actual AI analysis runs separately via
 * /api/listings/[id]/auto-analyze, called right after this returns — see
 * app/(main)/listings/new/batch/page.tsx and .../text/page.tsx, the only two
 * live callers, both of which always send skipAnalysis=true.
 *
 * (A URL-scrape mode and a one-shot own-images/AI analysis path used to live
 * here too, from before the batch/auto-analyze split existed. Removed: no UI
 * caller has set mode to anything but "own", or omitted skipAnalysis, since
 * that split shipped — see lib/scraper.ts's git history for the URL-import
 * version if it's ever needed again.)
 *
 * Multipart form fields:
 *   files[]         image File objects
 *   skipAnalysis    must be "true" — the only supported mode now
 *   textToImage     "true" allows zero images (text-to-image flow)
 *   name            optional manual title override
 *   categoryCode    optional manual category override
 *   categoryPath    optional manual category override
 *   userPrompt      optional "what do you want in the listing" free text
 *
 * Returns: { listingId, title, category, skipAnalysis: true }
 */
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  try {
    const formData = await req.formData();

    // Step 1: Upload images
    let imageUrls: string[] = [];
    const files = formData.getAll("files") as File[];
    if (files.length > 0) {
      const uploadForm = new FormData();
      files.forEach((f) => uploadForm.append("files", f));
      imageUrls = await uploadProductImages(uploadForm);
    }

    const manualName        = (formData.get("name")          as string | null)?.trim() || null;
    const manualCategoryCode = (formData.get("categoryCode") as string | null)?.trim() || null;
    const manualCategoryPath = (formData.get("categoryPath") as string | null)?.trim() || null;

    // For text-to-image mode we accept zero images — the seller will
    // generate the image via /api/generate-product-image which appends
    // to listing.images. Every other caller still requires at least one
    // source image.
    const allowEmptyImages = (formData.get("textToImage") as string | null) === "true";
    if (imageUrls.length === 0 && !allowEmptyImages) {
      throw new Error("At least one image is required");
    }
    const listing = await createListing({
      title:         manualName ?? undefined,
      images:        imageUrls,
      category_id:   manualCategoryCode ?? undefined,
      category_code: manualCategoryCode ?? undefined,
      category_path: manualCategoryPath ?? undefined,
    });

    // Persist the seller's "what do you want in the listing" prompt
    // so re-runs honour it without forcing the seller to retype.
    // Done as a separate UPDATE because createListing doesn't accept
    // user_prompt yet (would require a wider type change).
    const userPrompt = (formData.get("userPrompt") as string | null)?.trim();
    if (userPrompt) {
      await updateListing(listing.id, {
        user_prompt: userPrompt.slice(0, 1000),
      });
    }

    return NextResponse.json({
      listingId:    listing.id,
      title:        manualName,
      category:     manualCategoryPath,
      skipAnalysis: true,
    });
  } catch (err) {
    console.error("process-listing error:", err);
    const message = err instanceof Error ? err.message : "Processing failed";
    // 402 Payment Required = "you've hit your monthly quota; upgrade to continue".
    // Recognise both the new QUOTA_EXCEEDED prefix and the legacy
    // FREE_LIMIT_REACHED one in case any older client is still parsing
    // by the old name.
    const isQuotaError =
      message.startsWith("QUOTA_EXCEEDED") ||
      message.startsWith("FREE_LIMIT_REACHED");
    const status = isQuotaError ? 402 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
