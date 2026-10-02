/**
 * Gemini-powered product-image enhancement.
 *
 * Uses Gemini 2.5 Flash Image ("Nano Banana") via the existing
 * @google/generative-ai SDK + GOOGLE_API_KEY. Two modes:
 *
 *   - "polish":  Clean up the seller's photo without restyling it. White
 *                background (#FFFFFF), centred subject with ~10% padding,
 *                soft natural drop shadow. PRESERVE the product exactly —
 *                same shape, colour, branding, labels.
 *
 *   - "rebuild": Re-render the product as a fresh studio listing image.
 *                Same white-background output, but with new studio lighting
 *                and composition. Still preserves the product (shape,
 *                colour, branding, packaging text). For sellers whose
 *                originals are off-axis, poorly lit, or visually unappealing.
 *
 * Both modes output 2000×2000 JPG (matches Jumia's max + the PhotoRoom
 * defaults), re-uploaded to Supabase Storage at:
 *   ${userId}/enhanced/${ts}-${rand}.jpg
 *
 * Same shape as lib/photoroom.ts so /api/enhance-images can swap providers
 * cleanly. Failures don't fail the batch — original URL is kept and the
 * error logged.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { createServerClient } from "@/lib/supabase/server";

const BUCKET = "product-images";

// Gemini 2.5 Flash Image's official model identifier. The SDK accepts
// both the "-preview" suffix and the stable name as Google rolls it out;
// we try the stable name first and fall back.
const PREFERRED_MODELS = [
  "gemini-2.5-flash-image",
  "gemini-2.5-flash-image-preview",
];

// Cap each Gemini call so a slow upstream doesn't sink the whole serverless
// function. 60s is well above Gemini's typical 3-8s response time on image
// edits, but generous enough for high-resolution outputs.
const PER_IMAGE_TIMEOUT_MS = 60_000;

export type EnhanceMode = "polish" | "rebuild";

export interface EnhanceOptions {
  /** Polish (preserve product) vs Rebuild (re-render as a studio shot) */
  mode: EnhanceMode;
  /**
   * Optional product context to anchor the AI's understanding of WHAT
   * it's looking at. Threads in title + category path when available so
   * Gemini knows e.g. "this is a Samsung phone case", not "this is a
   * generic black rectangle". Improves fidelity, especially for rebuilds.
   */
  productContext?: string;
}

export interface EnhanceResult {
  /** Public URL of the enhanced image in Supabase Storage */
  publicUrl: string;
  /** Storage path (relative to bucket) */
  storagePath: string;
  /** Bytes received from Gemini */
  size: number;
}

// ─── Prompt templates ───────────────────────────────────────────────────────

/**
 * The prompt text Gemini receives alongside the original image. Both
 * modes target Jumia's marketplace-image requirements (white BG, square
 * 2000×2000, centred subject, soft shadow, no watermarks) — the
 * difference is how much creative licence Gemini is allowed to take.
 */
function buildPrompt(mode: EnhanceMode, productContext?: string): string {
  const contextLine = productContext
    ? `Product context (use this to anchor your understanding — do NOT invent details outside it): ${productContext}\n\n`
    : "";

  if (mode === "polish") {
    return (
      contextLine +
      `Task: POLISH the supplied product photo into a Jumia-ready marketplace image.

CRITICAL RULES — these are non-negotiable:
- Preserve the product EXACTLY. Same shape, same dimensions, same colour,
  same branding, same labels, same packaging text. This is a CLEANUP, not
  a recreation. If you change any feature of the product itself, the
  output is rejected.
- Remove the original background completely.
- Replace it with pure white (#FFFFFF). No gradient, no off-white, no shadow
  on the background itself.
- Add a soft, natural drop shadow directly under the product so it doesn't
  look floating. Subtle — not dramatic.
- Centre the product in the frame with ~10% padding on all sides.
- Output a SQUARE image, 2000×2000 pixels, JPG quality.
- No watermarks, no text overlays, no logos other than what's already on
  the product, no price tags, no "Sale!" stickers.

If the original photo already meets these criteria, return the image
unchanged. Do not stylistically alter a photo that's already clean.`
    );
  }

  // mode === "rebuild"
  return (
    contextLine +
    `Task: REBUILD the supplied product photo as a high-end catalogue image
for the Jumia Ghana marketplace. The seller's original shot is amateurish
(phone camera, poor lighting, distracting background). Re-shoot the same
product as if a professional product photographer took it in a real studio.

PRESERVE THE PRODUCT EXACTLY — this is the most important rule:
- Same SKU, same brand, same model, same dimensions, same colour, same
  pattern, same texture, same packaging, same printed text, same labels,
  same logos, same buttons / dials / ports, same accessories visible in
  the frame. If you change ANY feature of the product itself, the output
  is rejected and the seller's listing fails Jumia QC.
- Do not "improve" the product. Do not change its colour to be more
  vivid, do not straighten labels, do not remove dents or wear, do not
  invent a model number, do not add features that aren't there.
- If the product has multiple parts (e.g. phone + charger + box), keep
  all of them in the rebuilt image. Do not silently drop accessories.
- If the original has visible wear, scratches, or imperfections, KEEP
  THEM. Sellers list used items too — a rebuilt photo that hides wear
  is dishonest.

STUDIO TREATMENT — apply this to the surroundings only:
- Pure white background, hex value #FFFFFF. No off-white, no gradient,
  no seamless paper showing texture. Perfectly flat white pixels.
- Three-point studio lighting:
  * Key light: above-front, 45° down, soft / diffused.
  * Fill light: from the opposite side, ~half intensity, no shadows.
  * Rim light: behind the product, separating it from the background.
  The result should be even, soft, neutral — colour-accurate, not warm
  or cool. Think Apple product page, not Instagram filter.
- Drop shadow: ONE soft, natural shadow directly under the product
  (~10% opacity, ~20px blur). Anchors the product so it doesn't look
  floating. No harsh shadow, no double shadow, no stylised shadow.
- Product placement: centred horizontally and vertically with ~10%
  padding on all four sides. Slight elevation — looks like the product
  is sitting on a seamless white surface, not floating in space.
- Camera angle: front-facing or 3/4 (~30° turn), whichever showcases
  the product's key features. NEVER top-down unless the product is
  inherently flat (e.g. a phone, a wallet). For boxed products, show
  the front face of the packaging clearly.
- Resolution: SQUARE, 2000×2000 pixels minimum. Sharp focus. JPG output.

WHAT IS BANNED:
- No human hands, fingers, or any body parts in the frame.
- No lifestyle props (tables, plants, fabric, coffee cups, etc.).
- No contextual setting (kitchen counter, bed, outdoor scene).
- No additional objects beyond the product itself.
- No text overlays added to the image (e.g. price tags, "SALE" stickers,
  watermarks, social-media handles, brand promos).
- No filters or stylised colour grades.
- No decorative borders or framing.
- No mirror reflections (unless the product itself has reflective parts).
- No multiple angles composited side-by-side — ONE image, ONE angle.

This output must pass Jumia's automated QC on first submission. Imagine
it as the hero image on Apple.com, Best Buy, or Amazon's main listing
gallery: pure white background, perfect lighting, product clearly the
sole subject, photorealistic.`
  );
}

// ─── Network helpers ────────────────────────────────────────────────────────

/**
 * Download an image URL to an inline data URI (base64 + MIME). Gemini
 * accepts inline images up to ~20 MB; we cap the input at 8 MB to stay
 * well clear and to keep the prompt-token budget sane.
 */
async function fetchAsInlineImage(
  url: string,
): Promise<{ mimeType: string; data: string }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    throw new Error(`Failed to download source image (HTTP ${res.status})`);
  }
  const mimeType = res.headers.get("content-type") ?? "image/jpeg";
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024) throw new Error("Source image is empty or unreadable");
  if (buf.length > 8 * 1024 * 1024) {
    throw new Error(`Source image too large (${Math.round(buf.length / 1024 / 1024)} MB; max 8 MB)`);
  }
  return { mimeType, data: buf.toString("base64") };
}

/**
 * Calls Gemini once with the source image + prompt, retrying through the
 * preferred-model list if the first model isn't available on this API key.
 * Returns the raw image bytes from the first image part in the response.
 */
async function callGeminiImage(
  inline: { mimeType: string; data: string } | { mimeType: string; data: string }[],
  prompt: string,
  timeoutMs = PER_IMAGE_TIMEOUT_MS,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_API_KEY is not set");

  const genAI = new GoogleGenerativeAI(apiKey);

  let lastErr: Error | null = null;
  for (const modelName of PREFERRED_MODELS) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const inlines = Array.isArray(inline) ? inline : [inline];
      const result = await Promise.race([
        model.generateContent([
          ...inlines.map((i) => ({ inlineData: i })),
          { text: prompt },
        ]),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error(`Gemini timed out after ${timeoutMs}ms`)), timeoutMs),
        ),
      ]);

      const parts = result.response.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        // The SDK returns image data in part.inlineData when the model
        // emits an image. Text-only responses don't have this shape.
        const inlinePart = (part as { inlineData?: { data: string; mimeType: string } }).inlineData;
        if (inlinePart?.data) {
          return { buffer: Buffer.from(inlinePart.data, "base64"), mimeType: inlinePart.mimeType || "image/png" };
        }
      }
      throw new Error("Gemini returned no image in response");
    } catch (e) {
      lastErr = e as Error;
      const msg = lastErr.message ?? "";
      // Model-not-found / not-available — try the next one. Other errors
      // (auth, quota, prompt-rejection) we surface immediately because
      // retrying with a different model name won't fix them.
      if (
        msg.includes("not found") ||
        msg.includes("not supported") ||
        msg.includes("404") ||
        msg.includes("models/")
      ) {
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr ?? new Error("No Gemini image-capable model available");
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Enhance a single product image. Downloads the source, sends to Gemini,
 * uploads the result to Supabase Storage, returns the new public URL.
 */
export async function enhanceImage(
  sourceUrl: string,
  userId: string,
  opts: EnhanceOptions,
): Promise<EnhanceResult> {
  const inline = await fetchAsInlineImage(sourceUrl);
  const prompt = buildPrompt(opts.mode, opts.productContext);

  const t0 = Date.now();
  const { buffer } = await callGeminiImage(inline, prompt);
  const elapsed = Date.now() - t0;

  if (buffer.length < 1024) {
    throw new Error("Gemini returned an empty image");
  }

  // Upload to Supabase Storage. We always write JPG because Gemini's
  // default output is JPG-shaped and JPG is what Jumia prefers (smaller
  // payload, same visual quality on photos).
  const storagePath = `${userId}/enhanced/${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
  const db = createServerClient();
  const { error } = await db.storage.from(BUCKET).upload(storagePath, buffer, {
    contentType: "image/jpeg",
    upsert:      false,
  });
  if (error) {
    throw new Error(`Enhanced image upload failed: ${error.message}`);
  }

  const { data } = db.storage.from(BUCKET).getPublicUrl(storagePath);
  console.info(
    `[gemini-image] ${opts.mode} ok size=${buffer.length}B elapsed=${elapsed}ms → ${data.publicUrl}`,
  );

  return {
    publicUrl:   data.publicUrl,
    storagePath,
    size:        buffer.length,
  };
}

/**
 * Enhance multiple images in parallel (capped at 3 concurrent — Gemini
 * image-gen has stricter rate limits than the text path). Failures are
 * logged but don't fail the whole batch; the original URL is returned
 * in place of any image that couldn't be enhanced.
 */
export async function enhanceImages(
  sourceUrls: string[],
  userId: string,
  opts: EnhanceOptions,
): Promise<{
  enhanced: Array<{ originalUrl: string; enhancedUrl: string; error?: string }>;
}> {
  if (!sourceUrls.length) return { enhanced: [] };

  // Gemini image-gen RPM is lower than text — keep concurrency modest.
  const concurrency = 3;
  const out: Array<{ originalUrl: string; enhancedUrl: string; error?: string }> =
    new Array(sourceUrls.length);

  for (let i = 0; i < sourceUrls.length; i += concurrency) {
    const batch = sourceUrls.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (url, idx) => {
        const slot = i + idx;
        try {
          const r = await enhanceImage(url, userId, opts);
          return {
            slot,
            row: { originalUrl: url, enhancedUrl: r.publicUrl },
          };
        } catch (e) {
          const msg = (e as Error).message;
          console.warn(`[enhanceImages] ${opts.mode} failed for ${url}: ${msg}`);
          return {
            slot,
            row: { originalUrl: url, enhancedUrl: url, error: msg },
          };
        }
      }),
    );
    for (const r of results) out[r.slot] = r.row;
  }

  return { enhanced: out };
}

// ─── Product shots from rough photos (extension "Polish images") ─────────────

/**
 * The four images the extension's Polish images button makes from a
 * seller's rough phone photos: Jumia's white-background main image, then
 * the extra angles a good listing carries. An admin-only prototype for now
 * (app/api/extension/polish-images/route.ts).
 */
export const PRODUCT_SHOTS = [
  {
    id:    "main",
    label: "Main image",
    brief: "MAIN LISTING IMAGE: the product alone, front view, centred with about 10% margin on every side, on a pure white (#FFFFFF) background, soft even studio lighting and one subtle shadow beneath it. Nothing else in the frame. This is the first image shoppers see on Jumia.",
  },
  {
    id:    "angle",
    label: "Angle",
    brief: "ANGLE SHOT: the product alone, turned about 30 to 45 degrees so its side and depth show, on a pure white (#FFFFFF) background, soft studio lighting and a subtle shadow beneath it. Nothing else in the frame.",
  },
  {
    id:    "lifestyle",
    label: "Lifestyle",
    brief: "LIFESTYLE SHOT: the product in a realistic, tasteful setting where it is naturally used (a kitchen counter for a kettle, a bathroom shelf for a shower cream, a dressing table for jewellery), natural daylight, a softly blurred background, the product sharp and prominent. If a person helps show it in use, show only hands or crop the face out.",
  },
  {
    id:    "detail",
    label: "Detail",
    brief: "DETAIL SHOT: a close-up of the product's most important feature, material or texture (the controls, the fabric, the label), on a clean light background, sharp and well lit, so a shopper can see its quality up close.",
  },
] as const;

function productShotPrompt(brief: string, photoCount: number, productContext?: string): string {
  return (
    (productContext ? `What the seller says about it (use it, don't invent beyond it): ${productContext}\n\n` : "") +
    `You are given ${photoCount === 1 ? "a photo" : `${photoCount} photos`} of ONE product, taken by a seller on a phone. ` +
    `Create a professional e-commerce photo of exactly this product.

PRESERVE THE PRODUCT EXACTLY: the same shape, proportions, colours, materials, patterns, printed text, labels, logos, buttons and parts. Do not add, remove or redesign anything on the product, and never invent a brand or model.${photoCount > 1 ? " The photos show the same product from different sides; use them together to get it right." : ""}

${brief}

Output ONE square (1:1) photorealistic image in sharp focus, with the product as the clear subject. No text, captions, watermarks, price tags, badges, stickers or borders.`
  );
}

export interface ProductShot {
  id:     string;
  label:  string;
  /** Public URL of the generated image; absent when this shot failed. */
  url?:   string;
  error?: string;
}

/**
 * Generate the four PRODUCT_SHOTS from a seller's rough photos, in
 * parallel (one Gemini call each, every source photo as a reference), and
 * store each in Supabase Storage. A shot that fails comes back with its
 * error rather than failing the others.
 */
export async function generateProductShots(
  sources: { mimeType: string; data: string }[],
  userId:  string,
  opts: { productContext?: string; timeoutMs?: number } = {},
): Promise<ProductShot[]> {
  const db = createServerClient();
  const stamp = Date.now();
  return Promise.all(PRODUCT_SHOTS.map(async (shot): Promise<ProductShot> => {
    try {
      const t0 = Date.now();
      const { buffer, mimeType } = await callGeminiImage(
        sources, productShotPrompt(shot.brief, sources.length, opts.productContext), opts.timeoutMs ?? 50_000,
      );
      if (buffer.length < 1024) throw new Error("Gemini returned an empty image");
      const ext = mimeType.includes("png") ? "png" : mimeType.includes("webp") ? "webp" : "jpg";
      const storagePath = `${userId}/polished/${stamp}-${shot.id}.${ext}`;
      const { error } = await db.storage.from(BUCKET).upload(storagePath, buffer, { contentType: mimeType, upsert: false });
      if (error) throw new Error(`upload failed: ${error.message}`);
      const { data } = db.storage.from(BUCKET).getPublicUrl(storagePath);
      console.info(`[gemini-image] shot ${shot.id} ok size=${buffer.length}B elapsed=${Date.now() - t0}ms`);
      return { id: shot.id, label: shot.label, url: data.publicUrl };
    } catch (e) {
      console.warn(`[gemini-image] shot ${shot.id} failed: ${(e as Error).message}`);
      return { id: shot.id, label: shot.label, error: (e as Error).message };
    }
  }));
}

/**
 * Returns true when Gemini image enhancement is available. The UI uses
 * this to decide whether to show the Polish / Rebuild buttons (we hide
 * them entirely on environments without GOOGLE_API_KEY rather than
 * showing buttons that 500 on click).
 */
export function isGeminiImageEnabled(): boolean {
  return Boolean(process.env.GOOGLE_API_KEY);
}
