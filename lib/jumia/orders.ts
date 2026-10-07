/**
 * Jumia orders and shipping labels, read-only (the GOP half of the Vendor API,
 * https://vendorcenter.jumia.com/api-docs/, openapi.yaml -> paths/orders/*.yaml).
 *
 * Reading is free: list orders, read an order's items and their shipment
 * providers, fetch the label of items already packed. Packing
 * (POST /v2/orders/pack, or the older POST /orders/pack), Ready to ship
 * (POST /orders/ready-to-ship) and Cancel (PUT /orders/cancel) change a real
 * customer's order and can't be undone through the API, so they are only ever
 * called from the admin pages under /admin/orders, for an order the owner has
 * switched on (lib/jumia/pack-allowlist.ts), after a confirmation.
 *
 * Roles: GET /orders and /orders/items need "VC - Order Viewer" or "VC - Order
 * Manager"; print-labels, pack, ready-to-ship and cancel need "VC - Order Manager". A Self Authorization app
 * made without them gets a 403, which describeError() names.
 *
 * Used by /admin/orders to try the flow on the owner's own shop (2026-10-06).
 */

import { JUMIA_API_BASE } from "@/lib/jumia/oauth";

export type JumiaCall<T> =
  | { ok: true;  data: T }
  | { ok: false; status: number; message: string };

export interface JumiaOrder {
  id:                       string;
  number:                   string;
  status:                   string;
  totalItems:               number;
  packedItems:              number;
  hasItemsFulfilledByJumia: boolean;
  hasMultipleStatus?:       boolean;
  isPrepayment?:            boolean;
  pendingSince?:            string;
  deliveryOption?:          string;
  totalAmountLocal?:        { currency: string; value: number };
  country?:                 { code: string; name?: string };
  shippingAddress?:         { firstName?: string; lastName?: string; city?: string; region?: string };
  createdAt:                string;
  updatedAt?:               string;
}

export interface JumiaOrderItem {
  id:                string;
  status:            string;
  trackingNumber?:   string | null;
  trackingUrl?:      string | null;
  shipmentType?:     string;
  isFulfilledByJumia?: boolean;
  deliveryOption?:   string;
  /** In the shop's own currency (country.currencyCode). */
  paidPriceLocal?:   number;
  itemPriceLocal?:   number;
  country?:          { code?: string; currencyCode?: string };
  product?:          { name?: string; sellerSku?: string; imageUrl?: string };
}

export interface JumiaLabel {
  orderItemIds:   string[];
  countryCode:    string;
  trackingNumber: string;
  /** The PDF, base64. */
  label:          string;
}

export interface ShipmentProvider {
  id:                   string;
  name:                 string;
  trackingCodeRequired?: boolean;
}

/**
 * One package for POST /v2/orders/pack. The spec types `orderItems` as one id
 * string (and its generated samples send one), but its rules speak of "all
 * Order Items in a package" (same order, same country, same method) and the
 * reply lists each package's items, so a LIST of the order's item ids is what
 * puts several items in one package, as Vendor Center does. Which one Jumia
 * really accepts was being tried on 2026-10-06 (/admin/orders/pack).
 */
export interface PackPackage {
  orderItems:         string | string[];
  shipmentProviderId: string;
  /** Only when the provider requires one (ShipmentProvider.trackingCodeRequired). */
  trackingCode?:      string;
}

export interface PackResult {
  success: { packages: { orderItems: string[]; trackingCode: string }[]; total?: number };
  error?:  { packages: { orderItems: string[]; error: string }[]; total?: number };
}

/** POST /orders/pack (the older call): items with their provider; Jumia groups them into packages. */
export interface PackV1Result {
  success: { packages: { orderItems: string[]; countryCode?: string; trackingNumber: string }[]; total?: number };
  error?:  { orderItems: { id: string; response: { code: string; message: string } }[]; total?: number };
}

export interface PrintLabelsResult {
  success: { labels: JumiaLabel[]; total?: number };
  error?:  { orderItems: { id: string; response: { code: string; message: string } }[]; total?: number };
}

/** What Jumia answers for one item it refused (ready to ship, cancel, print). */
export interface ItemRefusal {
  id:        string;
  response?: { code?: string; message?: string };
}

export interface ReadyToShipResult {
  success: { packages: { orderItems: string[]; countryCode?: string; trackingNumber: string }[]; total?: number };
  error?:  { orderItems: ItemRefusal[]; total?: number };
}

export interface CancelResult {
  success: { orderItems: { id: string; cancellationReason?: { id?: string; description?: string } }[]; total?: number };
  error?:  { orderItems: (ItemRefusal & { cancellationReason?: { description?: string } })[]; total?: number };
}

/** A readable reason from whatever Jumia answered with. */
export function describeError(status: number, json: unknown, text: string): string {
  const b = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const first = (v: unknown): string | null => {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (Array.isArray(v) && v.length > 0) return first(v[0]);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      return first(o.message) ?? first(o.description) ?? first(o.error) ?? null;
    }
    return null;
  };
  const detail = first(b.message) ?? first(b.error) ?? first(b.errors) ?? (text ? text.slice(0, 200) : null);
  if (status === 401) return `Jumia refused the token (401)${detail ? `: ${detail}` : ""}. Reconnect Jumia.`;
  if (status === 403) {
    return `Jumia says this app isn't allowed to do that (403)${detail ? `: ${detail}` : ""}. ` +
      "Its Vendor Center application needs the VC - Order Viewer role to read orders, and VC - Order Manager for labels.";
  }
  return `Jumia answered ${status}${detail ? `: ${detail}` : ""}`;
}

/** One Vendor API call, its answer or a readable reason. Shared with lib/jumia/shop.ts. */
export async function call<T>(
  accessToken: string,
  method:      "GET" | "POST" | "PUT",
  path:        string,
  opts:        { query?: Record<string, string | number | string[] | undefined>; body?: unknown } = {},
): Promise<JumiaCall<T>> {
  const url = new URL(`${JUMIA_API_BASE}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (Array.isArray(v)) for (const each of v) url.searchParams.append(k, each);
    else if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept:        "application/json",
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body:   opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(25_000),
    });
  } catch (e) {
    return { ok: false, status: 0, message: `Couldn't reach Jumia: ${(e as Error).message}` };
  }
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not JSON: described from the text */ }
  if (!res.ok) return { ok: false, status: res.status, message: describeError(res.status, json, text) };
  return { ok: true, data: json as T };
}

/**
 * GET /orders. With no dates Jumia returns only today's orders, and a date
 * range can't be longer than 3 months, so callers pass both.
 */
export function listOrders(
  accessToken: string,
  opts: {
    status?: string[]; createdAfter?: string; createdBefore?: string; updatedAfter?: string; updatedBefore?: string;
    size?: number; sort?: "ASC" | "DESC"; token?: string;
  } = {},
): Promise<JumiaCall<{ orders: JumiaOrder[]; nextToken: string | null; isLastPage: boolean }>> {
  return call(accessToken, "GET", "/orders", {
    query: {
      status:        opts.status?.join(","),
      createdAfter:  opts.createdAfter,
      createdBefore: opts.createdBefore,
      updatedAfter:  opts.updatedAfter,
      updatedBefore: opts.updatedBefore,
      size:          opts.size,
      sort:          opts.sort,
      token:         opts.token,
    },
  });
}

/**
 * The order number in an items response. The spec names it `orderNumber`, but
 * the real reply (seen 2026-10-06 on the owner's shop) didn't carry it under
 * that name, so any usual name is accepted. Empty when there is none: callers
 * that need a number the owner can trust use findOrderNumber instead.
 */
export function pickOrderNumber(raw: Record<string, unknown> | null | undefined): string {
  for (const k of ["orderNumber", "number", "orderNo", "order_number"]) {
    const v = raw?.[k];
    if ((typeof v === "string" || typeof v === "number") && String(v).trim()) return String(v).trim();
  }
  return "";
}

/**
 * GET /orders/items?orderId=…, with `raw` as Jumia sent it (for describeShape).
 *
 * The spec shows one object, {orderId, orderNumber, items}. The real reply is
 * a LIST of those, one per order asked for (seen 2026-10-06 on the owner's
 * shop: "0: object with orderId, orderNumber, items"), so both are accepted
 * and the entry for this order is picked.
 */
export async function getOrderItems(
  accessToken: string,
  orderId:     string,
): Promise<JumiaCall<{ orderId: string; orderNumber: string; items: JumiaOrderItem[]; raw: unknown }>> {
  const r = await call<unknown>(accessToken, "GET", "/orders/items", { query: { orderId } });
  if (!r.ok) return r;
  const entries = (Array.isArray(r.data) ? r.data : [r.data]).filter(
    (e): e is Record<string, unknown> => !!e && typeof e === "object" && !Array.isArray(e),
  );
  const entry = entries.find((e) => e.orderId === orderId) ?? entries[0] ?? {};
  return {
    ok: true,
    data: {
      orderId:     String(entry.orderId ?? orderId),
      orderNumber: pickOrderNumber(entry),
      items:       Array.isArray(entry.items) ? (entry.items as JumiaOrderItem[]) : [],
      raw:         r.data,
    },
  };
}

/**
 * The items of several orders in one call (GET /orders/items takes the
 * orderId repeated), by order id. Asked in chunks so the URL stays short.
 */
export async function getItemsOfOrders(
  accessToken: string,
  orderIds:    string[],
): Promise<JumiaCall<Map<string, { orderNumber: string; items: JumiaOrderItem[] }>>> {
  const out = new Map<string, { orderNumber: string; items: JumiaOrderItem[] }>();
  for (let i = 0; i < orderIds.length; i += 25) {
    const r = await call<unknown>(accessToken, "GET", "/orders/items", { query: { orderId: orderIds.slice(i, i + 25) } });
    if (!r.ok) return r;
    for (const e of Array.isArray(r.data) ? r.data : [r.data]) {
      if (!e || typeof e !== "object") continue;
      const entry = e as Record<string, unknown>;
      if (typeof entry.orderId !== "string") continue;
      out.set(entry.orderId, {
        orderNumber: pickOrderNumber(entry),
        items:       Array.isArray(entry.items) ? (entry.items as JumiaOrderItem[]) : [],
      });
    }
  }
  return { ok: true, data: out };
}

/** The providers Jumia offers for every one of the items: one package goes with one provider. */
export function commonProviders(ids: string[], byItem: Map<string, ShipmentProvider[]>): ShipmentProvider[] {
  const [first, ...rest] = ids.map((id) => byItem.get(id) ?? []);
  return (first ?? []).filter((p) => rest.every((list) => list.some((q) => q.id === p.id)));
}

/**
 * The number of an order, from the orders LIST (whose reply is the shape this
 * code was proven against), found by its id. Null when Jumia doesn't list it
 * in the last 60 days, so the caller refuses rather than guesses.
 */
export async function findOrderNumber(accessToken: string, orderId: string): Promise<string | null> {
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  let token: string | undefined;
  for (let page = 0; page < 5; page++) {
    const r = await listOrders(accessToken, { createdAfter: day(-60), createdBefore: day(1), size: 300, sort: "DESC", token });
    if (!r.ok) return null;
    const hit = r.data.orders.find((o) => o.id === orderId);
    if (hit) return String(hit.number);
    if (!r.data.nextToken) return null;
    token = r.data.nextToken;
  }
  return null;
}

/**
 * The items of an order a label can be printed for: already packed (they
 * have a tracking number) and shipped by the seller, not Fulfilled by Jumia.
 * Jumia checks the rest (same country, provider and method) and says which
 * item it refused and why.
 */
export function labelableItems(items: JumiaOrderItem[]): JumiaOrderItem[] {
  return items.filter((i) => !!i.trackingNumber && !i.isFulfilledByJumia);
}

/**
 * POST /orders/print-labels: one base64 PDF per package. Prints, and changes
 * nothing about the items (they must already be packed).
 */
export function printLabels(
  accessToken:  string,
  orderItemIds: string[],
): Promise<JumiaCall<PrintLabelsResult>> {
  return call(accessToken, "POST", "/orders/print-labels", { body: { orderItemIds } });
}

/** GET /orders/shipment-providers: the providers each item can go with. */
export function getShipmentProviders(
  accessToken:  string,
  orderItemIds: string[],
): Promise<JumiaCall<{ orderItems: { id: string; shipmentProviders: ShipmentProvider[] }[] }>> {
  return call(accessToken, "GET", "/orders/shipment-providers", { query: { orderItemId: orderItemIds } });
}

/**
 * POST /v2/orders/pack. CHANGES THE ORDER and can't be undone through the API:
 * each package gets a tracking number and the item is committed to its
 * provider. Only called from /admin/orders/pack (see the file comment).
 */
export function packItems(
  accessToken: string,
  packages:    PackPackage[],
): Promise<JumiaCall<PackResult>> {
  return call(accessToken, "POST", "/v2/orders/pack", { body: { packages } });
}

/**
 * POST /orders/pack, the older pack call: a list of {id, shipmentProviderId},
 * which Jumia requires to share provider, country, method and payment type,
 * and answers with the packages it made (its sample shows two items in one).
 * No tracking code field. CHANGES THE ORDER, like packItems; only called from
 * /admin/orders/pack when the owner chooses it after the v2 call was refused.
 */
export function packItemsV1(
  accessToken: string,
  items:       { id: string; shipmentProviderId: string }[],
): Promise<JumiaCall<PackV1Result>> {
  return call(accessToken, "POST", "/orders/pack", { body: { orderItems: items } });
}

/**
 * POST /orders/ready-to-ship: tells Jumia the packed items are ready to hand
 * over. Jumia requires them pending AND packed (with a tracking number), with
 * the same provider, method and country. CHANGES THE ORDER; only called from
 * /admin/orders/ready-to-ship.
 */
export function markReadyToShip(
  accessToken:  string,
  orderItemIds: string[],
): Promise<JumiaCall<ReadyToShipResult>> {
  return call(accessToken, "POST", "/orders/ready-to-ship", { body: { orderItemIds } });
}

/**
 * PUT /orders/cancel: cancels the items. Jumia allows it for items pending or
 * ready to ship. The request has no field for a reason, so Jumia records its
 * default cancellation reason. CANCELS A CUSTOMER'S ORDER and can't be undone;
 * only called from /admin/orders/cancel.
 */
export function cancelItems(
  accessToken:  string,
  orderItemIds: string[],
): Promise<JumiaCall<CancelResult>> {
  return call(accessToken, "PUT", "/orders/cancel", { body: { orderItemIds } });
}
