"use server";

import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";

const BUCKET = "product-images";

/**
 * Upload an array of File objects to Supabase Storage.
 * Returns an array of public URLs.
 */
export async function uploadProductImages(formData: FormData): Promise<string[]> {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthenticated");

  const db = createServerClient();
  const files = formData.getAll("files") as File[];
  if (!files.length) return [];

  const urls: string[] = [];

  for (const file of files) {
    const ext = file.name.split(".").pop() ?? "jpg";
    const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    const buffer = Buffer.from(await file.arrayBuffer());

    const { error } = await db.storage.from(BUCKET).upload(path, buffer, {
      contentType: file.type,
      upsert: false,
    });

    if (error) throw new Error(`Upload failed: ${error.message}`);

    const { data } = db.storage.from(BUCKET).getPublicUrl(path);
    urls.push(data.publicUrl);
  }

  return urls;
}

/**
 * Download remote image URLs and re-upload them to our Supabase bucket.
 * Used for URL-import mode where images come from a scraped product page.
 * Returns public URLs pointing to our storage (so Jumia can reach them).
 */
export async function uploadRemoteImages(
  remoteUrls: string[],
  userId: string
): Promise<string[]> {
  const db = createServerClient();
  const urls: string[] = [];

  const UA =
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

  for (const remoteUrl of remoteUrls.slice(0, 8)) {
    try {
      const res = await fetch(remoteUrl, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue;

      const contentType = res.headers.get("content-type") ?? "image/jpeg";
      if (!contentType.startsWith("image/")) continue;

      const ext =
        contentType.includes("png")
          ? "png"
          : contentType.includes("webp")
          ? "webp"
          : "jpg";

      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length < 1024) continue; // skip tiny files (< 1 KB)

      const path = `${userId}/${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}.${ext}`;

      const { error } = await db.storage
        .from(BUCKET)
        .upload(path, buffer, { contentType, upsert: false });

      if (error) {
        console.warn(`[uploadRemoteImages] skipped ${remoteUrl}: ${error.message}`);
        continue;
      }

      const { data } = db.storage.from(BUCKET).getPublicUrl(path);
      urls.push(data.publicUrl);
    } catch (e) {
      console.warn(
        `[uploadRemoteImages] failed for ${remoteUrl}: ${(e as Error).message}`
      );
    }
  }

  return urls;
}
