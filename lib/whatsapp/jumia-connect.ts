import { appUrl } from "@/lib/whatsapp/app-url";
import { createConnectToken } from "@/lib/jumia/connect-token";
import { updateSession } from "@/lib/whatsapp/session";
import { sendTextIfConfigured, sendCtaUrlIfConfigured } from "@/lib/whatsapp/client";
import type { JumiaConnectionKind } from "@/lib/jumia/credentials";

/**
 * Helpers for connecting Jumia entirely from a WhatsApp chat. Most of this
 * file is pure parsing/formatting, split out from lib/whatsapp/intake.ts
 * for the same reason lib/whatsapp/batch.ts and draft.ts are — unit-
 * testable without pulling in Supabase/AI-pipeline transitive deps.
 * promptJumiaConnection is the one exception (it does real IO): it's the
 * single place that decides what to say and what session state to set for
 * each JumiaConnectionKind, shared by both call sites that need it — the
 * LINK-code branch in app/api/whatsapp/webhook/route.ts and the
 * defensive re-check in lib/whatsapp/intake.ts's handleAwaitingCount —
 * so the two can never drift out of sync on copy or on which state a
 * given kind maps to.
 */

export function jumiaConnectLink(token: string): string {
  return `${appUrl()}/api/jumia/connect?wa_token=${token}`;
}

export function jumiaRedirectUri(): string {
  return `${appUrl()}/api/jumia/callback`;
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
    "1. Open Jumia Vendor Center and sign in: https://vendorcenter.jumia.com",
    "2. Go to Settings → Applications → Create Application → Web Application (OAuth).",
    `3. Set the Redirect URI to: ${redirectUri}`,
    "4. Copy the Client ID and Client Secret, then paste them here — together, or one at a time.",
  ].join("\n");
}

const CLEAR_BATCH = { listingId: null, batchId: null, batchSize: null, batchSeq: null, pendingAppId: null } as const;

/**
 * Puts the session into the right Jumia-connect state for `kind` and
 * sends the matching message — `prefix` is prepended (e.g. "✅ Your
 * WhatsApp is now linked to PandaWorld!\n\n" right after linking; empty
 * when re-checking mid-conversation, since the seller's already linked).
 * Never called for kind === "connected" — callers check that first and
 * proceed with the real listing flow instead.
 */
export async function promptJumiaConnection(
  userId: string,
  phoneNumber: string,
  kind: Exclude<JumiaConnectionKind, "connected">,
  prefix = "",
): Promise<void> {
  if (kind === "needs_oauth" || kind === "needs_reconnect") {
    await updateSession(phoneNumber, { state: "awaiting_jumia_oauth", ...CLEAR_BATCH });
    const token = await createConnectToken(userId);
    const body = kind === "needs_reconnect"
      ? `${prefix}Your Jumia connection expired — tap below to reconnect (no need to re-enter anything). I'll message you here once it's done.`
      : `${prefix}Your Jumia credentials are already on file — tap below to finish connecting. I'll message you here once it's done.`;
    await sendCtaUrlIfConfigured(
      phoneNumber,
      body,
      kind === "needs_reconnect" ? "Reconnect Jumia" : "Connect Jumia",
      jumiaConnectLink(token),
    );
    return;
  }

  // needs_credentials — never connected at all
  await updateSession(phoneNumber, { state: "awaiting_jumia_credentials", ...CLEAR_BATCH });
  await sendTextIfConfigured(phoneNumber, `${prefix}${buildConnectInstructions(jumiaRedirectUri())}`);
}
