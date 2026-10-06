/**
 * Jumia orders and shipping labels, read-only (the GOP half of the Vendor API,
 * https://vendorcenter.jumia.com/api-docs/, openapi.yaml -> paths/orders/*.yaml).
 *
 * Reading is free: list orders, read an order's items and their shipment
 * providers, fetch the label of items already packed. Packing
 * (POST /v2/orders/pack) commits a real customer's order to a shipping
 * provider and can't be undone through the API, so it is only ever called
 * from /admin/orders/pack, for an order the owner has named
 * (lib/jumia/pack-allowlist.ts), item by item, after a confirmation. Ready to
 * ship and cancel are deliberately NOT here.
 *
 * Roles: GET /orders and /orders/items need "VC - Order Viewer" or "VC - Order
 * Manager"; print-labels needs "VC - Order Manager". A Self Authorization app
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
  product?:          { name?: string; sellerSku?: string };
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

/** One package: Jumia's samples send a single order item id per package. */
export interface PackPackage {
  orderItems:         string;
  shipmentProviderId: string;
  /** Only when the provider requires one (ShipmentProvider.trackingCodeRequired). */
  trackingCode?:      string;
}

export interface PackResult {
  success: { packages: { orderItems: string[]; trackingCode: string }[]; total?: number };
  error?:  { packages: { orderItems: string[]; error: string }[]; total?: number };
}

export interface PrintLabelsResult {
  success: { labels: JumiaLabel[]; total?: number };
  error?:  { orderItems: { id: string; response: { code: string; message: string } }[]; total?: number };
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

async function call<T>(
  accessToken: string,
  method:      "GET" | "POST",
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
  opts: { status?: string[]; createdAfter?: string; createdBefore?: string; size?: number; sort?: "ASC" | "DESC"; token?: string } = {},
): Promise<JumiaCall<{ orders: JumiaOrder[]; nextToken: string | null; isLastPage: boolean }>> {
  return call(accessToken, "GET", "/orders", {
    query: {
      status:        opts.status?.join(","),
      createdAfter:  opts.createdAfter,
      createdBefore: opts.createdBefore,
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
