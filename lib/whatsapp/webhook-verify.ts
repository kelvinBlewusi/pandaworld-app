import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify Meta's X-Hub-Signature-256 header (HMAC-SHA256 of the raw request
 * body, keyed with the app secret) before trusting anything in the payload.
 * Split out from the route handler so it's unit-testable without spinning
 * up a NextRequest.
 */
export function verifyWhatsAppSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string | undefined,
): boolean {
  if (!appSecret || !signatureHeader) return false;
  const expectedHex = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const provided = signatureHeader.replace(/^sha256=/, "");
  let expected: Buffer, actual: Buffer;
  try {
    expected = Buffer.from(expectedHex, "hex");
    actual = Buffer.from(provided, "hex");
  } catch {
    return false;
  }
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Matches "LINK-A1B2C3D4" (and minor variations: no dash, lowercase, extra
 * space) anywhere in a message, not just as the whole message — the wa.me
 * deep link (lib/whatsapp/link.ts's createLinkCode) pre-fills a friendly
 * greeting ahead of the code ("Hi! I want to link... here is my connection
 * code: LINK-A1B2C3D4"), and a seller typing the code by hand may add their
 * own words around it too. Was anchored to the full trimmed message
 * (^...$) before, which would have silently failed to link anyone sending
 * that greeting. \b word boundaries (instead of ^/$) still require exactly
 * 8 alphanumeric characters — "LINK-A1B2C3D4E5" (9+ chars run) still
 * correctly matches nothing, same as before.
 */
export const LINK_CODE_RE = /\bLINK[-\s]?([A-Z0-9]{8})\b/i;

/** Extracts the 8-char code from a link message, or null if it doesn't match. */
export function extractLinkCode(text: string | undefined | null): string | null {
  if (!text) return null;
  const match = LINK_CODE_RE.exec(text.trim());
  return match ? match[1].toUpperCase() : null;
}
