/**
 * New-order alerts on WhatsApp, run every 10 minutes by pg_cron through
 * /api/worker/order-alerts (supabase/migrations/2026-10-06_order-alerts.sql).
 * Jumia has no order webhooks, so each seller's pending orders are polled.
 *
 * For each seller with WhatsApp linked, Jumia connected and the
 * `order_alerts` feature (Pro pack and up, admins, grants):
 *   - quiet from 10pm to 7am in their country's timezone; orders that came
 *     in overnight go out together in the first run after 7am;
 *   - at most one alert per 30 minutes: orders arriving in between join the
 *     next one (one order: the order in full; several: one line each);
 *   - inside WhatsApp's 24 hours after the seller's last message (23, for a
 *     margin) our own message; outside it, the approved template set in
 *     app_settings `order_alert_template` ({"name": "jumia_new_order",
 *     "language": "en"}). With no template set, outside the window the alert
 *     waits until the seller next writes (WhatsApp wouldn't deliver it).
 * Each order is alerted once (order_alerts).
 */

import { createServerClient } from "@/lib/supabase/server";
import { hasFeature } from "@/lib/billing/features";
import { getValidJumiaCredentials } from "@/lib/jumia/api";
import { jumiaCountryByCode } from "@/lib/marketing/countries";
import { toPackItems, waitingOrders } from "@/lib/jumia/order-flow";
import { sendOrderAlert, sendOrderAlertTemplate } from "@/lib/whatsapp/orders";

export const ALERT_GAP_MS = 30 * 60_000;
export const WINDOW_MS    = 23 * 3_600_000;
const QUIET_FROM = 22;
const QUIET_TO   = 7;
/** New orders are looked for this far back: older pending ones were alerted, or predate alerts. */
const LOOKBACK_DAYS = 3;

/** True from 10pm to 7am in that timezone. */
export function inQuietHours(now: Date, timeZone: string): boolean {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone }).format(now));
  return hour >= QUIET_FROM || hour < QUIET_TO;
}

async function orderAlertTemplate(): Promise<{ name: string; language: string } | null> {
  const { data } = await createServerClient().from("app_settings").select("value").eq("key", "order_alert_template").maybeSingle();
  const v = data?.value as { name?: unknown; language?: unknown } | null | undefined;
  return typeof v?.name === "string" && /^[a-z0-9_]+$/.test(v.name) && typeof v.language === "string" && v.language
    ? { name: v.name, language: v.language }
    : null;
}

async function lastInboundAt(phone: string): Promise<number | null> {
  const { data } = await createServerClient()
    .from("whatsapp_message_log")
    .select("created_at")
    .eq("phone_number", phone)
    .eq("direction", "inbound")
    .order("created_at", { ascending: false })
    .limit(1);
  const at = (data as { created_at?: string }[] | null)?.[0]?.created_at;
  return at ? new Date(at).getTime() : null;
}

export interface OrderAlertsRun { sellers: number; alerted: number; held: number; failed: number }

export async function runOrderAlerts(now = new Date(), budgetMs = 45_000): Promise<OrderAlertsRun> {
  const started = Date.now();
  const db = createServerClient();
  const run: OrderAlertsRun = { sellers: 0, alerted: 0, held: 0, failed: 0 };

  const { data: links } = await db.from("whatsapp_connections").select("user_id, phone_number");
  const byUser = new Map<string, string>();
  for (const l of (links ?? []) as { user_id: string; phone_number: string }[]) if (!byUser.has(l.user_id)) byUser.set(l.user_id, l.phone_number);
  if (byUser.size === 0) return run;

  const { data: conns } = await db.from("jumia_connections").select("user_id, status").in("user_id", Array.from(byUser.keys()));
  const connected = ((conns ?? []) as { user_id: string; status: string }[]).filter((c) => c.status !== "revoked").map((c) => c.user_id);

  const template = await orderAlertTemplate();
  for (const userId of connected) {
    if (Date.now() - started > budgetMs) break;
    const phone = byUser.get(userId)!;
    try {
      if (!(await hasFeature(userId, "order_alerts"))) continue;
      run.sellers++;

      const { data: last } = await db.from("order_alerts").select("alerted_at").eq("user_id", userId).order("alerted_at", { ascending: false }).limit(1);
      const lastAt = (last as { alerted_at?: string }[] | null)?.[0]?.alerted_at;
      if (lastAt && now.getTime() - new Date(lastAt).getTime() < ALERT_GAP_MS) continue;

      const creds = await getValidJumiaCredentials(userId);
      const country = jumiaCountryByCode(creds.country);
      if (inQuietHours(now, country?.timeZone ?? "UTC")) continue;

      const w = await waitingOrders(creds.accessToken, LOOKBACK_DAYS);
      if (!w.ok) throw new Error(w.message);
      const toPack = w.data.filter((o) => toPackItems(o).length > 0);
      if (toPack.length === 0) continue;
      const { data: seen } = await db.from("order_alerts").select("order_id").eq("user_id", userId).in("order_id", toPack.map((o) => o.id));
      const seenIds = new Set(((seen ?? []) as { order_id: string }[]).map((s) => s.order_id));
      const fresh = toPack.filter((o) => !seenIds.has(o.id));
      if (fresh.length === 0) continue;

      const inbound = await lastInboundAt(phone);
      if (inbound != null && now.getTime() - inbound < WINDOW_MS) {
        await sendOrderAlert(phone, fresh, country);
      } else if (template) {
        await sendOrderAlertTemplate(phone, fresh, country, template);
      } else {
        // Outside the 24 hours with no approved template: WhatsApp wouldn't
        // deliver it. Not marked, so it goes out once the seller writes.
        run.held++;
        continue;
      }
      await db.from("order_alerts").upsert(
        fresh.map((o) => ({ user_id: userId, order_id: o.id, order_number: o.number, alerted_at: now.toISOString() })),
        { onConflict: "user_id,order_id", ignoreDuplicates: true },
      );
      run.alerted += fresh.length;
      console.info(`[order alerts] ${userId}: ${fresh.length} new order(s) alerted (${inbound != null && now.getTime() - inbound < WINDOW_MS ? "message" : "template"})`);
    } catch (e) {
      run.failed++;
      console.warn(`[order alerts] ${userId}: ${(e as Error).message}`);
    }
  }
  return run;
}
