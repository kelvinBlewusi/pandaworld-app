/**
 * Imagen 3 — text-to-image product photo generation.
 *
 * Distinct from lib/gemini-image.ts (which EDITS existing seller
 * photos via gemini-2.5-flash-image-preview). Imagen 3 generates a
 * brand-new image from a text prompt alone — for sellers who don't
 * have decent product photos.
 *
 * Business-tier-only feature. Gated at the API route level
 * (app/api/generate-product-image/route.ts).
 *
 * Calls Google's Imagen 3 via the Gemini API's `predict` endpoint
 * (the JS SDK doesn't expose this yet, so we use fetch). Uploads the
 * result to Supabase Storage and returns the public URL.
 */

import { createServerClient } from "@/lib/supabase/server";

const BUCKET = "product-images";

// Hard timeout per call. Imagen 3 typically returns in 4–8s; cap at
// 60s so a slow upstream doesn't block our serverless function.
const PER_IMAGE_TIMEOUT_MS = 60_000;

// The text-to-image model ID. Centralised in ai-models.ts but the
// REST endpoint pattern needs the raw name, so we keep it here too.
const IMAGEN_MODEL = "imagen-3.0-generate-002";

export type ImagenAspectRatio = "1:1" | "3:4" | "4:3" | "9:16" | "16:9";

export interface ImagenGenerateOptions {
  /** What to draw. Should describe the product + style + background. */
  prompt: string;
  /**
   * Optional product context to anchor the prompt — title, category
   * path. Threaded in to keep the generated image consistent with the
   * rest of the listing.
   */
  productContext?: string;
  /**
   * Aspect ratio. Jumia accepts 1:1 (preferred), 3:4 (allowed),
   * 4:3 (allowed). 1:1 is the safest default.
   */
  aspectRatio?: ImagenAspectRatio;
}

export interface ImagenGenerateResult {
  publicUrl:   string;
  storagePath: string;
  size:        number;
}

// ─── Prompt builder ─────────────────────────────────────────────────────────
//
// Imagen 3 responds well to specific, photography-grounded prompts.
// We always append "studio lighting, white background, centered,
// product photography" because that matches Jumia's image-spec
// requirements (white BG, no text overlay, product centred).

function buildImagenPrompt(opts: ImagenGenerateOptions): string {
  const parts: string[] = [opts.prompt.trim()];

  if (opts.productContext && opts.productContext.trim()) {
    parts.push(`Context: ${opts.productContext.trim()}.`);
  }

  // Style anchor — same intent as Jumia QC's image rules. Pure white
  // background, no text, no humans (unless the prompt mentions a
  // model wearing the item), no logos, no watermarks.
  parts.push(
    "Studio product photography. Pure white background (#FFFFFF). " +
    "Soft natural lighting. Product centred. No text overlays. " +
    "No watermarks. No logos. Photorealistic, high detail.",
  );

  return parts.join(" ");
}

// ─── REST call to Imagen 3 ──────────────────────────────────────────────────

async function callImagen(
  prompt: string,
  aspectRatio: ImagenAspectRatio,
): Promise<Buffer> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_API_KEY not set");

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${IMAGEN_MODEL}:predict?key=${apiKey}`;

  // Imagen 3 request body shape. Note `personGeneration: "allow_adult"`
  // — Imagen blocks images that look like children by default; this
  // unblocks adult models (e.g. apparel category) without permitting
  // minors.
  const body = {
    instances: [{ prompt }],
    parameters: {
      sampleCount:      1,
      aspectRatio,
      personGeneration: "allow_adult",
    },
  };

  const res = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(PER_IMAGE_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Imagen 3 call failed: ${res.status} ${text.slice(0, 400)}`);
  }

  const data = (await res.json()) as {
    predictions?: Array<{
      bytesBase64Encoded?: string;
      mimeType?:           string;
    }>;
  };

  const first = data.predictions?.[0];
  if (!first?.bytesBase64Encoded) {
    throw new Error(
      `Imagen 3 returned no image. Response: ${JSON.stringify(data).slice(0, 300)}`,
    );
  }

  return Buffer.from(first.bytesBase64Encoded, "base64");
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Generate a new product image from a text prompt. Uploads to
 * Supabase Storage and returns the public URL ready to be appended
 * to a listing's images array.
 *
 * Caller is responsible for:
 *   - Tier check (Business-only — see api route)
 *   - Quota gate (use polish quota — see api route)
 *   - UI flow (modal → seller approves → add to listing)
 */
export async function generateProductImage(
  userId: string,
  opts: ImagenGenerateOptions,
): Promise<ImagenGenerateResult> {
  const prompt = buildImagenPrompt(opts);
  const aspectRatio = opts.aspectRatio ?? "1:1";

  const t0 = Date.now();
  const buffer = await callImagen(prompt, aspectRatio);
  const elapsed = Date.now() - t0;

  if (buffer.length < 1024) {
    throw new Error("Imagen 3 returned an empty image");
  }

  // Upload to Supabase Storage under the user's namespace. Stamp path
  // with timestamp + random suffix so we never collide on concurrent
  // generations.
  const storagePath = `${userId}/generated/${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
  const db = createServerClient();
  const { error } = await db.storage.from(BUCKET).upload(storagePath, buffer, {
    contentType: "image/jpeg",
    upsert:      false,
  });
  if (error) {
    throw new Error(`Imagen 3 upload failed: ${error.message}`);
  }

  const { data } = db.storage.from(BUCKET).getPublicUrl(storagePath);
  console.info(
    `[imagen] generated ${aspectRatio} prompt-len=${prompt.length} size=${buffer.length}B elapsed=${elapsed}ms → ${data.publicUrl}`,
  );

  return {
    publicUrl:   data.publicUrl,
    storagePath,
    size:        buffer.length,
  };
}

/** Sanity check for the env. Returns false if `GOOGLE_API_KEY` is missing. */
export function isImagenEnabled(): boolean {
  return Boolean(process.env.GOOGLE_API_KEY);
}
