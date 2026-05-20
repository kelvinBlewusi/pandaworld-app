/**
 * Symmetric encryption for OAuth + API tokens stored in Supabase.
 *
 * Why this exists: Jumia OAuth access + refresh tokens give an attacker
 * the keys to a seller's vendor center. They used to sit in plain text
 * in `jumia_connections.access_token` / `.refresh_token`. A single
 * Supabase row breach would have exposed every connected seller's
 * marketplace credentials. Now they're AES-256-GCM encrypted at rest
 * with an app-managed key.
 *
 * Format of encrypted strings: `enc:v1:<iv>:<tag>:<ciphertext>` (each
 * segment base64). The "enc:v1:" prefix lets `decrypt()` distinguish
 * encrypted-with-this-scheme from legacy plaintext rows, so we can
 * roll the change out without a one-shot migration — existing plain
 * tokens keep working, get encrypted on the next refresh-or-write.
 *
 * The key is loaded from ENCRYPTION_KEY (hex string, 64 chars = 32
 * bytes). Generate one with:
 *
 *     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * Set the value in Vercel → Project Settings → Environment Variables.
 * NEVER commit it. To rotate, set ENCRYPTION_KEY_PREVIOUS to the old
 * key while ENCRYPTION_KEY holds the new one — decrypt() tries both.
 * Once every token has been re-encrypted (visible as `enc:v1:…`
 * prefixes), drop ENCRYPTION_KEY_PREVIOUS.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX  = "enc:v1:";
const ALGO    = "aes-256-gcm";
const IV_LEN  = 12;  // 96 bits — GCM standard
const TAG_LEN = 16;

function loadKey(envName: string): Buffer | null {
  const hex = process.env[envName];
  if (!hex || !hex.trim()) return null;
  const clean = hex.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error(
      `${envName} must be exactly 64 hex characters (32 bytes / 256 bits). Got ${clean.length} chars.`,
    );
  }
  return Buffer.from(clean, "hex");
}

function getActiveKey(): Buffer {
  const key = loadKey("ENCRYPTION_KEY");
  if (!key) {
    throw new Error(
      "ENCRYPTION_KEY is not set. Generate one with: node -e " +
      "\"console.log(require('crypto').randomBytes(32).toString('hex'))\" " +
      "and set it in your Vercel env vars.",
    );
  }
  return key;
}

function getPreviousKey(): Buffer | null {
  try {
    return loadKey("ENCRYPTION_KEY_PREVIOUS");
  } catch {
    // Misformatted previous key — log but don't crash; current key
    // is what matters for ongoing operations.
    console.warn("[token-crypto] ENCRYPTION_KEY_PREVIOUS is set but malformed — ignoring.");
    return null;
  }
}

/**
 * Encrypt a plaintext string with the active key.
 *
 * Returns a self-describing token (`enc:v1:<iv_b64>:<tag_b64>:<ct_b64>`).
 * Idempotent: feeding an already-encrypted string back in returns it
 * unchanged so callers don't have to keep track of state.
 */
export function encrypt(plaintext: string): string {
  if (!plaintext) return plaintext;
  if (isEncrypted(plaintext)) return plaintext;

  const key = getActiveKey();
  const iv  = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (tag.byteLength !== TAG_LEN) {
    throw new Error(`[token-crypto] unexpected auth tag length ${tag.byteLength}`);
  }
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

/**
 * Decrypt a value. Plaintext / sentinel strings pass through unchanged
 * so this is safe to call on every read, including rows written before
 * encryption shipped.
 *
 * Throws when the value LOOKS encrypted (`enc:v1:` prefix) but neither
 * the active key nor the previous key can decrypt it — that's data
 * corruption, not a routine failure.
 */
export function decrypt(value: string | null | undefined): string {
  if (!value) return "";
  if (!isEncrypted(value)) return value;

  const parts = value.slice(PREFIX.length).split(":");
  if (parts.length !== 3) {
    throw new Error("[token-crypto] malformed encrypted token (expected iv:tag:ciphertext)");
  }
  const [ivB64, tagB64, ctB64] = parts;
  const iv  = Buffer.from(ivB64,  "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ct  = Buffer.from(ctB64,  "base64");
  if (iv.byteLength !== IV_LEN || tag.byteLength !== TAG_LEN) {
    throw new Error("[token-crypto] malformed encrypted token (iv/tag wrong length)");
  }

  const tryDecrypt = (key: Buffer): string | null => {
    try {
      const decipher = createDecipheriv(ALGO, key, iv);
      decipher.setAuthTag(tag);
      const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
      return pt.toString("utf8");
    } catch {
      return null;
    }
  };

  const fromActive = tryDecrypt(getActiveKey());
  if (fromActive != null) return fromActive;

  const prev = getPreviousKey();
  if (prev) {
    const fromPrev = tryDecrypt(prev);
    if (fromPrev != null) return fromPrev;
  }

  throw new Error(
    "[token-crypto] decrypt failed under all known keys. The token may have been written with a key you no longer have. Have the seller reconnect Jumia.",
  );
}

export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}
