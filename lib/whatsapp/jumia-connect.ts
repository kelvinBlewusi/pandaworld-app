import { appUrl } from "@/lib/whatsapp/app-url";

/**
 * Pure parsing/formatting helpers for connecting Jumia entirely from a
 * WhatsApp chat — split out from lib/whatsapp/intake.ts for the same
 * reason lib/whatsapp/batch.ts and draft.ts are: unit-testable without
 * pulling in Supabase/AI-pipeline transitive deps.
 */

export function jumiaConnectLink(token: string): string {
  return `${appUrl()}/api/jumia/connect?wa_token=${token}`;
}

/** Splits a pasted message into non-empty tokens on whitespace/newlines —
 *  how a seller pastes "Client ID" and "Client Secret", together or apart. */
export function splitCredentialTokens(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

export function isResendCommand(text: string): boolean {
  return /^resend[.!]?$/i.test(text.trim());
}

export function buildConnectInstructions(redirectUri: string): string {
  return [
    "Let's connect your Jumia store.",
    "",
    "1. Open Jumia Vendor Center (vendorcenter.jumia.com) and sign in.",
    "2. Go to Settings → Applications → Create Application → Web Application (OAuth).",
    `3. Set the Redirect URI to: ${redirectUri}`,
    "4. Copy the Client ID and Client Secret, then paste them here — together, or one at a time.",
  ].join("\n");
}
