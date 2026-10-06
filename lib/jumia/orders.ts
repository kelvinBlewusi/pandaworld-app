/**
 * Jumia orders and shipping labels, read-only (the GOP half of the Vendor API,
 * https://vendorcenter.jumia.com/api-docs/, openapi.yaml -> paths/orders/*.yaml).
 *
 * Only calls that change nothing about an order are here: list orders, read an
 * order's items, fetch the label of items already packed. Packing
 * (POST /v2/orders/pack) and Ready to ship are deliberately NOT here: they
 * commit a real customer's order to a shipping provider and can't be undone
 * through the API. Add them only with the seller's say-so, order by order.
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
  opts:        { query?: Record<string, string | number | undefined>; body?: unknown } = {},
): Promise<JumiaCall<T>> {
  const url = new URL(`${JUMIA_API_BASE}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
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

/** GET /orders/items?orderId=… */
export function getOrderItems(
  accessToken: string,
  orderId:     string,
): Promise<JumiaCall<{ orderId: string; orderNumber: string; items: JumiaOrderItem[] }>> {
  return call(accessToken, "GET", "/orders/items", { query: { orderId } });
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
