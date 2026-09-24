/**
 * Structured, queryable error trail (app_errors) — a companion to the
 * console.error calls already scattered through the codebase, which only
 * ever live in Vercel's runtime logs: ephemeral, rate-limited, and slow
 * to search across a wide time range (confirmed live, 2026-09-24 —
 * several log queries here timed out or hit a billing limit even scoped
 * to a single deployment and a two-minute window).
 *
 * Deliberately NOT a replacement for console.error — that stays for
 * real-time visibility while a deploy is being watched. This is for
 * "what went wrong for this seller, three days ago" — a question the
 * console never answers once the log window has rolled off.
 *
 * Fire-and-forget and self-swallowing, same rule as message-log.ts: a
 * failure to log an error must never itself throw and mask the original
 * one.
 */

import { createServerClient } from "@/lib/supabase/server";

export function logAppError(
  source:  string,
  error:   unknown,
  context: Record<string, unknown> = {},
): void {
  const message = error instanceof Error ? error.message : String(error);
  const stack   = error instanceof Error ? (error.stack ?? null) : null;

  void (async () => {
    try {
      const db = createServerClient();
      const { error: insertError } = await db.from("app_errors").insert({
        source,
        message,
        stack,
        context,
      });
      if (insertError) console.warn(`[app-errors] insert failed: ${insertError.message}`);
    } catch (e) {
      console.warn(`[app-errors] insert threw: ${(e as Error).message}`);
    }
  })();
}
