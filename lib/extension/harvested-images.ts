/**
 * Photos the extension harvested from Vendor Center's form (content.js
 * harvestImages): a data: URL read from the upload input, or an https URL
 * of a photo Jumia already hosts. Shared by /api/extension/fill and
 * /api/extension/polish-images.
 */

/** Parse a data: URL into { base64, mimeType }, or null if not a data URL. */
export function parseDataUrl(s: string | undefined): { base64: string; mimeType: string } | null {
  if (!s) return null;
  const m = /^data:([^;,]+)(;base64)?,([\s\S]*)$/.exec(s);
  if (!m || !m[2]) return null; // require base64 encoding
  return { mimeType: m[1] || "image/jpeg", base64: m[3] };
}

/**
 * Sniff the real format from the file's magic bytes rather than trusting the
 * server's content-type header — production evidence (Vertex: "Provided
 * image is not valid") showed a CDN-fetched image failing 100% of the time
 * on an Edit-Product page, most likely because a missing/generic
 * content-type made us mislabel the bytes (e.g. real WEBP sent as the
 * "image/jpeg" fallback below). Returns null for anything that isn't a
 * recognised image format at all — including a 200-status HTML/error page,
 * which a naive content-type trust would otherwise forward straight to
 * Gemini as "image/jpeg".
 */
export function sniffImageMimeType(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buf.length >= 6 && ["GIF87a", "GIF89a"].includes(buf.toString("ascii", 0, 6))) return "image/gif";
  return null;
}

/** Fetch an http(s) image to base64 (used when only a preview URL was harvested). */
async function fetchToBase64(url: string): Promise<{ base64: string; mimeType: string }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`image fetch HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mimeType = sniffImageMimeType(buf);
  if (!mimeType) throw new Error(`fetched URL is not a recognised image format (${buf.length} bytes)`);
  return { base64: buf.toString("base64"), mimeType };
}

export async function resolveOneImage(item: { image?: string; imageUrl?: string }): Promise<{ base64: string; mimeType: string } | null> {
  const fromData = parseDataUrl(item.image);
  if (fromData) return fromData;
  if (item.imageUrl && /^https?:\/\//.test(item.imageUrl)) {
    try {
      return await fetchToBase64(item.imageUrl);
    } catch (e) {
      console.warn(`[ext/fill] could not fetch/validate imageUrl: ${(e as Error).message}`);
      return null;
    }
  }
  return null;
}
