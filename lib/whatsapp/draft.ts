/**
 * Pure text-shaping helpers for the WhatsApp draft-reply flow, split out
 * from lib/whatsapp/intake.ts so they're unit-testable without pulling in
 * that module's heavy transitive deps (Supabase client, the AI pipeline,
 * lib/actions/upload.ts's file-type import) — file-type is ESM-only and
 * breaks under this repo's ts-jest/commonjs Jest config the moment
 * anything merely imports it. Same reasoning as webhook-verify.ts being
 * split from the webhook route.
 */

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
  return isDoneWord(last, tokens.length === 1);
}

/**
 * Typos of "done", taken only as a whole message: "dine" was saved as a
 * product's note (owner's test, 2026-10-07). After a caption they stay
 * words ("fine dine set").
 */
const DONE_TYPOS = /^(dine|dne|doen|donee|doone|ddone|donw|donr|dobe|dpne|don|dome|domne)$/i;

/** "done", or (when it's the whole message) a slip of it. */
export function isDoneWord(word: string, whole: boolean): boolean {
  const w = word.replace(/^\*+/, "").replace(/[*.,!]+$/, "");
  return /^done$/i.test(w) || (whole && DONE_TYPOS.test(w));
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

/**
 * True when the whole message is one of this batch's product numbers
 * ("2", "#2", "2."), the way sending them all at once (way I) closes each
 * product. In guide-me mode it's neither a note nor a price — read as a
 * bare-number price, "3" once became a product's price (2026-10-04).
 */
export function isProductNumber(text: string, batchSize: number): boolean {
  const m = /^#?(\d{1,2})[.!]?$/.exec(text.trim());
  if (!m) return false;
  const n = Number(m[1]);
  return n >= 1 && n <= batchSize;
}
