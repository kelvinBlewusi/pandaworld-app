import type { AutoAnalyzeResult } from "@/lib/actions/auto-analyze";
import { appUrl } from "@/lib/whatsapp/app-url";

/**
 * Pure text-shaping helpers for the WhatsApp draft-reply flow, split out
 * from lib/whatsapp/intake.ts so they're unit-testable without pulling in
 * that module's heavy transitive deps (Supabase client, the AI pipeline,
 * lib/actions/upload.ts's file-type import) — file-type is ESM-only and
 * breaks under this repo's ts-jest/commonjs Jest config the moment
 * anything merely imports it. Same reasoning as webhook-verify.ts being
 * split from the webhook route.
 */

export function reviewUrl(listingId: string): string {
  return `${appUrl()}/listings/${listingId}/review`;
}

/**
 * True when the seller's message or photo caption ends with a standalone
 * "done" — a bare "done"/"Done."/"DONE!" reply, but also "Price 40\nDone"
 * or "sizes M L XL, done" (a caption/note that finishes with the word).
 * Deliberately checks only the LAST token, not "does this text contain
 * done anywhere" — "done with the photos, one more coming" or "not done
 * yet" must NOT match, since "done" there isn't the seller signalling
 * they're finished.
 */
export function endsWithDoneSignal(text: string): boolean {
  const tokens = text.trim().split(/\s+/);
  const last = (tokens[tokens.length - 1] ?? "").replace(/[.,!]+$/, "");
  return /^done$/i.test(last);
}

/**
 * Removes a trailing standalone "done" (only call when
 * endsWithDoneSignal(text) is already true) so the rest of a caption/note
 * still gets saved — "Price 40\nDone" -> "Price 40". Returns "" when the
 * whole text was just the done-signal itself.
 */
export function stripDoneSignal(text: string): string {
  const tokens = text.trim().split(/\s+/);
  tokens.pop();
  return tokens.join(" ").trim();
}

export function formatDraftSummary(
  result: Extract<AutoAnalyzeResult, { ok: true }>,
  listingId: string,
): string {
  const title = result.title ?? "(untitled)";
  return [
    "📦 *Draft ready!*",
    title,
    `Category: ${result.category.path}`,
    `${result.attributes_filled} attribute(s) filled in automatically.`,
    "",
    "I can't guess your price or stock — you'll set those next.",
    "",
    `Finish and push it here: ${reviewUrl(listingId)}`,
  ].join("\n");
}
