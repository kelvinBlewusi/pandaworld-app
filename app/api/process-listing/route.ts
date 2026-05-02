import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { uploadProductImages } from "@/lib/actions/upload";
import { analyzeProductImages, analyzeProductDescription } from "@/lib/actions/ai";
import { createListing, updateListing } from "@/lib/actions/listings";

/**
 * POST /api/process-listing
 *
 * Multipart form fields:
 *   mode          "own" | "ai" | "url"
 *   files[]       image File objects (own / ai-ref modes)
 *   description   text description (ai text mode)
 *
 * Returns: { listingId: string }
 */
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  try {
    const formData = await req.formData();
    const mode = formData.get("mode") as string;

    // ── Step 1: Upload images ────────────────────────────────────────────────
    let imageUrls: string[] = [];
    const files = formData.getAll("files") as File[];

    if (files.length > 0) {
      const uploadForm = new FormData();
      files.forEach((f) => uploadForm.append("files", f));
      imageUrls = await uploadProductImages(uploadForm);
    }

    // ── Step 2: AI analysis ──────────────────────────────────────────────────
    let analysis;
    const description = formData.get("description") as string | null;

    if (mode === "ai" && description && !files.length) {
      // Text description mode
      analysis = await analyzeProductDescription(description);
    } else if (imageUrls.length > 0) {
      // Vision mode — use uploaded images
      analysis = await analyzeProductImages(imageUrls);
    } else {
      throw new Error("No images or description provided");
    }

    // ── Step 3: Create listing in DB ─────────────────────────────────────────
    const listing = await createListing({
      title: analysis.title,
      images: imageUrls,
      category_id: analysis.category_id,
      category_path: analysis.category_path,
      category_code: analysis.category_code,
      commission_rate: analysis.commission_rate,
    });

    // ── Step 4: Populate all AI fields ───────────────────────────────────────
    await updateListing(listing.id, {
      description: analysis.description,
      highlights: analysis.highlights,
      brand: analysis.brand || null,
      color: analysis.color || null,
      color_family: analysis.color_family || null,
      weight_kg: analysis.weight_kg,
      model: analysis.model || null,
      main_material: analysis.main_material || null,
      material_family: analysis.material_family || null,
      selling_price: analysis.selling_price,
      status: "draft",
    });

    return NextResponse.json({
      listingId: listing.id,
      title: analysis.title,
      category: analysis.category_path,
      brand: analysis.brand || null,
      color: analysis.color || null,
      weight_kg: analysis.weight_kg,
      selling_price: analysis.selling_price,
    });
  } catch (err) {
    console.error("process-listing error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Processing failed" },
      { status: 500 }
    );
  }
}
