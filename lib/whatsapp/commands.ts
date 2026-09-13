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
  | { type: "retry"; seq: number | null }
  | { type: "disconnect" }
  | { type: "confirm_disconnect" }
  | { type: "keep_connected" }
  | { type: "reconnect_jumia" }
  | { type: "status" }
  | { type: "help" };

const RESTART_RE = /^(restart|start over|start again|cancel|stop|new batch|reset)[.!]?$/i;
// "Retry" is the deliberate opposite of "restart": same batch, same photos,
// run the failed step again. Every error message pairs the two (see
// replyError in lib/whatsapp/intake.ts), because after a failure those are
// the only two things a seller ever wants and neither was reachable
// without knowing a phrase. An optional product number scopes it to one
// product, which is what the per-product failure messages send.
const RETRY_RE = /^retry(?:\s+(?:product\s*)?(\d+))?(?:\s+(?:that|again|it))?[.!]?$/i;
const CONFIRM_DISCONNECT_RE = /^confirm disconnect[.!]?$/i;
// A dedicated phrase for "no, don't disconnect" — deliberately NOT "cancel"
// (already claimed by RESTART_RE above to mean "abandon the current batch").
// Reusing "cancel" here would let tapping the disconnect prompt's "no"
// button be misread as restarting a batch instead of just declining.
const KEEP_CONNECTED_RE = /^keep jumia connected[.!]?$/i;
const DISCONNECT_RE = /^disconnect( jumia)?[.!]?$/i;
// The "Reconnect Jumia" button on the web-disconnect notice
// (app/api/jumia/disconnect/route.ts) — a global command (not tied to any
// one session state) since a seller could tap it from a stale/leftover
// state left over from before they disconnected.
const RECONNECT_JUMIA_RE = /^reconnect jumia[.!]?$/i;
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
  if (RECONNECT_JUMIA_RE.test(t)) return { type: "reconnect_jumia" };
  if (RESTART_RE.test(t)) return { type: "restart" };
  const retry = RETRY_RE.exec(t);
  if (retry) return { type: "retry", seq: retry[1] ? Number(retry[1]) : null };
  if (STATUS_RE.test(t)) return { type: "status" };
  if (HELP_RE.test(t)) return { type: "help" };
  return null;
}
