"use server";

import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import { fileTypeFromBuffer } from "file-type";

const BUCKET = "product-images";

// ─── Server-side upload guards ───────────────────────────────────────────────
//
// We never trust the client-supplied `file.type` header — a malicious
// caller can stamp "image/jpeg" on a .exe and we'd happily host it on
// our public bucket. Instead we read the magic bytes via file-type and
// validate against an allow-list, with a server-side size cap on top.
//
// Numbers chosen so they don't bite real sellers:
//   - 5 MB matches the largest legitimate phone-camera JPG; Jumia's
//     own limit per image is 2 MB but we accept up to 5 MB locally
//     because we'll polish/enhance through PhotoRoom/Gemini which
//     re-encode anyway.
//   - 50 bytes minimum keeps obviously-corrupt 0-byte uploads out.

const MAX_BYTES = 5 * 1024 * 1024;
const MIN_BYTES = 50;

// Jumia accepts ONLY JPEG/JPG/PNG. WebP, HEIC, GIF, AVIF etc. trigger the
// "Product Image extension [webp] is not allowed" rejection at push time —
// so we reject them at upload to save the seller a wasted submission.
// The server is the authoritative gate; the file inputs also restrict
// accept= to the same list as a UX hint.
const ALLOWED_MIMES = new Set([
  "image/jpeg",
  "image/png",
]);

/**
 * Magic-byte validation. Returns the detected MIME or null when invalid.
 * Exported so other ingestion paths that don't go through a browser
 * File/FormData (e.g. lib/whatsapp/media.ts, downloading an incoming
 * WhatsApp attachment) can reuse the same size-cap + real-format checks
 * instead of duplicating them.
 */
export async function validateImageBuffer(
  buf: Buffer,
  filenameHint: string,
): Promise<{ mime: string; ext: string } | null> {
  if (buf.byteLength < MIN_BYTES) {
    console.warn(`[upload] rejected ${filenameHint}: too small (${buf.byteLength}B)`);
    return null;
  }
  if (buf.byteLength > MAX_BYTES) {
    console.warn(`[upload] rejected ${filenameHint}: too large (${buf.byteLength}B > ${MAX_BYTES}B)`);
    return null;
  }
  const detected = await fileTypeFromBuffer(buf);
  if (!detected || !ALLOWED_MIMES.has(detected.mime)) {
    console.warn(
      `[upload] rejected ${filenameHint}: magic bytes say "${detected?.mime ?? "unknown"}"; ` +
      `only ${Array.from(ALLOWED_MIMES).join("/")} allowed.`,
    );
    return null;
  }
  return { mime: detected.mime, ext: detected.ext };
}

/**
 * Upload an array of File objects to Supabase Storage.
 * Returns an array of public URLs.
 *
 * Skips any file that fails server-side validation (size cap or
 * magic-byte mismatch) — the seller sees fewer images, not a hard
 * error, so a single bad picker click doesn't blow up the whole
 * batch upload.
 */
export async function uploadProductImages(formData: FormData): Promise<string[]> {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthenticated");

  const db = createServerClient();
  const files = formData.getAll("files") as File[];
  if (!files.length) return [];

  const urls: string[] = [];

  for (const file of files) {
    const buffer = Buffer.from(await file.arrayBuffer());

    const validated = await validateImageBuffer(buffer, file.name || "(unnamed)");
    if (!validated) continue;

    // Use the detected extension (e.g. "jpg"), NOT whatever was on the
    // filename. A file named "logo.png" that's actually a JPEG would
    // otherwise get stored with the wrong extension and confuse CDN
    // sniffing downstream.
    const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${validated.ext}`;

    const { error } = await db.storage.from(BUCKET).upload(path, buffer, {
      contentType: validated.mime,
      upsert: false,
    });

    if (error) {
      console.warn(`[upload] storage write failed for ${file.name || "(unnamed)"}: ${error.message}`);
      continue;
    }

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

  // Real Chrome UA — Googlebot is blocked by most CDNs and image hosts
  const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  for (const remoteUrl of remoteUrls.slice(0, 8)) {
    // Defence against SSRF / scheme tricks: only allow http(s) URLs.
    // Without this, a scraped page that put `javascript:` or `file://`
    // into an <img src> would have made it here and either errored
    // weirdly or hit our internal network.
    try {
      const parsed = new URL(remoteUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        console.warn(`[uploadRemoteImages] rejected non-http(s) URL: ${remoteUrl}`);
        continue;
      }
    } catch {
      console.warn(`[uploadRemoteImages] rejected malformed URL: ${remoteUrl}`);
      continue;
    }

    try {
      const res = await fetch(remoteUrl, {
        headers: {
          "User-Agent":      UA,
          Accept:            "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          // Pretend the request came from the source page (helps with hotlink protection)
          Referer:           (() => { try { return new URL(remoteUrl).origin + "/"; } catch { return ""; } })(),
        },
        signal: AbortSignal.timeout(15_000),
        redirect: "follow",
      });
      if (!res.ok) {
        console.warn(`[uploadRemoteImages] HTTP ${res.status} for ${remoteUrl}`);
        continue;
      }

      // Hard size cap BEFORE we buffer the response — protects against
      // a malicious source serving multi-GB content. Content-Length is
      // advisory (could lie), but it catches the obvious cases cheaply.
      const declaredLen = Number(res.headers.get("content-length") ?? "0");
      if (declaredLen > MAX_BYTES) {
        console.warn(`[uploadRemoteImages] rejected ${remoteUrl}: declared size ${declaredLen}B > ${MAX_BYTES}B`);
        continue;
      }

      const buffer = Buffer.from(await res.arrayBuffer());

      // Magic-byte validation — the server header on the source might
      // say "image/jpeg" but the actual bytes could be anything. Belt
      // and braces.
      const validated = await validateImageBuffer(buffer, remoteUrl);
      if (!validated) continue;

      const path = `${userId}/${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}.${validated.ext}`;

      const { error } = await db.storage
        .from(BUCKET)
        .upload(path, buffer, { contentType: validated.mime, upsert: false });

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
