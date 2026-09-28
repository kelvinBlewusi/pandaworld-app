/**
 * Keep Self Authorization connections alive (lib/jumia/self-auth.ts).
 *
 * Jumia rotates the refresh token on every exchange, and each one expires
 * (refresh_expires_in, about a day on Jumia's example). A seller who
 * doesn't use PandaWorld for longer than that would come back to a dead
 * connection, so /api/worker/jumia-keepalive runs this every 30 minutes
 * and renews any connection whose access or refresh token is within
 * RENEW_WITHIN_MS of expiring. Each renewal goes through
 * refreshJumiaConnection, which holds the per-seller refresh lock, stores
 * the rotated token, and only marks the connection needs_reconnect when
 * Jumia definitively refuses it.
 *
 * pg_cron checks every 30 minutes but only calls the route when some
 * connection is due, using the same rule as isDueForRenewal in SQL
 * (supabase/migrations/2026-09-28_cron-only-when-there-is-work.sql). Change
 * RENEW_WITHIN_MS and that check has to change with it.
 */

import { createServerClient } from "@/lib/supabase/server";
import { decrypt } from "@/lib/security/token-crypto";
import { refreshJumiaConnection } from "@/lib/jumia/api";

/** Renew when either token has less than this left. Well over the 30-minute tick, so a few failed ticks in a row still leave time. */
export const RENEW_WITHIN_MS = 6 * 60 * 60 * 1000;

interface ConnectionRow {
  user_id:                  string;
  refresh_token:            string | null;
  app_id:                   string | null;
  token_expires_at:         string | null;
  refresh_token_expires_at: string | null;
}

/** Whether a connection is close enough to expiry to renew now. Unknown expiry counts as due. */
export function isDueForRenewal(row: Pick<ConnectionRow, "token_expires_at" | "refresh_token_expires_at">, now: number): boolean {
  const soon = now + RENEW_WITHIN_MS;
  const dueAt = (iso: string | null) => !iso || new Date(iso).getTime() <= soon;
  return dueAt(row.token_expires_at) || dueAt(row.refresh_token_expires_at);
}

export interface KeepaliveResult {
  checked: number;
  renewed: number;
  /** Connections Jumia refused for good: the seller has to generate a new token. */
  lost:    number;
  /** Temporary failures (network, 5xx): retried next tick. */
  failed:  number;
}

export async function renewExpiringConnections(now = Date.now()): Promise<KeepaliveResult> {
  const db = createServerClient();
  const { data, error } = await db
    .from("jumia_connections")
    .select("user_id, refresh_token, app_id, token_expires_at, refresh_token_expires_at")
    .eq("auth_type", "self")
    .eq("status", "active")
    .not("refresh_token", "is", null);
  if (error) throw new Error(`Couldn't read Jumia connections: ${error.message}`);

  const rows = (data ?? []) as ConnectionRow[];
  const result: KeepaliveResult = { checked: rows.length, renewed: 0, lost: 0, failed: 0 };

  for (const row of rows) {
    if (!row.refresh_token || !isDueForRenewal(row, now)) continue;
    try {
      // No app secret: Self Authorization apps don't have one.
      await refreshJumiaConnection(db, row.user_id, decrypt(row.refresh_token), row.app_id ?? undefined, undefined);
      result.renewed++;
    } catch (e) {
      const message = (e as Error).message;
      if (message === "JUMIA_RECONNECT_REQUIRED") {
        result.lost++;
        console.error(`[jumia keepalive] ${row.user_id}'s connection was refused by Jumia; the seller must generate a new token`);
      } else {
        result.failed++;
        console.warn(`[jumia keepalive] couldn't renew ${row.user_id} this time: ${message}`);
      }
    }
  }
  return result;
}
