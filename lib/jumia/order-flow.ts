/**
 * The Jumia half of the WhatsApp order flow (lib/whatsapp/orders.ts): which
 * orders are waiting, packing several at once, one PDF of all their labels,
 * Ready to ship, Cancel. No WhatsApp here, and nothing country-specific:
 * one Vendor API for every Jumia market, the seller's own token deciding the
 * shop (AGENTS.md, "Every Jumia country").
 *
 * Every change is read back afterwards and the result is what Jumia then
 * has, not what its answer said: the admin trial (/admin/orders) showed the
 * order-level status can stay PENDING after the items moved on.
 */

import { PDFDocument } from "pdf-lib";
import {
  cancelItems, commonProviders, getItemsOfOrders, getShipmentProviders, listOrders, markReadyToShip, packItems,
  printLabels, type JumiaCall, type JumiaOrder, type JumiaOrderItem, type ShipmentProvider,
} from "@/lib/jumia/orders";

/** An item's status as one word: "Ready To Ship" and "READY_TO_SHIP" both read READY_TO_SHIP. */
export const statusOf = (i: JumiaOrderItem) => String(i.status ?? "").trim().toUpperCase().replace(/[^A-Z]+/g, "_");

/** Still to pack: pending, no tracking number, shipped by the seller. */
export const isToPack = (i: JumiaOrderItem) => statusOf(i) === "PENDING" && !i.trackingNumber && !i.isFulfilledByJumia;
/** Packed, label ready, not yet ready to ship. */
export const isPacked = (i: JumiaOrderItem) => statusOf(i) === "PENDING" && !!i.trackingNumber && !i.isFulfilledByJumia;
/** Jumia cancels items pending or ready to ship; Fulfilled by Jumia items aren't the seller's to cancel. */
export const isCancellable = (i: JumiaOrderItem) =>
  (statusOf(i) === "PENDING" || statusOf(i) === "READY_TO_SHIP") && !i.isFulfilledByJumia;

export interface WaitingOrder {
  id:        string;
  number:    string;
  createdAt: string;
  total:     { currency: string; value: number } | null;
  delivery:  string;
  items:     JumiaOrderItem[];
}

export const toPackItems = (o: WaitingOrder) => o.items.filter(isToPack);
export const packedItems = (o: WaitingOrder) => o.items.filter(isPacked);

/**
 * The seller's orders that still need them: an item to pack, or packed and
 * not yet ready to ship. Oldest first. `days` bounds how far back to look.
 */
export async function waitingOrders(accessToken: string, days = 30): Promise<JumiaCall<WaitingOrder[]>> {
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const orders: JumiaOrder[] = [];
  let token: string | undefined;
  for (let page = 0; page < 5; page++) {
    const r = await listOrders(accessToken, { status: ["PENDING"], createdAfter: day(-days), createdBefore: day(1), size: 100, sort: "ASC", token });
    if (!r.ok) return r;
    orders.push(...(r.data.orders ?? []));
    if (!r.data.nextToken) break;
    token = r.data.nextToken;
  }
  if (orders.length === 0) return { ok: true, data: [] };
  const items = await getItemsOfOrders(accessToken, orders.map((o) => o.id));
  if (!items.ok) return items;
  const waiting = orders
    .map((o): WaitingOrder => {
      const its = items.data.get(o.id)?.items ?? [];
      return {
        id:        o.id,
        number:    String(o.number),
        createdAt: o.createdAt,
        total:     o.totalAmountLocal ?? null,
        delivery:  o.deliveryOption ?? its[0]?.deliveryOption ?? "",
        items:     its,
      };
    })
    .filter((o) => o.items.some((i) => isToPack(i) || isPacked(i)));
  return { ok: true, data: waiting };
}

/** Re-read these orders' items, as Jumia now has them. */
async function readBack(accessToken: string, orders: WaitingOrder[]): Promise<Map<string, JumiaOrderItem[]> | null> {
  const r = await getItemsOfOrders(accessToken, orders.map((o) => o.id));
  if (!r.ok) return null;
  return new Map(Array.from(r.data.entries()).map(([id, v]) => [id, v.items]));
}

export interface PackOutcome {
  /** Orders now packed (read back), with their tracking number. */
  packed:      { order: WaitingOrder; tracking: string; station: string }[];
  /** Orders with more than one station Jumia offers: the seller picks. */
  needStation: { order: WaitingOrder; stations: ShipmentProvider[] }[];
  failed:      { order: WaitingOrder; reason: string }[];
}

/**
 * Pack each order as ONE package (AGENTS.md: one package per order, always)
 * at the station Jumia offers for all its items: the only one when there is
 * one (the usual case: the API offers the station linked to the shop), else
 * `stationId` when the seller picked it. All in one POST /v2/orders/pack, an
 * order's item ids as a list, then read back.
 */
export async function packOrders(accessToken: string, orders: WaitingOrder[], stationId?: string): Promise<PackOutcome> {
  const out: PackOutcome = { packed: [], needStation: [], failed: [] };
  const todo = orders.filter((o) => toPackItems(o).length > 0);
  if (todo.length === 0) return out;

  const allIds = todo.flatMap((o) => toPackItems(o).map((i) => i.id));
  const byItem = new Map<string, ShipmentProvider[]>();
  for (let i = 0; i < allIds.length; i += 50) {
    const r = await getShipmentProviders(accessToken, allIds.slice(i, i + 50));
    if (!r.ok) {
      out.failed.push(...todo.map((order) => ({ order, reason: `couldn't get the drop-off stations: ${r.message}` })));
      return out;
    }
    for (const o of r.data.orderItems ?? []) byItem.set(o.id, o.shipmentProviders ?? []);
  }

  const plan: { order: WaitingOrder; station: ShipmentProvider }[] = [];
  for (const order of todo) {
    const stations = commonProviders(toPackItems(order).map((i) => i.id), byItem);
    const chosen = stations.find((s) => s.id === stationId) ?? (stations.length === 1 ? stations[0] : undefined);
    if (stations.length === 0) out.failed.push({ order, reason: "Jumia offers no drop-off station that takes all its items" });
    else if (!chosen) out.needStation.push({ order, stations });
    else if (chosen.trackingCodeRequired) out.failed.push({ order, reason: `${chosen.name} needs a tracking code: pack it in Vendor Center` });
    else plan.push({ order, station: chosen });
  }
  if (plan.length === 0) return out;

  const r = await packItems(
    accessToken,
    plan.map(({ order, station }) => ({ orderItems: toPackItems(order).map((i) => i.id), shipmentProviderId: station.id })),
  );
  const refusals = r.ok ? r.data.error?.packages ?? [] : [];
  console.info(
    `[orders] packed ${plan.length} order(s) via the bot: ` +
      (r.ok ? `${r.data.success?.packages?.length ?? 0} package(s), ${refusals.length} refused` : `refused (${r.message.slice(0, 160)})`),
  );

  const after = await readBack(accessToken, plan.map((p) => p.order));
  for (const { order, station } of plan) {
    const ids = new Set(toPackItems(order).map((i) => i.id));
    const now = (after?.get(order.id) ?? []).filter((i) => ids.has(i.id));
    const tracking = now.find((i) => i.trackingNumber)?.trackingNumber;
    if (tracking) {
      out.packed.push({ order: { ...order, items: after?.get(order.id) ?? order.items }, tracking, station: station.name });
      continue;
    }
    const refused = refusals.find((p) => (p.orderItems ?? []).some((id) => ids.has(id)));
    out.failed.push({
      order,
      reason: !after ? "Jumia's answer couldn't be checked: look at it in Vendor Center"
        : refused?.error ?? (r.ok ? "Jumia didn't pack it" : r.message),
    });
  }
  return out;
}

/**
 * One PDF of the labels of these packed items: Jumia sends one PDF per
 * package (POST /orders/print-labels), merged here into one document, one
 * page per order, so the seller prints once.
 */
export async function labelsPdf(
  accessToken: string,
  items:       JumiaOrderItem[],
): Promise<{ ok: true; pdf: Uint8Array; labels: number } | { ok: false; reason: string }> {
  const ids = items.filter((i) => i.trackingNumber && !i.isFulfilledByJumia).map((i) => i.id);
  if (ids.length === 0) return { ok: false, reason: "nothing is packed yet" };
  const r = await printLabels(accessToken, ids);
  if (!r.ok) return { ok: false, reason: r.message };
  const labels = r.data.success?.labels ?? [];
  const pdfs = labels
    .map((l) => Buffer.from(String(l.label ?? ""), "base64"))
    .filter((b) => b.subarray(0, 4).toString("latin1") === "%PDF");
  if (pdfs.length === 0) {
    const why = r.data.error?.orderItems?.[0]?.response?.message;
    return { ok: false, reason: why ? `Jumia: ${why}` : "Jumia didn't return a label yet" };
  }
  return { ok: true, pdf: await mergePdfs(pdfs), labels: pdfs.length };
}

/** Several PDFs as one, pages in order. */
export async function mergePdfs(pdfs: Uint8Array[]): Promise<Uint8Array> {
  if (pdfs.length === 1) return pdfs[0];
  const merged = await PDFDocument.create();
  for (const bytes of pdfs) {
    const doc = await PDFDocument.load(bytes);
    for (const page of await merged.copyPages(doc, doc.getPageIndices())) merged.addPage(page);
  }
  return merged.save();
}

/** Mark the packed items of these orders ready to ship, in one call, then read back. */
export async function readyToShip(
  accessToken: string,
  orders:      WaitingOrder[],
): Promise<{ done: WaitingOrder[]; failed: { order: WaitingOrder; reason: string }[] }> {
  const todo = orders.filter((o) => packedItems(o).length > 0);
  if (todo.length === 0) return { done: [], failed: [] };
  const r = await markReadyToShip(accessToken, todo.flatMap((o) => packedItems(o).map((i) => i.id)));
  const refusals = r.ok ? r.data.error?.orderItems ?? [] : [];
  console.info(`[orders] ready to ship ${todo.length} order(s) via the bot: ${r.ok ? `${refusals.length} item(s) refused` : `refused (${r.message.slice(0, 160)})`}`);
  const after = await readBack(accessToken, todo);
  const done: WaitingOrder[] = [];
  const failed: { order: WaitingOrder; reason: string }[] = [];
  for (const order of todo) {
    const ids = new Set(packedItems(order).map((i) => i.id));
    const now = (after?.get(order.id) ?? []).filter((i) => ids.has(i.id));
    if (now.length > 0 && now.every((i) => statusOf(i) !== "PENDING")) {
      done.push(order);
      continue;
    }
    const refused = refusals.find((e) => ids.has(e.id));
    failed.push({
      order,
      reason: !after ? "Jumia's answer couldn't be checked: look at it in Vendor Center"
        : refused?.response?.message ?? (r.ok ? "Jumia didn't mark it" : r.message),
    });
  }
  return { done, failed };
}

/**
 * Cancel an order's items. Jumia's request has no reason field, so it records
 * its default cancellation reason. Read back afterwards.
 */
export async function cancelOrder(accessToken: string, order: WaitingOrder): Promise<{ ok: true } | { ok: false; reason: string }> {
  const ids = order.items.filter(isCancellable).map((i) => i.id);
  if (ids.length === 0) return { ok: false, reason: "nothing on it can be cancelled any more" };
  const r = await cancelItems(accessToken, ids);
  console.info(`[orders] cancel order #${order.number} via the bot: ${r.ok ? `${r.data.error?.orderItems?.length ?? 0} item(s) refused` : `refused (${r.message.slice(0, 160)})`}`);
  const after = await readBack(accessToken, [order]);
  const now = (after?.get(order.id) ?? []).filter((i) => ids.includes(i.id));
  if (now.length > 0 && now.every((i) => statusOf(i) === "CANCELED" || statusOf(i) === "CANCELLED")) return { ok: true };
  const refused = r.ok ? r.data.error?.orderItems?.[0]?.response?.message : null;
  return {
    ok: false,
    reason: !after ? "Jumia's answer couldn't be checked: look at it in Vendor Center" : refused ?? (r.ok ? "Jumia didn't cancel it" : r.message),
  };
}
