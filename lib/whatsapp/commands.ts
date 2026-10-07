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
  | { type: "start_another" }
  | { type: "retry"; seq: number | null }
  | { type: "disconnect" }
  | { type: "confirm_disconnect" }
  | { type: "keep_connected" }
  | { type: "reconnect_jumia" }
  | { type: "how_it_works" }
  | { type: "status" }
  | { type: "help" }
  // The chat's commands (owner, 2026-10-07): the same words on WhatsApp and
  // in the Listing Assistant (its / and + menus send these).
  | { type: "menu" }
  | { type: "credits" }
  | { type: "polish"; seq: number | null }
  | { type: "report" }
  | { type: "shop_read"; what: ShopRead }
  // Clearing the web chat (lib/whatsapp/chat-clear.ts): asked, then the tap that clears it or keeps it.
  | { type: "clear"; step: "ask" | "now" | "keep" }
  // "Change" or "edit" alone: what to say after it.
  | { type: "edit_help" };

/** What the menu's shop commands read. */
export type ShopRead = "shop" | "out_of_stock" | "low_stock" | "sales_today" | "sales_week" | "payouts";

const RESTART_RE = /^(restart|start over|start again|cancel|stop|new batch|reset)[.!]?$/i;
// The "Start another" button on drafted and submitted messages
// (2026-10-03), and what a seller would type for it: a restart, worded for
// someone who is done rather than giving up.
const START_ANOTHER_RE = /^(start another|list another|list more)[.!]?$/i;
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
// Offered as a button beside the first-run welcome, and typeable forever
// after. Kept broad because a seller reaching for it is, by definition,
// someone who does not yet know the right words.
const HOW_IT_WORKS_RE = /^(how it works|how does (this|it) work|guide|how to use|how do i use (this|it))[.!?]?$/i;
const STATUS_RE = /^(status|where am i)[.!?]?$/i;
const HELP_RE = /^(help|\?)[.!]?$/i;
const MENU_RE = /^(menu|commands|\/)[.!]?$/i;
// "remaining credit" was read as a note about the batch just sent (owner's test, 2026-10-07).
const CREDITS_RE = new RegExp(
  "^(?:(?:my |check (?:my )?|show (?:my )?)?(?:credits?|credit balance|balance)" +
    "|(?:my )?(?:remaining|left) credits?|credits? (?:left|remaining)" +
    "|how many credits?(?: do i have| have i got| are left| left)?" +
    "|what(?:'s| is) my (?:credit )?balance)[.!?]?$",
  "i",
);
// "polish", "polish 2", "polish product 2", "polish 2 photos".
const POLISH_RE = /^polish(?:\s+(?:product\s*)?(\d{1,2}))?(?:\s+(?:photos?|pictures?|images?))?[.!]?$/i;
const CLEAR_RE = /^(clear|clear (the |my |this )?(chat|conversation|history|messages)|delete (the |my |this )?chat)[.!]?$/i;
const CLEAR_NOW_RE = /^clear chat now$/i;
const KEEP_CHAT_RE = /^keep (the |my )?chat$/i;
const EDIT_HELP_RE = /^(change|edit|edit (live )?on jumia|edit live|change a live product)[.!?]?$/i;
const REPORT_RE = /^(report|shop report|health report|shop health(?: report| check)?|health check)[.!?]?$/i;
const SHOP_READS: [RegExp, ShopRead][] = [
  [/^(my )?(shop|products)[.!?]?$/i, "shop"],
  [/^out of stock[.!?]?$/i, "out_of_stock"],
  [/^low stock[.!?]?$/i, "low_stock"],
  [/^sales( today)?[.!?]?$/i, "sales_today"],
  [/^sales (this )?week[.!?]?$/i, "sales_week"],
  [/^(my )?payouts?[.!?]?$/i, "payouts"],
];

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
  if (START_ANOTHER_RE.test(t)) return { type: "start_another" };
  const retry = RETRY_RE.exec(t);
  if (retry) return { type: "retry", seq: retry[1] ? Number(retry[1]) : null };
  if (HOW_IT_WORKS_RE.test(t)) return { type: "how_it_works" };
  if (STATUS_RE.test(t)) return { type: "status" };
  if (HELP_RE.test(t)) return { type: "help" };
  if (MENU_RE.test(t)) return { type: "menu" };
  if (CREDITS_RE.test(t)) return { type: "credits" };
  const polish = t.match(POLISH_RE);
  if (polish) return { type: "polish", seq: polish[1] ? Number(polish[1]) : null };
  if (REPORT_RE.test(t)) return { type: "report" };
  if (CLEAR_NOW_RE.test(t)) return { type: "clear", step: "now" };
  if (KEEP_CHAT_RE.test(t)) return { type: "clear", step: "keep" };
  if (CLEAR_RE.test(t)) return { type: "clear", step: "ask" };
  if (EDIT_HELP_RE.test(t)) return { type: "edit_help" };
  for (const [re, what] of SHOP_READS) if (re.test(t)) return { type: "shop_read", what };
  return null;
}
