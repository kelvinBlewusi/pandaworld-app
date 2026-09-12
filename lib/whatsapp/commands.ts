/**
 * Deterministic "global" commands recognized in ANY WhatsApp session
 * state — a seller can always back out of whatever they're doing (a
 * batch review, a stuck analyze, mid-connect) without needing to know
 * that state's own vocabulary. Checked in lib/whatsapp/intake.ts's
 * handleLinkedMessage BEFORE the per-state dispatch, so these always
 * take effect immediately — this is also the seller's manual escape
 * hatch out of the "analyzing" state if it ever gets wedged.
 *
 * Kept as fixed, deterministic whole-message phrases (not run through
 * the AI intent classifier) since these are system-scoped actions, not
 * free-form product edits — a false positive here (accidentally
 * resetting a batch or disconnecting Jumia) is much costlier than a
 * missed match, which just falls through to the state's own handling.
 * Free-form phrasing of the same intent ("let's just start over with a
 * new batch instead") is still caught downstream by
 * lib/whatsapp/intent.ts's AI fallback where that already runs
 * (awaiting_confirmation).
 */

export type GlobalCommand =
  | { type: "restart" }
  | { type: "disconnect" }
  | { type: "confirm_disconnect" }
  | { type: "keep_connected" }
  | { type: "status" }
  | { type: "help" };

const RESTART_RE = /^(restart|start over|start again|cancel|stop|new batch|reset)[.!]?$/i;
const CONFIRM_DISCONNECT_RE = /^confirm disconnect[.!]?$/i;
// A dedicated phrase for "no, don't disconnect" — deliberately NOT "cancel"
// (already claimed by RESTART_RE above to mean "abandon the current batch").
// Reusing "cancel" here would let tapping the disconnect prompt's "no"
// button be misread as restarting a batch instead of just declining.
const KEEP_CONNECTED_RE = /^keep jumia connected[.!]?$/i;
const DISCONNECT_RE = /^disconnect( jumia)?[.!]?$/i;
const STATUS_RE = /^(status|where am i)[.!?]?$/i;
const HELP_RE = /^(help|\?|commands)[.!]?$/i;

/** Order matters: "confirm disconnect" must be checked before the bare
 *  "disconnect" pattern, since the latter wouldn't otherwise be reached. */
export function parseGlobalCommand(text: string): GlobalCommand | null {
  const t = text.trim();
  if (!t) return null;
  if (CONFIRM_DISCONNECT_RE.test(t)) return { type: "confirm_disconnect" };
  if (KEEP_CONNECTED_RE.test(t)) return { type: "keep_connected" };
  if (DISCONNECT_RE.test(t)) return { type: "disconnect" };
  if (RESTART_RE.test(t)) return { type: "restart" };
  if (STATUS_RE.test(t)) return { type: "status" };
  if (HELP_RE.test(t)) return { type: "help" };
  return null;
}
