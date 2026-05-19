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
    `Task: REBUILD the supplied product photo as a fresh, professional Jumia
listing image. This is for a seller whose original shot is off-axis, badly
lit, or visually unappealing — the seller wants the product re-shot as if a
studio photographer took it.

CRITICAL RULES — these are non-negotiable:
- The product itself MUST stay accurate. Same shape, same dimensions, same
  colour, same branding, same labels, same packaging text. Re-render the
  surroundings, not the product. If you change colour, add unseen features,
  or invent text, the output is rejected.
- Use a clean, professional studio look:
  * Pure white background (#FFFFFF).
  * Soft, even three-point studio lighting (key light from above-front,
    fill from the side, soft rim).
  * Subtle natural drop shadow directly under the product. No harsh shadow.
  * Centre the product with ~10% padding on all sides.
  * Slight subject elevation — looks like the product is sitting on a
    seamless white surface.
- Composition: front-facing or 3/4 angle, whichever showcases the product
  best. No artistic crops, no lifestyle props, no human hands, no
  contextual setting (kitchen counter, table, etc.) — JUST the product
  cleanly lit on white.
- Output a SQUARE image, 2000×2000 pixels, JPG quality.
- No watermarks, no text overlays, no decorative elements, no extra
  objects in the frame.

Think of this output as a catalogue page hero shot, not a creative ad.`
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
  inline: { mimeType: string; data: string },
  prompt: string,
): Promise<Buffer> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_API_KEY is not set");

  const genAI = new GoogleGenerativeAI(apiKey);

  let lastErr: Error | null = null;
  for (const modelName of PREFERRED_MODELS) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await Promise.race([
        model.generateContent([
          { inlineData: inline },
          { text: prompt },
        ]),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error(`Gemini timed out after ${PER_IMAGE_TIMEOUT_MS}ms`)), PER_IMAGE_TIMEOUT_MS),
        ),
      ]);

      const parts = result.response.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        // The SDK returns image data in part.inlineData when the model
        // emits an image. Text-only responses don't have this shape.
        const inlinePart = (part as { inlineData?: { data: string; mimeType: string } }).inlineData;
        if (inlinePart?.data) {
          return Buffer.from(inlinePart.data, "base64");
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
  const buffer = await callGeminiImage(inline, prompt);
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

/**
 * Returns true when Gemini image enhancement is available. The UI uses
 * this to decide whether to show the Polish / Rebuild buttons (we hide
 * them entirely on environments without GOOGLE_API_KEY rather than
 * showing buttons that 500 on click).
 */
export function isGeminiImageEnabled(): boolean {
  return Boolean(process.env.GOOGLE_API_KEY);
}
