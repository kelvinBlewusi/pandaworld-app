import { appUrl } from "@/lib/whatsapp/app-url";
import { createConnectToken } from "@/lib/jumia/connect-token";
import { updateSession } from "@/lib/whatsapp/session";
import { sendCtaUrlIfConfigured } from "@/lib/whatsapp/client";
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

// return_to (see lib/jumia/return-to.ts) rides through /api/jumia/connect's
// OAuth `state` param to /api/jumia/callback, which passes it on to
// /onboarding/done — without it, that page's default CTA drops a seller
// who started from WhatsApp onto the old web dashboard (/dashboard)
// instead of back into the WhatsApp listing flow they came from.
const WHATSAPP_RETURN_TO = "/extension/whatsapp-listings";

export function jumiaConnectLink(token: string): string {
  return `${appUrl()}/api/jumia/connect?wa_token=${token}&return_to=${encodeURIComponent(WHATSAPP_RETURN_TO)}`;
}

export function jumiaRedirectUri(): string {
  return `${appUrl()}/api/jumia/callback`;
}

// Zero-width spaces/joiners, left/right-to-left marks, line/paragraph
// separators, and the BOM — characters that render as nothing but break
// an exact-match comparison. Mobile keyboards and some copy sources can
// inject these silently; a Client ID/Secret carrying one would fail
// Jumia's exact match with nothing visibly wrong in the chat.
const INVISIBLE_CHARS_RE = /[\u200B-\u200F\u2028\u2029\uFEFF]/g;

function stripInvisibleChars(s: string): string {
  return s.replace(INVISIBLE_CHARS_RE, "");
}

/** Splits a pasted message into non-empty tokens on whitespace/newlines —
 *  how a seller pastes "Client ID" and "Client Secret", together or apart. */
export function splitCredentialTokens(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean).map(stripInvisibleChars);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Jumia's Client ID is always a UUID; the Client Secret never is — so
 * sort the pasted pair by shape rather than trusting paste order.
 * Confirmed live: a seller pasted Secret-then-ID (the reverse of the
 * connect instructions' own "Client ID, then Client Secret" order),
 * which a purely positional [appId, secretKey] = tokens assignment
 * silently swapped, sending the wrong values to Jumia and failing with
 * "Invalid App ID or Secret Key" even though the same credentials worked
 * fine on the website's own labeled-field form. Falls back to the given
 * order when neither or both tokens look like a UUID — still the
 * seller's best guess, and no worse than before this existed.
 */
export function identifyCredentials(a: string, b: string): { appId: string; secretKey: string } {
  const aIsUuid = UUID_RE.test(a.trim());
  const bIsUuid = UUID_RE.test(b.trim());
  if (bIsUuid && !aIsUuid) return { appId: b, secretKey: a };
  return { appId: a, secretKey: b };
}

/**
 * Loose plausibility check for one pasted credential token — a real Client
 * ID is always a 36-char UUID and a real Client Secret is always a long
 * random string, so anything shorter than this is never a real credential.
 * Confirmed live: a seller's stray "Okay" got silently accepted as the
 * Client ID (no check existed before this), then "Ok" as the Client
 * Secret, wasting a real Jumia API call on two words that obviously
 * weren't credentials before finally surfacing "Invalid App ID or Secret
 * Key" — no clearer to the seller than if it had been caught immediately.
 * Deliberately loose (length only, no format check) since a seller may
 * legitimately paste the Secret before the ID (identifyCredentials sorts
 * that out by shape after both halves arrive) — this only needs to rule
 * out conversational replies, not validate the actual credential shape.
 */
export function looksLikeCredential(token: string): boolean {
  return token.trim().length >= 16;
}

export function isResendCommand(text: string): boolean {
  return /^resend[.!]?$/i.test(text.trim());
}

export const VENDOR_CENTER_URL = "https://vendorcenter.jumia.com";

/**
 * The one-time setup that keeps a seller connected for good: a Jumia
 * Self Authorization application and a generated token (see
 * lib/jumia/self-auth.ts). A Web Application, which these steps used to
 * describe, never gets a refresh token from Jumia and expires daily.
 */
export const SELF_AUTH_STEPS = [
  `1. Open Jumia Vendor Center and sign in (tap below, or go to ${VENDOR_CENTER_URL}).`,
  "2. Go to Settings → Applications → Create Application → choose *Self Authorization*.",
  `3. Name it "PandaWorld" and create it.`,
  "4. Next to PandaWorld, in the Actions column, tap the *orange lock icon* (Generate Token) and copy the token.",
  "5. Copy the Client ID and the token, then paste them here — together, or one at a time.",
].join("\n");

export function buildConnectInstructions(): string {
  return ["Let's connect your Jumia store. You only do this once: PandaWorld keeps it connected after that.", "", SELF_AUTH_STEPS].join("\n");
}

/**
 * The Jumia country a WhatsApp number most likely sells in, from its
 * dialling code; Ghana (where most sellers are) otherwise. Numbers arrive
 * from Meta as digits with the country code and no "+".
 */
const DIALLING_CODES: [prefix: string, country: string][] = [
  ["233", "GH"], ["234", "NG"], ["254", "KE"], ["20", "EG"],
  ["212", "MA"], ["221", "SN"], ["225", "CI"], ["256", "UG"],
];

export function countryFromPhone(phoneNumber: string): string {
  const digits = phoneNumber.replace(/\D/g, "");
  return DIALLING_CODES.find(([prefix]) => digits.startsWith(prefix))?.[1] ?? "GH";
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
  if (kind === "needs_oauth") {
    await updateSession(phoneNumber, { state: "awaiting_jumia_oauth", ...CLEAR_BATCH });
    const token = await createConnectToken(userId);
    await sendCtaUrlIfConfigured(
      phoneNumber,
      `${prefix}Your Jumia credentials are already on file — tap below to finish connecting. I'll message you here once it's done.`,
      "Connect Jumia",
      jumiaConnectLink(token),
    );
    return;
  }

  // Everything else ends in the seller pasting a Client ID and a generated
  // token here (handleAwaitingJumiaCredentials in lib/whatsapp/intake.ts).
  await updateSession(phoneNumber, { state: "awaiting_jumia_credentials", ...CLEAR_BATCH });

  if (kind === "needs_new_token") {
    await sendCtaUrlIfConfigured(
      phoneNumber,
      `${prefix}Jumia stopped accepting PandaWorld's saved token (it was regenerated, or the application was deleted in Vendor Center).\n\n` +
        "In Vendor Center → Settings → Applications, tap the *orange lock icon* next to PandaWorld to generate a new token, then paste the Client ID and the new token here.",
      "Open Vendor Center",
      VENDOR_CENTER_URL,
    );
    return;
  }

  if (kind === "needs_reconnect") {
    // A Web Application connection that ran out: offer the permanent fix,
    // and a login link for anyone who needs to list right now.
    await sendCtaUrlIfConfigured(
      phoneNumber,
      `${prefix}Your Jumia connection expired: the kind of application you set up needs a new login about once a day.\n\n` +
        `Set up automatic access once and it won't happen again:\n${SELF_AUTH_STEPS}`,
      "Open Vendor Center",
      VENDOR_CENTER_URL,
    );
    const token = await createConnectToken(userId);
    await sendCtaUrlIfConfigured(
      phoneNumber,
      "Need to list right now? Log in again for today instead:",
      "Log in to Jumia",
      jumiaConnectLink(token),
    );
    return;
  }

  // needs_credentials — never connected at all
  await sendCtaUrlIfConfigured(
    phoneNumber,
    `${prefix}${buildConnectInstructions()}`,
    "Open Vendor Center",
    VENDOR_CENTER_URL,
  );
}
