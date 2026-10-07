/**
 * What the seller hears about their Jumia shop without asking (owner,
 * 2026-10-07), run every 10 minutes after the new-order alerts
 * (app/api/worker/order-alerts):
 *
 *   - A live-product change they confirmed that Jumia refused: read from its
 *     feed (lib/whatsapp/shop.ts sends it). A change Jumia applied is noted
 *     in the local catalog, silently: they were already told it was sent.
 *   - Orders that were delivered, returned, failed delivery or cancelled
 *     (`order_alerts`): grouped, at most every ORDER_UPDATES_GAP_MS, except a
 *     cancellation, which goes out at once (an item not to ship). Their own
 *     cancellations through the bot aren't told back (orders.ts marks them).
 *   - A Jumia payout that was paid (`shop_whatsapp`), checked every
 *     PAYOUT_CHECK_MS.
 *
 * The same rules as order alerts: only sellers with WhatsApp linked and Jumia
 * connected, not while the bot is paused for credits, never from 10pm to 7am
 * in their country, and only inside WhatsApp's 24 hours since their last
 * message (these have no approved template; outside it they wait). The first
 * run for a seller takes what's already there as known, so nothing old is
 * announced. Each thing is told once (shop_notices).
 */

import { createServerClient } from "@/lib/supabase/server";
import { hasFeature } from "@/lib/billing/features";
import { getFeedStatus, getValidJumiaCredentials } from "@/lib/jumia/api";
import { jumiaCountryByCode, type JumiaCountry } from "@/lib/marketing/countries";
import { sendTextIfConfigured } from "@/lib/whatsapp/client";
import { botPausedForCredits } from "@/lib/whatsapp/credit-gate";
import { formatAmount } from "@/lib/whatsapp/orders";
import { inQuietHours, lastInboundAt, WINDOW_MS } from "@/lib/whatsapp/order-alerts";
import { describeLiveChange, recordApplied } from "@/lib/whatsapp/shop";
import {
  fetchPayouts, markNoticed, noticed, orderStatusWord, ordersChangedSince, type LiveChange, type PayoutStatement,
} from "@/lib/jumia/shop";
import type { JumiaOrder } from "@/lib/jumia/orders";

export const ORDER_UPDATES_GAP_MS = 2 * 3_600_000;
export const PAYOUT_CHECK_MS = 6 * 3_600_000;
/** Order changes are looked for this far back. */
const ORDER_LOOKBACK_MS = 2 * 86_400_000;
/** A change Jumia hasn't answered in this long is given up on. */
const FEED_GIVE_UP_MS = 24 * 3_600_000;

export interface ShopNoticesRun { changes: number; updates: number; payouts: number; failed: number }

async function phoneOf(userId: string): Promise<string | null> {
  const { data } = await createServerClient().from("whatsapp_connections").select("phone_number").eq("user_id", userId).limit(1);
  return (data as { phone_number: string }[] | null)?.[0]?.phone_number ?? null;
}

/** The newest time a marker of `kind` was written for this seller, or null. */
async function lastMarker(userId: string, kind: string): Promise<number | null> {
  const { data } = await createServerClient()
    .from("shop_notices").select("created_at").eq("user_id", userId).eq("kind", kind)
    .order("created_at", { ascending: false }).limit(1);
  const times = ((data ?? []) as { created_at?: string }[]).map((r) => new Date(String(r.created_at)).getTime()).filter(Number.isFinite);
  return times.length > 0 ? Math.max(...times) : null;
}

const feedError = (errors: unknown[]): string => {
  const first = errors.map((e) => (typeof e === "string" ? e : e && typeof e === "object" ? String((e as Record<string, unknown>).message ?? JSON.stringify(e)) : "")).find(Boolean);
  return first ? first.slice(0, 200) : "Jumia didn't say why";
};

/** Changes sent to Jumia: applied (noted), refused (told), or no answer after a day (told). */
async function checkSentChanges(now: Date, deadline: number, run: ShopNoticesRun): Promise<void> {
  const db = createServerClient();
  const { data } = await db.from("jumia_product_changes").select("*").eq("status", "sent").limit(20);
  const rows = ((data ?? []) as Record<string, unknown>[]).filter((r) => now.getTime() - new Date(String(r.updated_at)).getTime() > 60_000);
  for (const r of rows) {
    if (Date.now() > deadline) break;
    const userId = String(r.user_id);
    try {
      const creds = await getValidJumiaCredentials(userId);
      const feed = await getFeedStatus(creds.accessToken, String(r.feed_id));
      const done = feed && (feed.status === "DONE" || feed.status === "FINISHED" || feed.status === "COMPLETED");
      const refused = feed && (feed.status === "ERROR" || feed.status === "FAILED" || feed.failed > 0);
      const age = now.getTime() - new Date(String(r.created_at)).getTime();
      if (refused || (!done && age > FEED_GIVE_UP_MS)) {
        const reason = refused ? feedError(feed!.errors) : "Jumia didn't confirm it within a day";
        await db.from("jumia_product_changes").update({ status: "failed", error: reason, updated_at: now.toISOString() }).eq("id", String(r.id));
        const phone = await phoneOf(userId);
        const what = describeLiveChange(r.change as LiveChange, null, { currency: creds.currency });
        if (phone) await sendTextIfConfigured(phone, `⚠️ Jumia didn't apply the change to *${String(r.name ?? r.seller_sku)}* (${what}): ${reason}`);
        run.changes++;
      } else if (done) {
        await db.from("jumia_product_changes").update({ status: "done", updated_at: now.toISOString() }).eq("id", String(r.id));
        if (r.product_sid) await recordApplied(userId, String(r.product_sid), r.change as LiveChange);
        run.changes++;
      }
    } catch (e) {
      run.failed++;
      console.warn(`[shop notices] change ${String(r.id)}: ${(e as Error).message}`);
    }
  }
}

const UPDATE_KINDS: { status: string; head: string }[] = [
  { status: "CANCELED",  head: "🚫 Cancelled (don't ship these)" },
  { status: "FAILED",    head: "❌ Delivery failed" },
  { status: "RETURNED",  head: "↩️ Returned" },
  { status: "DELIVERED", head: "✅ Delivered" },
];

/** The grouped order-updates message. */
export function orderUpdatesText(orders: JumiaOrder[], country?: JumiaCountry): string {
  const line = (o: JumiaOrder) => `#${o.number}` +
    (o.totalAmountLocal ? ` · ${formatAmount(Number(o.totalAmountLocal.value) || 0, o.totalAmountLocal.currency, country)}` : "");
  const parts: string[] = ["📦 Jumia order updates"];
  for (const k of UPDATE_KINDS) {
    const these = orders.filter((o) => orderStatusWord(o) === k.status);
    if (these.length === 0) continue;
    const shown = these.slice(0, 15).map(line);
    parts.push("", `*${k.head}*`, ...shown, ...(these.length > 15 ? [`+${these.length - 15} more`] : []));
  }
  return parts.join("\n");
}

/** Delivered / returned / failed / cancelled orders not yet told. */
async function orderUpdates(userId: string, phone: string, token: string, country: JumiaCountry | undefined, now: Date, run: ShopNoticesRun): Promise<void> {
  const r = await ordersChangedSince(token, now.getTime() - ORDER_LOOKBACK_MS);
  if (!r.ok) throw new Error(r.message);
  const changed = r.data.filter((o) => UPDATE_KINDS.some((k) => k.status === orderStatusWord(o)));
  const ref = (o: JumiaOrder) => `${o.id}:${orderStatusWord(o)}`;
  const seen = await noticed(userId, "order", changed.map(ref));
  const fresh = changed.filter((o) => !seen.has(ref(o)));

  // First run: what's there is known, nothing old is announced.
  if ((await lastMarker(userId, "order_baseline")) == null) {
    for (const o of fresh) await markNoticed(userId, "order", ref(o));
    await markNoticed(userId, "order_baseline", now.toISOString(), now);
    return;
  }
  if (fresh.length === 0) return;
  const urgent = fresh.some((o) => orderStatusWord(o) === "CANCELED");
  const last = await lastMarker(userId, "order_updates_sent");
  if (!urgent && last != null && now.getTime() - last < ORDER_UPDATES_GAP_MS) return;

  await sendTextIfConfigured(phone, orderUpdatesText(fresh, country));
  for (const o of fresh) await markNoticed(userId, "order", ref(o));
  await markNoticed(userId, "order_updates_sent", now.toISOString(), now);
  run.updates += fresh.length;
}

/** The paid-payout message. */
export function payoutText(s: PayoutStatement, country?: JumiaCountry): string {
  return `💰 Jumia paid you *${formatAmount(s.amount, s.currency || country?.currency || "", country)}*` +
    (s.reference ? ` (ref ${s.reference})` : "") + `.\nStatement ${s.number}. Ask me "my payouts" for the details.`;
}

/** A payout paid since the last check. */
async function payoutUpdates(userId: string, phone: string, token: string, country: JumiaCountry | undefined, now: Date, run: ShopNoticesRun): Promise<void> {
  const last = await lastMarker(userId, "payout_check");
  if (last != null && now.getTime() - last < PAYOUT_CHECK_MS) return;
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
  const r = await fetchPayouts(token, { createdAfter: since, paid: true });
  await markNoticed(userId, "payout_check", now.toISOString(), now);
  if (!r.ok) throw new Error(r.message);
  const paid = r.data.filter((s) => s.paid);
  const seen = await noticed(userId, "payout", paid.map((s) => s.number));
  const fresh = paid.filter((s) => !seen.has(s.number));
  if (last == null) {
    for (const s of fresh) await markNoticed(userId, "payout", s.number);
    return;
  }
  for (const s of fresh) {
    await sendTextIfConfigured(phone, payoutText(s, country));
    await markNoticed(userId, "payout", s.number);
    run.payouts++;
  }
}

export async function runShopNotices(now = new Date(), budgetMs = 20_000): Promise<ShopNoticesRun> {
  const started = Date.now();
  const deadline = started + budgetMs;
  const run: ShopNoticesRun = { changes: 0, updates: 0, payouts: 0, failed: 0 };
  const db = createServerClient();

  await checkSentChanges(now, deadline, run);

  const { data: links } = await db.from("whatsapp_connections").select("user_id, phone_number");
  const byUser = new Map<string, string>();
  for (const l of (links ?? []) as { user_id: string; phone_number: string }[]) if (!byUser.has(l.user_id)) byUser.set(l.user_id, l.phone_number);
  if (byUser.size === 0) return run;
  const { data: conns } = await db.from("jumia_connections").select("user_id, status").in("user_id", Array.from(byUser.keys()));
  const connected = ((conns ?? []) as { user_id: string; status: string }[]).filter((c) => c.status !== "revoked").map((c) => c.user_id);

  for (const userId of connected) {
    if (Date.now() > deadline) break;
    const phone = byUser.get(userId)!;
    try {
      const wantsOrders = await hasFeature(userId, "order_alerts");
      const wantsPayouts = await hasFeature(userId, "shop_whatsapp");
      if (!wantsOrders && !wantsPayouts) continue;
      if (await botPausedForCredits(userId)) continue;
      const inbound = await lastInboundAt(phone);
      if (inbound == null || now.getTime() - inbound >= WINDOW_MS) continue;
      const creds = await getValidJumiaCredentials(userId);
      const country = jumiaCountryByCode(creds.country);
      if (inQuietHours(now, country?.timeZone ?? "UTC")) continue;
      if (wantsOrders) await orderUpdates(userId, phone, creds.accessToken, country, now, run);
      if (wantsPayouts) await payoutUpdates(userId, phone, creds.accessToken, country, now, run);
    } catch (e) {
      run.failed++;
      console.warn(`[shop notices] ${userId}: ${(e as Error).message}`);
    }
  }
  return run;
}
