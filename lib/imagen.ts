/**
 * Text-to-image product photo generation.
 *
 * History: this used to call Google Imagen 3 via the v1beta `predict`
 * REST endpoint. That endpoint 404s on most Gemini API keys
 * ("models/imagen-3.0-generate-002 is not found for API version v1beta,
 * or is not supported for predict"). Imagen 3 in v1beta requires
 * Vertex AI setup, not a plain Gemini key.
 *
 * Fix: use Gemini 2.5 Flash Image ("Nano Banana 2.5") in TEXT-ONLY
 * mode — the same model lib/gemini-image.ts uses for Polish/Rebuild
 * just without an input image. Text → image works on every Gemini key.
 *
 * This keeps the public API of this file identical so existing callers
 * (api/generate-product-image, GenerateImageModal) keep working. The
 * only meaningful difference: aspectRatio is now a hint inside the
 * prompt rather than a separate parameter (Gemini's image model
 * ignores explicit aspect-ratio params).
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { createServerClient } from "@/lib/supabase/server";

const BUCKET = "product-images";

const PER_IMAGE_TIMEOUT_MS = 60_000;

// Same fallback chain as lib/gemini-image.ts so we resolve whichever
// model name is actually live on the user's API key.
const PREFERRED_MODELS = [
  "gemini-2.5-flash-image",
  "gemini-2.5-flash-image-preview",
];

export type ImagenAspectRatio = "1:1" | "3:4" | "4:3" | "9:16" | "16:9";

export interface ImagenGenerateOptions {
  prompt:           string;
  productContext?:  string;
  aspectRatio?:     ImagenAspectRatio;
}

export interface ImagenGenerateResult {
  publicUrl:   string;
  storagePath: string;
  size:        number;
}

// ─── Prompt builder ─────────────────────────────────────────────────────────

const ASPECT_HINTS: Record<ImagenAspectRatio, string> = {
  "1:1":  "square 1:1 aspect ratio (2000x2000 pixels)",
  "3:4":  "portrait 3:4 aspect ratio (1500x2000 pixels)",
  "4:3":  "landscape 4:3 aspect ratio (2000x1500 pixels)",
  "9:16": "tall portrait 9:16 aspect ratio",
  "16:9": "wide landscape 16:9 aspect ratio",
};

function buildImagenPrompt(opts: ImagenGenerateOptions): string {
  const aspect = opts.aspectRatio ?? "1:1";
  const parts: string[] = [
    "Task: GENERATE a brand-new studio product photo from this description.",
    "",
    `Product description: ${opts.prompt.trim()}`,
  ];

  if (opts.productContext && opts.productContext.trim()) {
    parts.push(`Additional context: ${opts.productContext.trim()}`);
  }

  parts.push(
    "",
    "CRITICAL RULES — these are non-negotiable:",
    "- Pure white background (#FFFFFF). No gradient, no off-white, no scenery.",
    "- Soft, even three-point studio lighting (key from above-front, fill from",
    "  the side, soft rim). Looks like a professional product photographer shot it.",
    "- Subtle natural drop shadow directly under the product. No harsh shadow.",
    "- Centre the product in the frame with ~10% padding on all sides.",
    "- No text overlays, no watermarks, no logos other than what's part of the",
    "  product itself, no price tags, no 'Sale!' stickers, no human hands.",
    "- No lifestyle props, no contextual setting (kitchen counter, table, etc.).",
    "  JUST the product cleanly lit on white.",
    `- Output a ${ASPECT_HINTS[aspect]}, high-resolution, JPG quality.`,
    "- Photorealistic — looks like a real photograph, NOT 3D-rendered or",
    "  cartoony. Sharp focus on the product.",
    "",
    "Think of this as a catalogue page hero shot for an e-commerce marketplace",
    "(specifically Jumia Ghana). It must pass marketplace QC: white background,",
    "no overlay text, no human models, photorealistic.",
  );

  return parts.join("\n");
}

// ─── REST call (now via SDK, text-only) ─────────────────────────────────────

async function callGeminiTextToImage(prompt: string): Promise<Buffer> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_API_KEY not set");

  const genAI = new GoogleGenerativeAI(apiKey);

  let lastErr: Error | null = null;
  for (const modelName of PREFERRED_MODELS) {
    try {
      const model  = genAI.getGenerativeModel({ model: modelName });
      const result = await Promise.race([
        model.generateContent([{ text: prompt }]),
        new Promise<never>((_, rej) =>
          setTimeout(
            () => rej(new Error(`Gemini timed out after ${PER_IMAGE_TIMEOUT_MS}ms`)),
            PER_IMAGE_TIMEOUT_MS,
          ),
        ),
      ]);

      const parts = result.response.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        const inline = (part as { inlineData?: { data: string; mimeType: string } })
          .inlineData;
        if (inline?.data) {
          return Buffer.from(inline.data, "base64");
        }
      }
      // No image part — the model may have refused the prompt and returned
      // text-only feedback. Surface that to the caller.
      const textPart = parts.find(
        (p) => typeof (p as { text?: string }).text === "string",
      ) as { text?: string } | undefined;
      throw new Error(
        textPart?.text
          ? `Gemini returned no image. Model said: "${textPart.text.slice(0, 200)}"`
          : "Gemini returned no image and no text",
      );
    } catch (e) {
      lastErr = e as Error;
      const msg = lastErr.message ?? "";
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

export async function generateProductImage(
  userId: string,
  opts: ImagenGenerateOptions,
): Promise<ImagenGenerateResult> {
  const prompt = buildImagenPrompt(opts);

  const t0 = Date.now();
  const buffer = await callGeminiTextToImage(prompt);
  const elapsed = Date.now() - t0;

  if (buffer.length < 1024) {
    throw new Error("Gemini returned an empty image");
  }

  const storagePath = `${userId}/generated/${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
  const db = createServerClient();
  const { error } = await db.storage.from(BUCKET).upload(storagePath, buffer, {
    contentType: "image/jpeg",
    upsert:      false,
  });
  if (error) {
    throw new Error(`Generated image upload failed: ${error.message}`);
  }

  const { data } = db.storage.from(BUCKET).getPublicUrl(storagePath);
  console.info(
    `[imagen] text-to-image prompt-len=${prompt.length} size=${buffer.length}B elapsed=${elapsed}ms → ${data.publicUrl}`,
  );

  return {
    publicUrl:   data.publicUrl,
    storagePath,
    size:        buffer.length,
  };
}

export function isImagenEnabled(): boolean {
  return Boolean(process.env.GOOGLE_API_KEY);
}
