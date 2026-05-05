import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { uploadProductImages, uploadRemoteImages } from "@/lib/actions/upload";
import { analyzeProductImages, analyzeProductDescription } from "@/lib/actions/ai";
import { createListing, updateListing } from "@/lib/actions/listings";
import { scrapeProductUrl } from "@/lib/scraper";

/**
 * POST /api/process-listing
 *
 * Multipart form fields:
 *   mode          "own" | "ai" | "url"
 *   files[]       image File objects (own / ai-ref modes)
 *   description   text description (ai text mode)
 *   url           product URL to scrape (url mode)
 *
 * Returns: { listingId, title, category, brand, color, weight_kg, selling_price }
 */
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  try {
    const formData = await req.formData();
    const mode = formData.get("mode") as string;

    // ─────────────────────────────────────────────────────────────────────────
    // URL IMPORT MODE
    // ─────────────────────────────────────────────────────────────────────────
    if (mode === "url") {
      const rawUrl = (formData.get("url") as string | null)?.trim();
      if (!rawUrl) {
        return NextResponse.json({ error: "No URL provided" }, { status: 400 });
      }

      // 1 — Scrape the product page
      const scraped = await scrapeProductUrl(rawUrl);

      if (scraped.imageUrls.length === 0 && !scraped.title && !scraped.description) {
        return NextResponse.json(
          { error: "Could not extract product data from that URL. Try a different link." },
          { status: 422 }
        );
      }

      // 2 — Download & re-upload scraped images to our storage
      let imageUrls: string[] = [];
      if (scraped.imageUrls.length > 0) {
        imageUrls = await uploadRemoteImages(scraped.imageUrls, userId);
      }

      // 3 — AI analysis
      //     If we have images → vision mode.
      //     If no images but we have title/description → text mode.
      let analysis;
      if (imageUrls.length > 0) {
        analysis = await analyzeProductImages(imageUrls);
      } else if (scraped.title || scraped.description) {
        const textInput = [scraped.title, scraped.description]
          .filter(Boolean)
          .join(". ");
        analysis = await analyzeProductDescription(textInput);
      } else {
        return NextResponse.json(
          { error: "No images or text found at that URL." },
          { status: 422 }
        );
      }

      // 4 — Prefer scraped metadata over AI where available
      //     (source page data is usually more accurate for brand/price)
      const finalBrand   = scraped.brand        ?? analysis.brand;
      const finalPrice   = scraped.price        ?? analysis.selling_price;
      const finalTitle   = scraped.title        ?? analysis.title;
      const finalDesc    = scraped.description  ?? analysis.description;

      // 5 — Persist listing
      const listing = await createListing({
        title:           finalTitle ?? analysis.title,
        images:          imageUrls,
        category_id:     analysis.category_id,
        category_path:   analysis.category_path,
        category_code:   analysis.category_code,
        commission_rate: analysis.commission_rate,
      });

      await updateListing(listing.id, {
        description:        finalDesc ?? analysis.description,
        highlights:         analysis.highlights,
        brand:              finalBrand  || null,
        color:              analysis.color || null,
        color_family:       analysis.color_family || null,
        weight_kg:          analysis.weight_kg,
        model:              analysis.model || null,
        main_material:      analysis.main_material || null,
        material_family:    analysis.material_family || null,
        selling_price:      finalPrice ?? null,
        dynamic_attributes: analysis.dynamic_attributes ?? {},
        status:             "draft",
      });

      return NextResponse.json({
        listingId:    listing.id,
        title:        finalTitle ?? analysis.title,
        category:     analysis.category_path,
        brand:        finalBrand || null,
        color:        analysis.color || null,
        weight_kg:    analysis.weight_kg,
        selling_price: finalPrice ?? null,
        sourceUrl:    rawUrl,
        imagesFound:  imageUrls.length,
      });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // OWN IMAGES / AI-REFERENCE / TEXT-DESCRIPTION MODES
    // ─────────────────────────────────────────────────────────────────────────

    // Step 1: Upload images
    let imageUrls: string[] = [];
    const files = formData.getAll("files") as File[];
    if (files.length > 0) {
      const uploadForm = new FormData();
      files.forEach((f) => uploadForm.append("files", f));
      imageUrls = await uploadProductImages(uploadForm);
    }

    // Step 2: AI analysis
    let analysis;
    const description = formData.get("description") as string | null;

    if (mode === "ai" && description && !files.length) {
      analysis = await analyzeProductDescription(description);
    } else if (imageUrls.length > 0) {
      analysis = await analyzeProductImages(imageUrls);
    } else {
      throw new Error("No images or description provided");
    }

    // Step 3: Create listing in DB
    const listing = await createListing({
      title:           analysis.title,
      images:          imageUrls,
      category_id:     analysis.category_id,
      category_path:   analysis.category_path,
      category_code:   analysis.category_code,
      commission_rate: analysis.commission_rate,
    });

    // Step 4: Populate all AI fields
    await updateListing(listing.id, {
      description:        analysis.description,
      highlights:         analysis.highlights,
      brand:              analysis.brand || null,
      color:              analysis.color || null,
      color_family:       analysis.color_family || null,
      weight_kg:          analysis.weight_kg,
      model:              analysis.model || null,
      main_material:      analysis.main_material || null,
      material_family:    analysis.material_family || null,
      selling_price:      analysis.selling_price,
      dynamic_attributes: analysis.dynamic_attributes ?? {},
      status:             "draft",
    });

    return NextResponse.json({
      listingId:     listing.id,
      title:         analysis.title,
      category:      analysis.category_path,
      brand:         analysis.brand || null,
      color:         analysis.color || null,
      weight_kg:     analysis.weight_kg,
      selling_price: analysis.selling_price,
    });
  } catch (err) {
    console.error("process-listing error:", err);
    const message = err instanceof Error ? err.message : "Processing failed";
    const status = message.startsWith("FREE_LIMIT_REACHED") ? 402 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
