/**
 * What the admin routes that CHANGE an order share (app/admin/orders/pack,
 * ready-to-ship, cancel): the same-site check, and loading an order only when
 * the owner has switched it on (lib/jumia/pack-allowlist.ts), with its number
 * taken from Jumia's orders list, never from the form.
 */

import { getValidJumiaCredentials } from "@/lib/jumia/api";
import { findOrderNumber, getOrderItems, type JumiaOrderItem } from "@/lib/jumia/orders";
import { isPackAllowed } from "@/lib/jumia/pack-allowlist";
import { describeShape, esc, htmlPage as html } from "@/lib/jumia/order-pages";

export const ORDER_ID_RE = /^[0-9a-f-]{36}$/i;

/** An item's status as one word: "Ready To Ship" and "READY_TO_SHIP" both read READY_TO_SHIP. */
export const itemStatus = (i: JumiaOrderItem) =>
  String(i.status ?? "").trim().toUpperCase().replace(/[^A-Z]+/g, "_");

export const itemName = (i: JumiaOrderItem) => i.product?.name ?? i.id;

/** False for a POST from another site. A request without an Origin header is let through (same as before). */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  let originHost = "";
  try { originHost = new URL(origin).host; } catch { return false; }
  return !!originHost && (originHost === new URL(req.url).host || originHost === req.headers.get("host"));
}

export type LoadedOrder = {
  creds:       Awaited<ReturnType<typeof getValidJumiaCredentials>>;
  orderNumber: string;
  items:       JumiaOrderItem[];
  raw:         unknown;
};

/** The order, only if the owner has switched it on for changes; otherwise the page that says why. */
export async function loadAllowedOrder(userId: string, orderId: string): Promise<LoadedOrder | { error: Response }> {
  let creds: LoadedOrder["creds"];
  try {
    creds = await getValidJumiaCredentials(userId);
  } catch (e) {
    return { error: html(`<p>Jumia isn't connected for your account (${esc((e as Error).message)}).</p>`, 400) };
  }
  const order = await getOrderItems(creds.accessToken, orderId);
  if (!order.ok) return { error: html(`<p><b>Couldn't read the order.</b> ${esc(order.message)}</p>`, 502) };
  const orderNumber = await findOrderNumber(creds.accessToken, orderId);
  if (!orderNumber) {
    return {
      error: html(
        `<h2>Order</h2><p>I couldn't confirm this order's number with Jumia, so changes stay off. ` +
          `Jumia's items reply has these fields:</p><pre>${esc(describeShape(order.data.raw))}</pre>`,
        409,
      ),
    };
  }
  if (!(await isPackAllowed(orderNumber))) {
    return {
      error: html(
        `<h2>Order #${esc(orderNumber)}</h2>` +
          `<p>Changes aren't switched on for this order. Packing, Ready to ship and Cancel are allowed one order at a ` +
          `time, by the owner, because they change a real customer's order and can't be undone.</p>`,
        403,
      ),
    };
  }
  return { creds, orderNumber, items: order.data.items, raw: order.data.raw };
}
