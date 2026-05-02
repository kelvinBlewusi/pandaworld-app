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
