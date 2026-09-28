import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import { generateProductImage, isImagenEnabled, type ImagenAspectRatio } from "@/lib/imagen";
import { getOrCreateCreditBalance, deductCredits } from "@/lib/billing/extension-credits";
import { IMAGE_CREDIT_COST } from "@/lib/billing/credit-packs";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

// Imagen 3 calls take 4–8s typically; bump function timeout above the
// default 10s so a slow batch doesn't fail mid-generation.
export const maxDuration = 60;

// ─── POST /api/generate-product-image ────────────────────────────────────────
//
// Generates a brand-new studio product photo from a text prompt via
// Google Imagen 3, for sellers who don't have decent product photos.
//
// Body: {
//   listingId: string,
//   prompt:    string,                  // what to draw, 5–500 chars
//   aspectRatio?: "1:1" | "3:4" | "4:3" // default "1:1" (Jumia's preferred)
// }
//
// Returns: {
//   url:        string,    // public URL of the generated image
//   appended:   boolean,   // whether we appended it to listing.images
// }
//
// Costs IMAGE_CREDIT_COST credits, charged after the image is saved to
// the listing; free for everyone while billing is off (lib/billing/mode.ts).

export async function POST(req: NextRequest) {
  if (!isImagenEnabled()) {
    return NextResponse.json(
      { error: "Image generation not available — GOOGLE_API_KEY is not configured." },
      { status: 503 },
    );
  }

  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  // Reuse the polish rate limit — Imagen 3 has similar cost profile.
  const blocked = checkRateLimit(`generate-image:${userId}`, RATE_LIMITS.polishImages);
  if (blocked) return blocked;

  const balance = await getOrCreateCreditBalance(userId);
  if (balance < IMAGE_CREDIT_COST) {
    return NextResponse.json(
      {
        error:   `Not enough credits: a generated photo costs ${IMAGE_CREDIT_COST} credits and you have ${balance}. Buy credits from your dashboard to continue.`,
        needed:  IMAGE_CREDIT_COST,
        balance,
      },
      { status: 402 },
    );
  }

  // ── Parse + validate body ───────────────────────────────────────────────
  let listingId: string;
  let prompt: string;
  let aspectRatio: ImagenAspectRatio = "1:1";

  try {
    const body = await req.json();
    listingId = body.listingId;
    prompt    = String(body.prompt ?? "").trim();
    if (!listingId) throw new Error("missing listingId");
    if (prompt.length < 5)   throw new Error("prompt must be at least 5 chars");
    if (prompt.length > 500) throw new Error("prompt must be at most 500 chars");
    if (body.aspectRatio === "3:4" || body.aspectRatio === "4:3" || body.aspectRatio === "1:1") {
      aspectRatio = body.aspectRatio;
    }
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message ?? "Invalid request body" },
      { status: 400 },
    );
  }

  const db = createServerClient();

  // ── Verify listing ownership + fetch context for the prompt ─────────────
  const { data: listing, error: listingErr } = await db
    .from("listings")
    .select("id, images, title, category_path")
    .eq("id", listingId)
    .eq("user_id", userId)
    .single();

  if (listingErr || !listing) {
    return NextResponse.json({ error: "Listing not found" }, { status: 404 });
  }

  // ── Run Imagen 3 ────────────────────────────────────────────────────────
  let result;
  try {
    const productContext = [
      listing.title          ? `Product: ${listing.title}` : null,
      listing.category_path  ? `Category: ${listing.category_path}` : null,
    ].filter(Boolean).join(". ");

    result = await generateProductImage(userId, {
      prompt,
      productContext,
      aspectRatio,
    });
  } catch (e) {
    const msg = (e as Error).message ?? "Unknown Imagen 3 error";
    console.error("[generate-product-image] Imagen 3 failed:", msg);
    return NextResponse.json(
      { error: `Image generation failed: ${msg}` },
      { status: 502 },
    );
  }

  // ── Append to listing.images ────────────────────────────────────────────
  const sourceUrls = (listing.images ?? []) as string[];
  const nextImages = [...sourceUrls, result.publicUrl];

  const { error: updateErr } = await db
    .from("listings")
    .update({ images: nextImages, updated_at: new Date().toISOString() })
    .eq("id", listingId);

  if (updateErr) {
    // We still generated the image and have the URL — return it so the
    // UI can show + retry the append. Don't charge for a partial
    // failure, but also don't waste the generated image.
    console.error("[generate-product-image] listing update failed:", updateErr.message);
    return NextResponse.json({
      url:      result.publicUrl,
      appended: false,
      warning:  "Image generated but could not be appended to listing automatically.",
    });
  }

  // Charge AFTER everything succeeded (a no-op for admins and while billing is off).
  const charged = await deductCredits(userId, IMAGE_CREDIT_COST, "Generated a product photo");
  if (!charged.ok) console.error(`[generate-product-image] credit deduction failed for ${userId}: ${charged.error}`);

  return NextResponse.json({
    url:      result.publicUrl,
    appended: true,
  });
}
