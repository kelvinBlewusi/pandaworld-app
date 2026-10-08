/**
 * The shop health report (owner, 2026-10-07: "let the AI be able to do a
 * full report on the shop ... tell the user what might be working and what
 * might not, the overall health of the shop ... so it has to pull evidence
 * and get real time data"). The /report command, "report" on WhatsApp, or
 * asked for in the Listing Assistant.
 *
 * Evidence first, read live from Jumia: the catalog (on, off, rejected by
 * quality check, out of stock, low, on sale), the last 90 days of orders
 * and their items (sold, cancelled, returned, failed delivery, best sellers,
 * products with no sale, what runs out soon, the last 30 days against the
 * 60 before), payouts (paid, waiting, fees against sales), and what they
 * listed with PandaWorld. healthEvidence() turns it into numbers, pure; a
 * score from them (healthScore); then the AI writes what's working, what
 * isn't and what to do, from those numbers only. If the AI can't be
 * reached, the numbers and a plain reading of them go out instead.
 *
 * REPORT_CREDIT_COST, on every plan: checked before Jumia is read, charged
 * once the report is ready (`report:<userId>:<minute>`, so a retry within
 * the minute isn't charged twice). Nothing is charged when it fails.
 */

import { createServerClient } from "@/lib/supabase/server";
import { REPORT_CREDIT_COST } from "@/lib/billing/credit-packs";
import { isWebAddress } from "@/lib/whatsapp/channel";
import { availableCredits, chargeService, isUnmetered } from "@/lib/billing/extension-credits";
import { getItemsOfOrders, type JumiaOrder, type JumiaOrderItem } from "@/lib/jumia/orders";
import { fetchPayouts, ordersCreatedSince, type PayoutStatement, type ShopProduct } from "@/lib/jumia/shop";
import { callGeminiBackend } from "@/lib/ai/gemini-client";
import { withAiUsageContext } from "@/lib/ai/usage";
import { sendCtaUrlIfConfigured, sendTextIfConfigured } from "@/lib/whatsapp/client";
import { buyCreditsUrl } from "@/lib/whatsapp/batch";
import { catalog, LOW_STOCK, sendLong, shopContext, shorten } from "@/lib/whatsapp/shop";
import { salesByProduct, daysLeft } from "@/lib/whatsapp/shop-insights";
import { formatAmount } from "@/lib/whatsapp/orders";
import type { JumiaCountry } from "@/lib/marketing/countries";

const DAY = 86_400_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MODEL = "gemini-2.5-flash";
/** The newest orders whose items are read: enough to see the shop, within the time a reply has. */
const ITEMS_ORDERS_MAX = 300;

export interface HealthEvidence {
  currency: string;
  catalog: {
    total: number; active: number; inactive: number; qcRejected: number; qcPending: number;
    outOfStock: number; lowStock: number; onSale: number;
    rejectedNames: string[]; outOfStockNames: string[];
  };
  orders: {
    days: 90; orders: number; last30: number; previous60: number; itemsRead: number; partial: boolean;
    sold: number; revenue: number; cancelled: number; returned: number; failed: number;
    cancelRate: number; returnRate: number; failedRate: number;
  };
  best: { name: string; sold: number; revenue: number }[];
  noSale: { count: number; names: string[] };
  runningOut: { name: string; stock: number; days: number }[];
  payouts: { paid: number; paidTotal: number; waiting: number; waitingTotal: number; fees: number; sales: number; feeShare: number | null };
  pandaworld: { listed90: number; live90: number; rejected90: number };
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);
const isActive = (p: ShopProduct) => (p.status ?? "").toUpperCase() === "ACTIVE";
const isRejected = (p: ShopProduct) => /reject/i.test(p.qcStatus ?? "");
const isPendingQc = (p: ShopProduct) => /pending|review/i.test(p.qcStatus ?? "");
const onSaleNow = (p: ShopProduct, now: number) =>
  p.salePrice != null && p.salePrice > 0 && (!p.saleEnd || Date.parse(p.saleEnd) >= now) && (!p.saleStart || Date.parse(p.saleStart) <= now);

/** The report's numbers from what was read. Pure. */
export function healthEvidence(
  products: ShopProduct[],
  orders: Pick<JumiaOrder, "createdAt">[],
  items: JumiaOrderItem[],
  partial: boolean,
  payouts: PayoutStatement[],
  listings: { status: string }[],
  now = Date.now(),
): HealthEvidence {
  // Deleted products aren't in the shop: counting them made "436 on Jumia,
  // 349 off, 70 rejected" against the overview's 297 (owner, 2026-10-08).
  products = products.filter((p) => (p.status ?? "").toUpperCase() !== "DELETED");
  const active = products.filter(isActive);
  const sales = salesByProduct(items);
  const rows = Array.from(sales.values());
  const sold = rows.reduce((n, r) => n + r.sold, 0);
  const cancelled = rows.reduce((n, r) => n + r.cancelled, 0);
  const returned = rows.reduce((n, r) => n + r.returned, 0);
  const failed = rows.reduce((n, r) => n + r.failed, 0);
  const lines = sold + cancelled + returned + failed;
  const currency = rows.find((r) => r.currency)?.currency || products.find((p) => p.currency)?.currency || payouts[0]?.currency || "";

  const last30 = orders.filter((o) => now - Date.parse(o.createdAt) <= 30 * DAY).length;
  const best = rows.filter((r) => r.sold > 0).sort((a, b) => b.revenue - a.revenue || b.sold - a.sold).slice(0, 5)
    .map((r) => ({ name: r.name, sold: r.sold, revenue: Math.round(r.revenue * 100) / 100 }));
  const noSale = active.filter((p) => !(sales.get(p.sellerSku)?.sold));
  const runningOut = active
    .map((p) => ({ p, d: daysLeft(p.stock, sales.get(p.sellerSku)?.sold ?? 0, 90) }))
    .filter((x): x is { p: ShopProduct; d: number } => x.d != null && x.d <= 14 && (x.p.stock ?? 0) > 0)
    .sort((a, b) => a.d - b.d).slice(0, 5)
    .map(({ p, d }) => ({ name: p.name, stock: p.stock ?? 0, days: d }));

  const paid = payouts.filter((s) => s.paid);
  const waiting = payouts.filter((s) => !s.paid);
  const fees = payouts.reduce((n, s) => n + Math.abs(s.feesTotal ?? 0), 0);
  const salesMoney = payouts.reduce((n, s) => n + (s.itemRevenue ?? 0), 0);

  const since90 = now - 90 * DAY;
  const recent = listings.filter(Boolean);
  return {
    currency,
    catalog: {
      total: products.length, active: active.length, inactive: products.length - active.length,
      qcRejected: products.filter(isRejected).length, qcPending: products.filter(isPendingQc).length,
      outOfStock: active.filter((p) => p.stock === 0).length,
      lowStock: active.filter((p) => p.stock != null && p.stock > 0 && p.stock <= LOW_STOCK).length,
      onSale: active.filter((p) => onSaleNow(p, now)).length,
      rejectedNames: products.filter(isRejected).slice(0, 3).map((p) => p.name),
      outOfStockNames: active.filter((p) => p.stock === 0).slice(0, 3).map((p) => p.name),
    },
    orders: {
      days: 90, orders: orders.length, last30, previous60: orders.length - last30, itemsRead: items.length, partial,
      sold, revenue: Math.round(rows.reduce((n, r) => n + r.revenue, 0) * 100) / 100, cancelled, returned, failed,
      cancelRate: pct(cancelled, lines), returnRate: pct(returned, lines), failedRate: pct(failed, lines),
    },
    best,
    noSale: { count: noSale.length, names: noSale.slice(0, 3).map((p) => p.name) },
    runningOut,
    payouts: {
      paid: paid.length, paidTotal: Math.round(paid.reduce((n, s) => n + s.amount, 0) * 100) / 100,
      waiting: waiting.length, waitingTotal: Math.round(waiting.reduce((n, s) => n + s.amount, 0) * 100) / 100,
      fees: Math.round(fees * 100) / 100, sales: Math.round(salesMoney * 100) / 100,
      feeShare: salesMoney > 0 ? pct(fees, salesMoney) : null,
    },
    pandaworld: {
      listed90: recent.length,
      live90: recent.filter((l) => /^(live|qc_approved|auto_resubmitted)$/.test(l.status)).length,
      rejected90: recent.filter((l) => /reject|failed/.test(l.status)).length,
    },
  };
  void since90;
}

/**
 * 0 to 100, from what most decides how a Jumia shop does: products on and
 * in stock, quality check, orders coming in and holding up, and cancelled,
 * returned and failed deliveries kept low. Each part's points are in
 * `parts` so the score can be explained.
 */
export function healthScore(e: HealthEvidence): { score: number; parts: Record<string, number> } {
  const c = e.catalog;
  const o = e.orders;
  const share = (n: number, of: number) => (of > 0 ? n / of : 0);
  const parts = {
    // Products on Jumia and in stock (25).
    catalog: c.total === 0 ? 0 : Math.round(25 * share(c.active, c.total) * (1 - share(c.outOfStock, Math.max(c.active, 1)))),
    // Quality check (15): rejected products cost the most.
    quality: c.total === 0 ? 0 : Math.round(15 * (1 - share(c.qcRejected, c.total))),
    // Orders in 90 days (25): 30+ is full marks.
    orders: Math.round(25 * Math.min(1, o.orders / 30)),
    // The last 30 days against the 60 before (10): steady or growing is full marks.
    trend: o.orders === 0 ? 0 : o.previous60 === 0 ? 10 : Math.round(10 * Math.min(1, (o.last30 / 30) / (o.previous60 / 60))),
    // Cancelled, returned, failed (25): each point of rate costs a point.
    fulfilment: o.itemsRead === 0 ? 0 : Math.max(0, Math.round(25 - (o.cancelRate + o.returnRate + o.failedRate))),
  };
  return { score: Math.max(0, Math.min(100, Object.values(parts).reduce((a, b) => a + b, 0))), parts };
}

const band = (score: number) => (score >= 75 ? "🟢 Healthy" : score >= 50 ? "🟡 Fair" : "🔴 Needs work");

/** The numbers, as the seller reads them. */
export function evidenceText(e: HealthEvidence, score: number, country?: JumiaCountry): string {
  const money = (n: number) => formatAmount(n, e.currency || country?.currency || "", country);
  const c = e.catalog;
  const o = e.orders;
  const p = e.payouts;
  return [
    `🩺 *Shop health: ${score}/100* ${band(score)}`,
    "",
    "*Products*",
    `${c.total} on Jumia: ${c.active} on, ${c.inactive} off · ${c.outOfStock} out of stock, ${c.lowStock} low · ${c.qcRejected} rejected by quality check, ${c.qcPending} waiting · ${c.onSale} on sale`,
    "",
    "*Orders, last 90 days*" + (o.partial ? " (newest read)" : ""),
    `${o.orders} orders (${o.last30} in the last 30 days, ${o.previous60} in the 60 before) · ${o.sold} items sold, ${money(o.revenue)}`,
    `Cancelled ${o.cancelRate}% · returned ${o.returnRate}% · failed delivery ${o.failedRate}%`,
    ...(e.best.length ? ["", "*Best sellers*", ...e.best.slice(0, 3).map((b, i) => `${i + 1}. ${shorten(b.name, 40)}: ${b.sold} sold, ${money(b.revenue)}`)] : []),
    ...(e.noSale.count ? ["", `*No sale in 90 days:* ${e.noSale.count} product${e.noSale.count === 1 ? "" : "s"}${e.noSale.names.length ? ` (e.g. ${e.noSale.names.map((n) => shorten(n, 30)).join(", ")})` : ""}`] : []),
    ...(e.runningOut.length ? ["", "*Running out*", ...e.runningOut.slice(0, 3).map((r) => `${shorten(r.name, 40)}: ${r.stock} left, about ${r.days} days`)] : []),
    ...(p.paid + p.waiting > 0 ? ["", "*Payouts*", `${p.paid} paid (${money(p.paidTotal)}) · ${p.waiting} waiting (${money(p.waitingTotal)})` + (p.feeShare != null ? ` · Jumia's fees ${p.feeShare}% of sales` : "")] : []),
  ].join("\n");
}

function analysisPrompt(e: HealthEvidence, score: number, parts: Record<string, number>): string {
  return [
    "You are a Jumia marketplace expert reviewing ONE seller's shop for them. Below is real data read from Jumia just now.",
    "Write a short analysis for WhatsApp, in plain words a busy seller understands:",
    "*What's working* (2 or 3 points), *What isn't* (2 or 3 points), *Do this next* (3 numbered actions, the most valuable first).",
    "Every point must rest on a number below and say it. Never invent a figure, a product or a Jumia rule. If the data is thin (few orders), say so and focus on getting the first sales: products on, in stock, good photos, fair prices, sales.",
    "Use *bold* with single asterisks for the three headings, \"•\" for points, \"1.\" for actions. At most 1,200 characters. No greeting, no sign-off.",
    "",
    `Health score: ${score}/100 (parts: ${JSON.stringify(parts)}; catalog of 25, quality of 15, orders of 25, trend of 10, fulfilment of 25).`,
    `Data: ${JSON.stringify(e)}`,
  ].join("\n");
}

/** The AI's reading, or a plain one from the numbers. */
async function analyse(userId: string, e: HealthEvidence, score: number, parts: Record<string, number>): Promise<string> {
  try {
    const { text } = await withAiUsageContext({ feature: "assistant", userId }, () => callGeminiBackend(MODEL, [{ text: analysisPrompt(e, score, parts) }]));
    const clean = (text ?? "").replace(/```[a-z]*\n?|```/g, "").trim();
    if (clean.length > 40) return clean.slice(0, 1600);
  } catch (err) {
    console.warn(`[shop health] AI reading failed for ${userId}: ${(err as Error).message}`);
  }
  return plainReading(e);
}

/** What to do, from the numbers alone. Pure. */
export function plainReading(e: HealthEvidence): string {
  const todo: string[] = [];
  if (e.catalog.qcRejected) todo.push(`Fix the ${e.catalog.qcRejected} product${e.catalog.qcRejected === 1 ? "" : "s"} Jumia's quality check rejected: they can't sell until they pass.`);
  if (e.catalog.outOfStock) todo.push(`Restock or turn off the ${e.catalog.outOfStock} out-of-stock product${e.catalog.outOfStock === 1 ? "" : "s"}.`);
  if (e.runningOut.length) todo.push(`Order more of ${shorten(e.runningOut[0].name, 30)}: about ${e.runningOut[0].days} days of stock left.`);
  if (e.orders.cancelRate + e.orders.failedRate >= 10) todo.push("Cut cancellations and failed deliveries: keep stock counts true and answer buyers fast.");
  if (e.noSale.count) todo.push(`Put the ${e.noSale.count} product${e.noSale.count === 1 ? "" : "s"} with no sale on a sale, or improve their photos and names.`);
  if (e.catalog.inactive) todo.push(`Check the ${e.catalog.inactive} product${e.catalog.inactive === 1 ? "" : "s"} turned off: turn on what you can sell.`);
  if (todo.length === 0) todo.push("Keep stock up on your best sellers and add more products like them.");
  return ["*Do this next*", ...todo.slice(0, 3).map((t, i) => `${i + 1}. ${t}`)].join("\n");
}

/** The report: checked, read, charged, sent. Returns what happened, for the assistant's log. */
export async function answerHealthReport(userId: string, phone: string): Promise<string> {
  const unmetered = await isUnmetered(userId);
  if (!unmetered) {
    const available = await availableCredits(userId);
    if (available < REPORT_CREDIT_COST) {
      const shown = Math.max(0, Math.round(available * 100) / 100);
      await sendCtaUrlIfConfigured(phone, `🩺 The shop health report costs ${REPORT_CREDIT_COST} credits, and you have ${shown}. Buy credits, then send *report* again.`, "Buy credits", buyCreditsUrl());
      return "report: not enough credits";
    }
  }
  const ctx = await shopContext(userId, phone, "shop_whatsapp", "the shop health report");
  if (!ctx) return "report: no shop";
  await sendTextIfConfigured(phone, "🩺 Reading your shop from Jumia: products, 90 days of orders, payouts. About a minute…");

  const deadline = Date.now() + 35_000;
  const now = Date.now();
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  const [products, ordersR, payoutsR, listingsR] = await Promise.all([
    catalog(ctx),
    ordersCreatedSince(ctx.token, iso(now - 90 * DAY), 5),
    fetchPayouts(ctx.token, { createdAfter: iso(now - 90 * DAY) }),
    createServerClient().from("listings").select("status").eq("user_id", userId).gt("created_at", new Date(now - 90 * DAY).toISOString()),
  ]);
  if (!products || !ordersR.ok) {
    await sendTextIfConfigured(phone, `I couldn't read your shop from Jumia just now${ordersR.ok ? "" : ` (${ordersR.message})`}. Nothing was charged: try *report* again in a few minutes.`);
    return "report: Jumia unreachable";
  }
  const orders = ordersR.data;
  const items: JumiaOrderItem[] = [];
  const toRead = orders.slice(0, ITEMS_ORDERS_MAX);
  let read = 0;
  for (; read < toRead.length && Date.now() < deadline; read += 25) {
    const got = await getItemsOfOrders(ctx.token, toRead.slice(read, read + 25).map((o) => o.id));
    if (!got.ok) break;
    for (const v of Array.from(got.data.values())) items.push(...v.items);
    await sleep(260);
  }
  const evidence = healthEvidence(
    products, orders, items, read < orders.length, payoutsR.ok ? payoutsR.data : [],
    ((listingsR.data ?? []) as { status: string }[]), now,
  );
  const { score, parts } = healthScore(evidence);
  const reading = await analyse(userId, evidence, score, parts);

  if (!unmetered) {
    const minute = new Date(now).toISOString().slice(0, 16);
    const charged = await chargeService(userId, REPORT_CREDIT_COST, `report:${userId}:${minute}`, "Shop health report");
    if (!charged.ok) {
      await sendCtaUrlIfConfigured(phone, `🩺 Your report is ready, but I couldn't take its ${REPORT_CREDIT_COST} credits. Buy credits, then send *report* again.`, "Buy credits", buyCreditsUrl());
      return "report: charge failed";
    }
  }
  // No credits named after it on the web (owner, 2026-10-07: "don't mention credit spent after an action").
  const spent = isWebAddress(phone) ? "" : `${REPORT_CREDIT_COST} credits · `;
  await sendLong(phone, `${evidenceText(evidence, score, ctx.jc)}\n\n${reading}\n\n_${spent}from Jumia, just now_`);
  return `report: ${score}/100`;
}
