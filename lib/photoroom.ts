/**
 * PhotoRoom integration — polish seller phone photos into marketplace-ready shots.
 *
 * Endpoint:  https://image-api.photoroom.com/v2/edit
 * Docs:      https://www.photoroom.com/api/docs
 * Pricing:   100 images/month free, then $0.025/image basic / $0.05 AI background
 *
 * Set PHOTOROOM_API_KEY in env vars.
 *
 * What we apply (marketplace-compliant defaults for Jumia):
 *   - Remove background
 *   - Replace with pure white (#FFFFFF)
 *   - Add soft AI shadow for depth
 *   - Center the product with 10% padding
 *   - Output 2000×2000 JPG (Jumia max — 500×500 min)
 */

import { createServerClient } from "@/lib/supabase/server";

const PHOTOROOM_BASE = "https://image-api.photoroom.com/v2/edit";
const BUCKET = "product-images";

export interface PolishOptions {
  /** Background style. "white" = solid white, "transparent" = PNG with no BG */
  background?: "white" | "transparent";
  /** Output dimensions in pixels (square). Default 2000. */
  size?: number;
  /** Add a natural soft shadow under the product (recommended for marketplace) */
  shadow?: boolean;
  /** Padding around the product as a fraction (0–1). Default 0.1 (10%). */
  padding?: number;
}

export interface PolishResult {
  /** Public URL of the polished image in Supabase Storage */
  publicUrl: string;
  /** Storage path (relative to bucket) */
  storagePath: string;
  /** Bytes downloaded from PhotoRoom */
  size: number;
}

/**
 * Polish one image via PhotoRoom and re-upload to Supabase Storage.
 * Returns the new public URL. Throws if PhotoRoom is misconfigured or the
 * service errors out.
 */
export async function polishImage(
  sourceUrl: string,
  userId: string,
  opts: PolishOptions = {}
): Promise<PolishResult> {
  const apiKey = process.env.PHOTOROOM_API_KEY;
  if (!apiKey) throw new Error("PHOTOROOM_API_KEY not set");

  const {
    background = "white",
    size       = 2000,
    shadow     = true,
    padding    = 0.1,
  } = opts;

  // Build PhotoRoom v2 edit URL
  const params = new URLSearchParams({
    imageUrl:    sourceUrl,
    outputSize:  `${size}x${size}`,
    format:      background === "transparent" ? "png" : "jpg",
    padding:     String(padding),
  });

  if (background === "white") {
    params.set("background.color", "FFFFFF");
  } else {
    params.set("background.color", "transparent");
  }

  if (shadow) {
    params.set("shadow.mode", "ai.soft");
  }

  const proRoomUrl = `${PHOTOROOM_BASE}?${params.toString()}`;

  // Call PhotoRoom — returns the image bytes directly
  let res: Response;
  try {
    res = await fetch(proRoomUrl, {
      headers: {
        "x-api-key": apiKey,
        Accept:      background === "transparent" ? "image/png" : "image/jpeg",
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new Error(`PhotoRoom network error: ${(e as Error).message}`);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`PhotoRoom ${res.status}: ${errText.slice(0, 200)}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 1024) {
    throw new Error("PhotoRoom returned an empty image");
  }

  // Re-upload polished image to Supabase Storage
  const ext         = background === "transparent" ? "png" : "jpg";
  const contentType = background === "transparent" ? "image/png" : "image/jpeg";
  const storagePath = `${userId}/polished/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

  const db = createServerClient();
  const { error } = await db.storage.from(BUCKET).upload(storagePath, buffer, {
    contentType,
    upsert: false,
  });

  if (error) {
    throw new Error(`Polished image upload failed: ${error.message}`);
  }

  const { data } = db.storage.from(BUCKET).getPublicUrl(storagePath);

  return {
    publicUrl:   data.publicUrl,
    storagePath,
    size:        buffer.length,
  };
}

/**
 * Polish multiple images in parallel (up to 4 at a time to respect rate limits).
 * Failures are logged but don't fail the whole batch — original URL is kept
 * for any image that can't be polished.
 */
export async function polishImages(
  sourceUrls: string[],
  userId: string,
  opts: PolishOptions = {}
): Promise<{ polished: string[]; errors: string[] }> {
  if (!sourceUrls.length) return { polished: [], errors: [] };

  const concurrency = 4;
  const polished: string[] = new Array(sourceUrls.length);
  const errors: string[] = [];

  for (let i = 0; i < sourceUrls.length; i += concurrency) {
    const batch = sourceUrls.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (url, idx) => {
        try {
          const r = await polishImage(url, userId, opts);
          return { idx: i + idx, url: r.publicUrl };
        } catch (e) {
          const msg = (e as Error).message;
          console.warn(`[polishImages] ${url} → ${msg}`);
          errors.push(`${url}: ${msg}`);
          return { idx: i + idx, url };  // fall back to original
        }
      })
    );
    for (const r of results) polished[r.idx] = r.url;
  }

  return { polished, errors };
}

/**
 * Returns true when PhotoRoom credentials are configured. Used by the UI to
 * decide whether to show the "Polish images" button.
 */
export function isPhotoRoomEnabled(): boolean {
  return Boolean(process.env.PHOTOROOM_API_KEY);
}
