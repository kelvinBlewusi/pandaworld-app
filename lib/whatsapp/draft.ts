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

/** Matches "done", "Done.", "DONE!" — tolerant of case and trailing punctuation. */
export function isDoneMessage(text: string): boolean {
  return /^done[.!]?$/i.test(text.trim());
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
