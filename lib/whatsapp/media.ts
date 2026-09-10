import { downloadMedia } from "@/lib/whatsapp/client";
import { validateImageBuffer } from "@/lib/actions/upload";
import { createServerClient } from "@/lib/supabase/server";

// Same bucket the web upload paths write to — Jumia (and everything else
// downstream) just needs a public URL, it doesn't care which flow produced it.
const BUCKET = "product-images";

/**
 * Download a WhatsApp media attachment by its id, validate it with the same
 * magic-byte + size-cap rules as any other upload (see validateImageBuffer),
 * and store it in the shared Supabase bucket. Returns the public URL, or
 * null if the attachment failed validation — the caller tells the seller
 * why rather than silently dropping their photo.
 */
export async function ingestWhatsAppImage(mediaId: string, userId: string): Promise<string | null> {
  const buffer = await downloadMedia(mediaId);

  const validated = await validateImageBuffer(buffer, `whatsapp-media-${mediaId}`);
  if (!validated) return null;

  const db = createServerClient();
  const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${validated.ext}`;

  const { error } = await db.storage.from(BUCKET).upload(path, buffer, {
    contentType: validated.mime,
    upsert: false,
  });
  if (error) {
    console.warn(`[whatsapp media] storage write failed for media ${mediaId}: ${error.message}`);
    return null;
  }

  const { data } = db.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}
