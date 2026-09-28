import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import {
  enhanceImages,
  isGeminiImageEnabled,
  type EnhanceMode,
} from "@/lib/gemini-image";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { getOrCreateCreditBalance, deductCredits } from "@/lib/billing/extension-credits";
import { IMAGE_CREDIT_COST } from "@/lib/billing/credit-packs";

// Gemini image-gen takes 3-8s per image. 8 images × 3 concurrent = ~24s
// theoretical wall-clock, but real-world we see 30-60s when one slot is
// slow. 90s gives comfortable headroom; the route streams nothing so we
// don't need Edge-runtime tricks here.
export const maxDuration = 90;

// ─── POST /api/enhance-images ────────────────────────────────────────────────
//
// Runs Gemini image enhancement on every image of a listing. Two modes:
//   - "polish":  preserve product exactly, clean background to white, soft
//                shadow, centred. Conservative — for usable shots that just
//                need pixel cleanup.
//   - "rebuild": re-render the product as a studio shot. More dramatic —
//                for blurry / off-axis / poorly-lit originals.
//
// Body: { listingId: string, mode: "polish" | "rebuild" }
//
// Returns: {
//   enhanced: Array<{ originalUrl, enhancedUrl, error? }>,
//   mode,
//   listingId,
// }
//
// The route DOES NOT replace listings.images automatically. It writes the
// enhanced URLs into a `image_variants` JSONB column keyed by the original
// URL so the seller can compare before/after and accept/reject per image.
// A separate PATCH (via the standard /api/listings/[id] update path) takes
// the final URL array once the seller is happy.

export async function POST(req: NextRequest) {
  if (!isGeminiImageEnabled()) {
    return NextResponse.json(
      { error: "Image enhancement not available — GOOGLE_API_KEY is not configured." },
      { status: 503 },
    );
  }

  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  // Rate limit — this is the most expensive route in the app (Gemini
  // image-gen at ~$0.039 per image × up to 8 images per call). Without
  // a cap a single seller can burn $30+/hour. Limit is per-user.
  const blocked = checkRateLimit(`enhance-images:${userId}`, RATE_LIMITS.enhanceImages);
  if (blocked) return blocked;

  let listingId: string;
  let mode: EnhanceMode;

  try {
    const body = await req.json();
    listingId = body.listingId;
    if (!listingId) throw new Error("missing listingId");
    if (body.mode !== "polish" && body.mode !== "rebuild") {
      throw new Error("mode must be 'polish' or 'rebuild'");
    }
    mode = body.mode;
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message ?? "Invalid request body" },
      { status: 400 },
    );
  }

  const db = createServerClient();

  // ── Fetch the listing — must belong to this user ─────────────────────────
  const { data: listing, error: listingErr } = await db
    .from("listings")
    .select("id, images, title, category_path, image_variants")
    .eq("id", listingId)
    .eq("user_id", userId)
    .single();

  if (listingErr || !listing) {
    return NextResponse.json({ error: "Listing not found" }, { status: 404 });
  }

  const sourceUrls = (listing.images ?? []) as string[];
  if (sourceUrls.length === 0) {
    return NextResponse.json(
      { error: "Listing has no images to enhance" },
      { status: 400 },
    );
  }

  // ── Skip images that already have an enhanced variant for this mode ──────
  //
  // Gemini calls aren't cheap. If the seller has already enhanced an image
  // (e.g. they re-opened the modal after closing it), reuse the existing
  // result rather than burning another ~$0.039 per image.
  type VariantBag = Record<string, { polish?: string; rebuild?: string }>;
  const existingVariants = (listing.image_variants ?? {}) as VariantBag;
  const needsEnhancing: string[] = [];
  const passThrough: Array<{ originalUrl: string; enhancedUrl: string }> = [];

  for (const url of sourceUrls) {
    const variants = existingVariants[url];
    const cached = variants?.[mode];
    if (cached) {
      passThrough.push({ originalUrl: url, enhancedUrl: cached });
    } else {
      needsEnhancing.push(url);
    }
  }

  // ── Credits: IMAGE_CREDIT_COST per image that actually needs the AI ──────
  // Checked up front for the whole set, charged after for the images that
  // came back. Free for everyone while billing is off (lib/billing/mode.ts).
  if (needsEnhancing.length > 0) {
    const needed = needsEnhancing.length * IMAGE_CREDIT_COST;
    const balance = await getOrCreateCreditBalance(userId);
    if (balance < needed) {
      return NextResponse.json(
        {
          error: `Not enough credits: ${needsEnhancing.length} photo${needsEnhancing.length === 1 ? "" : "s"} need ${needed} credits and you have ${balance}. Buy credits from your dashboard to continue.`,
          needed,
          balance,
        },
        { status: 402 },
      );
    }
  }

  // ── Build product context so Gemini knows what it's looking at ───────────
  const productContext = [
    listing.title ? `Product: ${listing.title}` : null,
    listing.category_path ? `Category: ${listing.category_path}` : null,
  ]
    .filter(Boolean)
    .join(". ");

  // ── Run Gemini on the rest ───────────────────────────────────────────────
  const { enhanced: fresh } = needsEnhancing.length > 0
    ? await enhanceImages(needsEnhancing, userId, { mode, productContext })
    : { enhanced: [] };

  // ── Persist variants — keyed by original URL so order can change later ───
  const nextVariants: VariantBag = { ...existingVariants };
  for (const f of fresh) {
    // Don't store failures as if they were valid variants — the entry
    // returns the original URL with an error message; skip those so the
    // seller can retry later without us thinking the variant exists.
    if (f.error) continue;
    const prev = nextVariants[f.originalUrl] ?? {};
    prev[mode] = f.enhancedUrl;
    nextVariants[f.originalUrl] = prev;
  }

  // Graceful fallback if the image_variants migration hasn't been run
  // yet. Without the column, the update below would 500 — costing the
  // seller a successful Gemini call. We try the full update first; on
  // schema error we retry without image_variants so the seller still
  // gets their enhanced URLs back, just without the variant cache.
  const persistResult = await db
    .from("listings")
    .update({
      image_variants: nextVariants,
      updated_at:     new Date().toISOString(),
    })
    .eq("id", listingId);

  if (persistResult.error && /column.+image_variants/i.test(persistResult.error.message)) {
    console.warn(
      `[enhance-images] image_variants column missing — run supabase/migrations/2026-05-19_image_variants.sql. ` +
      `Returning enhanced URLs without caching them for re-use.`,
    );
    await db
      .from("listings")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", listingId);
  } else if (persistResult.error) {
    console.error(`[enhance-images] persist failed: ${persistResult.error.message}`);
  }

  // ── Return the combined result (cached + fresh) preserving source order ──
  const byOriginal = new Map<string, { enhancedUrl: string; error?: string }>();
  for (const r of passThrough) byOriginal.set(r.originalUrl, { enhancedUrl: r.enhancedUrl });
  for (const r of fresh) {
    byOriginal.set(r.originalUrl, { enhancedUrl: r.enhancedUrl, error: r.error });
  }

  const orderedResult = sourceUrls.map((url) => {
    const got = byOriginal.get(url);
    return got
      ? { originalUrl: url, enhancedUrl: got.enhancedUrl, error: got.error }
      : { originalUrl: url, enhancedUrl: url, error: "Skipped" };
  });

  // Charge for the images Gemini produced; cache replays and failures are free.
  const billed = fresh.filter((f) => !f.error).length;
  if (billed > 0) {
    const charged = await deductCredits(userId, billed * IMAGE_CREDIT_COST, `${mode === "polish" ? "Polished" : "Rebuilt"} ${billed} photo${billed === 1 ? "" : "s"}`);
    if (!charged.ok) console.error(`[enhance-images] credit deduction failed for ${userId}: ${charged.error}`);
  }

  return NextResponse.json({
    enhanced:    orderedResult,
    mode,
    listingId,
    cached:      passThrough.length,
    generated:   fresh.filter((f) => !f.error).length,
    failed:      fresh.filter((f) => f.error).length,
  });
}
