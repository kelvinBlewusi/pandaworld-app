/**
 * Jumia orders on WhatsApp (agreed with the owner 2026-10-06, AGENTS.md
 * "Agreed design for the WhatsApp order flow"): the alert, Pack all & get
 * labels as ONE PDF, Ready to ship all, Pick orders (one order's Pack / Get
 * label / Ready to ship / Cancel), and "orders" typed any time.
 *
 * Gated by pack (lib/billing/features.ts): seeing orders needs
 * `order_alerts`, changing one needs `shipping_labels` (both Pro and up;
 * admins and grants too), and neither works at 0 credits. Works for every Jumia country: amounts in the
 * shop's own currency and the country's formatting, Jumia's own wording
 * passed through.
 *
 * Every id is the command itself (lib/whatsapp/message-content.ts), so the
 * flow keeps no conversation state: a tap names the order it acts on, and
 * the order is read from Jumia again before anything changes.
 */

import {
  sendButtonsIfConfigured, sendCtaUrlIfConfigured, sendDocumentIfConfigured, sendListIfConfigured,
  sendTemplateIfConfigured, sendTextIfConfigured, LIST_MAX_ROWS,
} from "@/lib/whatsapp/client";
import { appUrl } from "@/lib/whatsapp/app-url";
import { featureAccess, featureMinPackName, type FeatureBlock, type FeatureId } from "@/lib/billing/features";
import { getValidJumiaCredentials } from "@/lib/jumia/api";
import { getJumiaConnectionKind } from "@/lib/jumia/credentials";
import { promptJumiaConnection } from "@/lib/whatsapp/jumia-connect";
import { jumiaCountryByCode, type JumiaCountry } from "@/lib/marketing/countries";
import {
  cancelOrder, labelsPdf, packOrders, packedItems, readyToShip, toPackItems, waitingOrders, type WaitingOrder,
} from "@/lib/jumia/order-flow";
import type { ShipmentProvider } from "@/lib/jumia/orders";

const ID = "[0-9a-f-]{36}";
const BODY_MAX = 1024;

type OrderCommand =
  | { kind: "list" }
  | { kind: "pack_all"; stationId?: string }
  | { kind: "labels_all" }
  | { kind: "ready_all" }
  | { kind: "pick" }
  | { kind: "view"; orderId: string }
  | { kind: "pack"; orderId: string; stationId?: string }
  | { kind: "label"; orderId: string }
  | { kind: "ready"; orderId: string }
  | { kind: "cancel_ask"; orderId: string }
  | { kind: "cancel"; orderId: string };

/** The order command in a message (typed or a tapped id), or null. Cheap: no I/O. */
export function parseOrderCommand(text: string | undefined): OrderCommand | null {
  const t = text?.trim() ?? "";
  if (/^(?:my\s+)?(?:jumia\s+)?orders?[.!?]?$/i.test(t)) return { kind: "list" };
  let m: RegExpMatchArray | null;
  if (t === "orders:packall") return { kind: "pack_all" };
  if ((m = t.match(new RegExp(`^orders:packat:(${ID})$`, "i")))) return { kind: "pack_all", stationId: m[1] };
  if (t === "orders:labels") return { kind: "labels_all" };
  if (t === "orders:rtsall") return { kind: "ready_all" };
  if (t === "orders:pick") return { kind: "pick" };
  if ((m = t.match(new RegExp(`^order:(${ID})$`, "i")))) return { kind: "view", orderId: m[1] };
  if ((m = t.match(new RegExp(`^opack:(${ID})$`, "i")))) return { kind: "pack", orderId: m[1] };
  if ((m = t.match(new RegExp(`^opackat:(${ID}):(${ID})$`, "i")))) return { kind: "pack", orderId: m[1], stationId: m[2] };
  if ((m = t.match(new RegExp(`^olabel:(${ID})$`, "i")))) return { kind: "label", orderId: m[1] };
  if ((m = t.match(new RegExp(`^orts:(${ID})$`, "i")))) return { kind: "ready", orderId: m[1] };
  if ((m = t.match(new RegExp(`^ocancel:(${ID})$`, "i")))) return { kind: "cancel_ask", orderId: m[1] };
  if ((m = t.match(new RegExp(`^ocancelyes:(${ID})$`, "i")))) return { kind: "cancel", orderId: m[1] };
  return null;
}

// ─── Formatting (pure) ───────────────────────────────────────────────────────

/** "GHS 238", "NGN 12,500", "XOF 15,000": whole units where the country uses them. */
export function formatAmount(value: number, currency: string, country?: JumiaCountry): string {
  const whole = country?.wholeUnits ?? false;
  const n = whole ? Math.round(value) : Math.round(value * 100) / 100;
  return `${currency} ${n.toLocaleString("en-US", { maximumFractionDigits: whole ? 0 : 2 })}`.trim();
}

const shorten = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);
const itemCount = (n: number) => `${n} item${n === 1 ? "" : "s"}`;

function currencyOf(o: WaitingOrder, country?: JumiaCountry): string {
  return o.total?.currency ?? o.items[0]?.country?.currencyCode ?? country?.currency ?? "";
}

function totalOf(o: WaitingOrder): number {
  if (o.total) return Number(o.total.value) || 0;
  return o.items.reduce((sum, i) => sum + (Number(i.paidPriceLocal ?? i.itemPriceLocal) || 0), 0);
}

/** "#355926919 · 3 items · GHS 238" */
export function orderLine(o: WaitingOrder, country?: JumiaCountry): string {
  return `#${o.number} · ${itemCount(o.items.length)} · ${formatAmount(totalOf(o), currencyOf(o, country), country)}`;
}

/** One line per product; the same product ordered twice shows as "2 ×". */
export function itemLines(o: WaitingOrder, country?: JumiaCountry, nameMax = 48): string[] {
  const groups = new Map<string, { name: string; count: number; price: number }>();
  for (const i of o.items) {
    const name = i.product?.name ?? "Item";
    const key = i.product?.sellerSku || name;
    const g = groups.get(key) ?? { name, count: 0, price: Number(i.paidPriceLocal ?? i.itemPriceLocal) || 0 };
    g.count++;
    groups.set(key, g);
  }
  return Array.from(groups.values()).map((g) =>
    `• ${g.count > 1 ? `${g.count} × ` : ""}${shorten(g.name, nameMax)}` +
    (g.price ? ` · ${formatAmount(g.price, currencyOf(o, country), country)}${g.count > 1 ? " each" : ""}` : ""),
  );
}

/** Lines joined under a header, cut to fit WhatsApp's 1,024 characters with "+N more". */
function fitLines(header: string, lines: string[], footer = ""): string {
  for (let shown = lines.length; shown >= 0; shown--) {
    const more = lines.length - shown;
    const body = [header, ...lines.slice(0, shown), ...(more ? [`+${more} more`] : [])].join("\n") + footer;
    if (body.length <= BODY_MAX) return body;
  }
  return shorten(header, BODY_MAX);
}

/** The alert for new orders: one order in full, several as one line each. */
export function alertText(orders: WaitingOrder[], country?: JumiaCountry): string {
  if (orders.length === 1) {
    const o = orders[0];
    const head = `🛒 New Jumia order #${o.number}\n${itemCount(o.items.length)} · ` +
      `${formatAmount(totalOf(o), currencyOf(o, country), country)}${o.delivery ? ` · ${o.delivery}` : ""}\n`;
    return fitLines(head, itemLines(o, country));
  }
  const sum = orders.reduce((s, o) => s + totalOf(o), 0);
  const head = `🛒 ${orders.length} new Jumia orders · ${formatAmount(sum, currencyOf(orders[0], country), country)}\n`;
  return fitLines(head, orders.map((o) => orderLine(o, country)));
}

/**
 * The template's four values (`jumia_new_order`: order number, items, total,
 * delivery). A value can't hold a new line, so the items are one line, at
 * most 3 named.
 */
export function templateValues(orders: WaitingOrder[], country?: JumiaCountry): string[] {
  const first = orders[0];
  const number = orders.length === 1 ? first.number : `${first.number} and ${orders.length - 1} more`;
  const names = orders.flatMap((o) => o.items.map((i) => shorten(i.product?.name ?? "Item", 30)));
  const items = names.slice(0, 3).join(", ") + (names.length > 3 ? ` (+${names.length - 3} more)` : "");
  const sum = orders.reduce((s, o) => s + totalOf(o), 0);
  return [number, items, formatAmount(sum, currencyOf(first, country), country), first.delivery || "Jumia delivery"];
}

/** "GH-VDO-OWN-East Legon-Station" → "East Legon VDO"; any country's code. */
export function stationShortName(code: string): string {
  const words = code.replace(/^[A-Z]{2}-/, "").replace(/-Station$/i, "").split("-").map((w) => w.trim()).filter(Boolean);
  const kept = words.filter((w) => !/^(OWN|3PL)$/i.test(w));
  const vdo = kept[0]?.toUpperCase() === "VDO";
  const name = (vdo ? [...kept.slice(1), "VDO"] : kept).join(" ");
  return name || code;
}

// ─── The flow ────────────────────────────────────────────────────────────────

const VIEW_FEATURE: FeatureId = "order_alerts";
const ACT_FEATURE: FeatureId = "shipping_labels";

async function upgrade(phone: string, feature: FeatureId, blockedBy: FeatureBlock): Promise<void> {
  if (blockedBy === "credits") {
    await sendCtaUrlIfConfigured(phone, "📦 You're out of credits: buy credits to use orders on WhatsApp again.", "Buy credits", `${appUrl()}/extension/dashboard`);
    return;
  }
  await sendCtaUrlIfConfigured(
    phone,
    `📦 Order alerts and shipping labels on WhatsApp come with the ${featureMinPackName(feature)} pack.`,
    "See packs",
    `${appUrl()}/pricing`,
  );
}

/**
 * Handle an order command. False when the message isn't one, so the rest of
 * intake handles it as before.
 */
export async function handleOrderMessage(userId: string, phone: string, text: string | undefined): Promise<boolean> {
  const cmd = parseOrderCommand(text);
  if (!cmd) return false;

  const feature = cmd.kind === "list" || cmd.kind === "pick" || cmd.kind === "view" ? VIEW_FEATURE : ACT_FEATURE;
  const access = await featureAccess(userId, feature);
  if (!access.ok) {
    await upgrade(phone, feature, access.blockedBy);
    return true;
  }

  let creds: Awaited<ReturnType<typeof getValidJumiaCredentials>>;
  try {
    creds = await getValidJumiaCredentials(userId);
  } catch {
    const kind = await getJumiaConnectionKind(userId);
    if (kind !== "connected") {
      await promptJumiaConnection(userId, phone, kind, "To see your Jumia orders, connect your Jumia account first.\n\n");
    } else {
      await sendTextIfConfigured(phone, "I couldn't reach Jumia just now. Try again in a minute.");
    }
    return true;
  }
  const ctx: Ctx = { phone, token: creds.accessToken, country: jumiaCountryByCode(creds.country) };

  switch (cmd.kind) {
    case "list":       await showWaiting(ctx); break;
    case "pick":       await pickOrders(ctx); break;
    case "view":       await viewOrder(ctx, cmd.orderId); break;
    case "pack_all":   await packAll(ctx, cmd.stationId); break;
    case "labels_all": await labelsAll(ctx); break;
    case "ready_all":  await readyAll(ctx); break;
    case "pack":       await packOne(ctx, cmd.orderId, cmd.stationId); break;
    case "label":      await labelOne(ctx, cmd.orderId); break;
    case "ready":      await readyOne(ctx, cmd.orderId); break;
    case "cancel_ask": await cancelAsk(ctx, cmd.orderId); break;
    case "cancel":     await cancelYes(ctx, cmd.orderId); break;
  }
  return true;
}

interface Ctx { phone: string; token: string; country?: JumiaCountry }

async function loadWaiting(ctx: Ctx): Promise<WaitingOrder[] | null> {
  const w = await waitingOrders(ctx.token);
  if (!w.ok) {
    await sendTextIfConfigured(ctx.phone, `I couldn't read your Jumia orders: ${w.message}`);
    return null;
  }
  return w.data;
}

async function loadOne(ctx: Ctx, orderId: string): Promise<WaitingOrder | null> {
  const all = await loadWaiting(ctx);
  if (!all) return null;
  const o = all.find((x) => x.id === orderId);
  if (!o) {
    await sendTextIfConfigured(ctx.phone, "That order isn't waiting any more: it was packed and shipped, or cancelled. Type *orders* to see what's left.");
    return null;
  }
  return o;
}

const PICK = { id: "orders:pick", title: "Pick orders" };

/** The buttons for a set of waiting orders. */
function waitingButtons(orders: WaitingOrder[]): { id: string; title: string }[] {
  const toPack = orders.some((o) => toPackItems(o).length > 0);
  const packed = orders.some((o) => packedItems(o).length > 0);
  if (toPack && packed) return [{ id: "orders:packall", title: "Pack all & labels" }, { id: "orders:rtsall", title: "Ready to ship all" }, PICK];
  if (toPack) return [{ id: "orders:packall", title: "Pack all & labels" }, PICK];
  return [{ id: "orders:labels", title: "Get labels" }, { id: "orders:rtsall", title: "Ready to ship all" }, PICK];
}

/** The new-order alert as our own message (inside WhatsApp's 24 hours). */
export async function sendOrderAlert(phone: string, orders: WaitingOrder[], country?: JumiaCountry): Promise<void> {
  if (orders.length === 1) {
    const id = orders[0].id;
    await sendButtonsIfConfigured(phone, alertText(orders, country), [
      { id: `opack:${id}`, title: "Pack & get label" },
      { id: `ocancel:${id}`, title: "Cancel order" },
    ]);
    return;
  }
  await sendButtonsIfConfigured(phone, alertText(orders, country), [{ id: "orders:packall", title: "Pack all & labels" }, PICK]);
}

/** The same alert as the approved template (outside WhatsApp's 24 hours). */
export async function sendOrderAlertTemplate(
  phone: string, orders: WaitingOrder[], country: JumiaCountry | undefined, template: { name: string; language: string },
): Promise<void> {
  const payload = orders.length === 1 ? `opack:${orders[0].id}` : "orders:packall";
  await sendTemplateIfConfigured(phone, template.name, template.language, templateValues(orders, country), [payload]);
}

async function showWaiting(ctx: Ctx): Promise<void> {
  const orders = await loadWaiting(ctx);
  if (!orders) return;
  if (orders.length === 0) {
    await sendTextIfConfigured(ctx.phone, "✅ No Jumia orders waiting for you. I'll message you when a new one comes in.");
    return;
  }
  const toPack = orders.filter((o) => toPackItems(o).length > 0);
  const packed = orders.filter((o) => toPackItems(o).length === 0 && packedItems(o).length > 0);
  const lines = [
    ...(toPack.length ? [`*To pack (${toPack.length})*`, ...toPack.map((o) => orderLine(o, ctx.country))] : []),
    ...(toPack.length && packed.length ? [""] : []),
    ...(packed.length ? [`*Packed, not yet ready to ship (${packed.length})*`, ...packed.map((o) => orderLine(o, ctx.country))] : []),
  ];
  await sendButtonsIfConfigured(ctx.phone, fitLines("📦 Your Jumia orders waiting\n", lines), waitingButtons(orders));
}

async function pickOrders(ctx: Ctx): Promise<void> {
  const orders = await loadWaiting(ctx);
  if (!orders) return;
  if (orders.length === 0) {
    await sendTextIfConfigured(ctx.phone, "✅ No Jumia orders waiting for you.");
    return;
  }
  const shown = orders.slice(0, LIST_MAX_ROWS);
  await sendListIfConfigured(
    ctx.phone,
    orders.length > shown.length ? `Pick an order (the ${shown.length} oldest of ${orders.length}):` : "Pick an order:",
    "Orders",
    shown.map((o) => ({
      id:          `order:${o.id}`,
      title:       `#${o.number}`,
      description: `${itemCount(o.items.length)} · ${formatAmount(totalOf(o), currencyOf(o, ctx.country), ctx.country)} · ${toPackItems(o).length ? "to pack" : "packed"}`,
    })),
  );
}

async function viewOrder(ctx: Ctx, orderId: string): Promise<void> {
  const o = await loadOne(ctx, orderId);
  if (!o) return;
  const toPack = toPackItems(o).length > 0;
  const tracking = packedItems(o)[0]?.trackingNumber;
  const head = `${orderLine(o, ctx.country)}${o.delivery ? ` · ${o.delivery}` : ""}\n` +
    (toPack ? "To pack\n" : `Packed (tracking ${tracking}), not yet ready to ship\n`);
  await sendButtonsIfConfigured(
    ctx.phone,
    fitLines(head, itemLines(o, ctx.country)),
    toPack
      ? [{ id: `opack:${o.id}`, title: "Pack & get label" }, { id: `ocancel:${o.id}`, title: "Cancel order" }]
      : [{ id: `olabel:${o.id}`, title: "Get label" }, { id: `orts:${o.id}`, title: "Ready to ship" }, { id: `ocancel:${o.id}`, title: "Cancel order" }],
  );
}

function labelFileName(orders: WaitingOrder[], country?: JumiaCountry): string {
  if (orders.length === 1) return `Jumia-label-${orders[0].number}.pdf`;
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: country?.timeZone ?? "UTC" }).format(new Date());
  return `Jumia-labels-${orders.length}-orders-${date}.pdf`;
}

/** Send one PDF of these packed orders' labels. The reason when there's none yet. */
async function sendLabels(ctx: Ctx, orders: WaitingOrder[]): Promise<string | null> {
  const r = await labelsPdf(ctx.token, orders.flatMap(packedItems));
  if (!r.ok) return r.reason;
  await sendDocumentIfConfigured(
    ctx.phone,
    r.pdf,
    labelFileName(orders, ctx.country),
    `Shipping label${orders.length === 1 ? "" : "s"} for ${orders.map((o) => `#${o.number}`).join(", ")}`.slice(0, 1000),
  );
  return null;
}

/** The station list for orders Jumia offers several stations for. */
async function askStation(ctx: Ctx, needs: { order: WaitingOrder; stations: ShipmentProvider[] }[], rowId: (s: ShipmentProvider) => string): Promise<void> {
  const stations = new Map<string, ShipmentProvider>();
  for (const n of needs) for (const s of n.stations) stations.set(s.id, s);
  await sendListIfConfigured(
    ctx.phone,
    `Where will you drop off ${needs.map((n) => `#${n.order.number}`).join(", ")}? Jumia offers more than one station.`.slice(0, BODY_MAX),
    "Choose station",
    Array.from(stations.values()).slice(0, LIST_MAX_ROWS).map((s) => ({ id: rowId(s), title: stationShortName(s.name), description: s.name })),
  );
}

function failedLines(failed: { order: WaitingOrder; reason: string }[]): string[] {
  return failed.map((f) => `⚠️ #${f.order.number}: ${f.reason}`);
}

async function packAll(ctx: Ctx, stationId?: string): Promise<void> {
  const orders = await loadWaiting(ctx);
  if (!orders) return;
  const targets = orders.filter((o) => toPackItems(o).length > 0);
  if (targets.length === 0) {
    await sendTextIfConfigured(ctx.phone, "Nothing to pack right now. Type *orders* to see what's waiting.");
    return;
  }
  const out = await packOrders(ctx.token, targets, stationId);
  const lines: string[] = [];
  let labelProblem: string | null = null;
  if (out.packed.length > 0) {
    labelProblem = await sendLabels(ctx, out.packed.map((p) => p.order));
    const stations = Array.from(new Set(out.packed.map((p) => stationShortName(p.station))));
    lines.push(`✅ Packed ${out.packed.length} order${out.packed.length === 1 ? "" : "s"} for ${stations.join(", ")}:`);
    lines.push(...out.packed.map((p) => `#${p.order.number} · ${p.tracking}`));
    if (labelProblem) lines.push("", `The labels aren't ready yet (${labelProblem}). Tap Get labels in a minute.`);
  }
  if (out.failed.length > 0) lines.push(...(lines.length ? [""] : []), "Not packed:", ...failedLines(out.failed));
  if (lines.length > 0) {
    const buttons = out.packed.length > 0
      ? [{ id: "orders:rtsall", title: "Ready to ship all" }, ...(labelProblem ? [{ id: "orders:labels", title: "Get labels" }] : []), PICK]
      : [PICK];
    await sendButtonsIfConfigured(ctx.phone, fitLines(lines[0], lines.slice(1)), buttons);
  }
  if (out.needStation.length > 0) await askStation(ctx, out.needStation, (s) => `orders:packat:${s.id}`);
}

async function labelsAll(ctx: Ctx): Promise<void> {
  const orders = await loadWaiting(ctx);
  if (!orders) return;
  const packed = orders.filter((o) => packedItems(o).length > 0);
  if (packed.length === 0) {
    await sendTextIfConfigured(ctx.phone, "No packed order is waiting for a label. Type *orders* to see what's waiting.");
    return;
  }
  const problem = await sendLabels(ctx, packed);
  if (problem) await sendButtonsIfConfigured(ctx.phone, `The labels aren't ready yet (${problem}). Try again in a minute.`, [{ id: "orders:labels", title: "Get labels" }]);
}

async function readyAll(ctx: Ctx): Promise<void> {
  const orders = await loadWaiting(ctx);
  if (!orders) return;
  const packed = orders.filter((o) => packedItems(o).length > 0);
  if (packed.length === 0) {
    await sendTextIfConfigured(ctx.phone, "No packed order to mark. Pack first: type *orders*.");
    return;
  }
  const r = await readyToShip(ctx.token, packed);
  const lines = [
    ...(r.done.length ? [`✅ ${r.done.length} order${r.done.length === 1 ? "" : "s"} ready to ship: ${r.done.map((o) => `#${o.number}`).join(", ")}`] : []),
    ...(r.failed.length ? [...(r.done.length ? [""] : []), "Not marked:", ...failedLines(r.failed)] : []),
  ];
  await sendTextIfConfigured(ctx.phone, fitLines(lines[0] ?? "Nothing changed.", lines.slice(1)));
}

async function packOne(ctx: Ctx, orderId: string, stationId?: string): Promise<void> {
  const o = await loadOne(ctx, orderId);
  if (!o) return;
  if (toPackItems(o).length === 0) {
    await viewOrder(ctx, orderId);
    return;
  }
  const out = await packOrders(ctx.token, [o], stationId);
  if (out.needStation.length > 0) {
    await askStation(ctx, out.needStation, (s) => `opackat:${o.id}:${s.id}`);
    return;
  }
  const p = out.packed[0];
  if (!p) {
    await sendTextIfConfigured(ctx.phone, `#${o.number} wasn't packed: ${out.failed[0]?.reason ?? "Jumia didn't pack it"}.`);
    return;
  }
  const problem = await sendLabels(ctx, [p.order]);
  await sendButtonsIfConfigured(
    ctx.phone,
    `✅ Packed #${o.number} for ${stationShortName(p.station)} · ${p.tracking}` +
      (problem ? `\n\nThe label isn't ready yet (${problem}). Tap Get label in a minute.` : ""),
    [{ id: `orts:${o.id}`, title: "Ready to ship" }, ...(problem ? [{ id: `olabel:${o.id}`, title: "Get label" }] : []), PICK],
  );
}

async function labelOne(ctx: Ctx, orderId: string): Promise<void> {
  const o = await loadOne(ctx, orderId);
  if (!o) return;
  if (packedItems(o).length === 0) {
    await viewOrder(ctx, orderId);
    return;
  }
  const problem = await sendLabels(ctx, [o]);
  if (problem) await sendButtonsIfConfigured(ctx.phone, `The label isn't ready yet (${problem}). Try again in a minute.`, [{ id: `olabel:${o.id}`, title: "Get label" }]);
}

async function readyOne(ctx: Ctx, orderId: string): Promise<void> {
  const o = await loadOne(ctx, orderId);
  if (!o) return;
  if (packedItems(o).length === 0) {
    await viewOrder(ctx, orderId);
    return;
  }
  const r = await readyToShip(ctx.token, [o]);
  await sendTextIfConfigured(
    ctx.phone,
    r.done.length ? `✅ #${o.number} is ready to ship.` : `#${o.number} wasn't marked: ${r.failed[0]?.reason ?? "Jumia didn't mark it"}.`,
  );
}

async function cancelAsk(ctx: Ctx, orderId: string): Promise<void> {
  const o = await loadOne(ctx, orderId);
  if (!o) return;
  await sendButtonsIfConfigured(
    ctx.phone,
    `Cancel order #${o.number}?\n\nThis cancels the customer's order and can't be undone. Jumia records its default ` +
      `cancellation reason (to give a reason, like out of stock, cancel in Vendor Center), and cancellations can count ` +
      `against your shop.`,
    [{ id: `ocancelyes:${o.id}`, title: "Yes, cancel order" }, { id: `order:${o.id}`, title: "Keep it" }],
  );
}

async function cancelYes(ctx: Ctx, orderId: string): Promise<void> {
  const o = await loadOne(ctx, orderId);
  if (!o) return;
  const r = await cancelOrder(ctx.token, o);
  await sendTextIfConfigured(ctx.phone, r.ok ? `Order #${o.number} is cancelled.` : `#${o.number} wasn't cancelled: ${r.reason}.`);
}
