/**
 * Packing an order from /admin/orders, for one order the owner has named.
 *
 *   GET  /admin/orders/pack?orderId=…  a page that changes NOTHING: the order's
 *        items, and for each the shipping providers Jumia offers, in a form.
 *   POST /admin/orders/pack            packs the items the owner ticked.
 *
 * Packing assigns each package a tracking number and commits the item to its
 * shipping provider. Jumia's API has no undo for it, so every guard below
 * fails closed:
 *   - admin only, and only the caller's OWN Jumia connection;
 *   - only an order number listed in app_settings (lib/jumia/pack-allowlist.ts);
 *   - the owner ticks each item, picks its provider and ticks the confirmation;
 *   - on POST the order is read again and each ticked item must STILL be
 *     pending, unpacked and seller-shipped, with a provider Jumia lists for it;
 *   - each item is its own package (Jumia's samples send one item id per
 *     package), so nothing is grouped on a guess;
 *   - a POST from another site is refused.
 * A route handler isn't wrapped by app/admin/layout.tsx, so it checks admin itself.
 */

import { auth } from "@clerk/nextjs/server";
import { isAdmin } from "@/lib/auth/is-admin";
import { getValidJumiaCredentials } from "@/lib/jumia/api";
import {
  findOrderNumber, getOrderItems, getShipmentProviders, packItems,
  type JumiaOrderItem, type PackPackage, type ShipmentProvider,
} from "@/lib/jumia/orders";
import { isPackAllowed } from "@/lib/jumia/pack-allowlist";
import { describeShape, esc, htmlPage as html } from "@/lib/jumia/order-pages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ORDER_ID_RE = /^[0-9a-f-]{36}$/i;

/** Still to pack: pending, no tracking number yet, shipped by the seller. */
const packable = (i: JumiaOrderItem) =>
  String(i.status).toUpperCase() === "PENDING" && !i.trackingNumber && !i.isFulfilledByJumia;

async function loadOrder(userId: string, orderId: string) {
  let creds: Awaited<ReturnType<typeof getValidJumiaCredentials>>;
  try {
    creds = await getValidJumiaCredentials(userId);
  } catch (e) {
    return { error: html(`<p>Jumia isn't connected for your account (${esc((e as Error).message)}).</p>`, 400) };
  }
  const order = await getOrderItems(creds.accessToken, orderId);
  if (!order.ok) return { error: html(`<p><b>Couldn't read the order.</b> ${esc(order.message)}</p>`, 502) };
  // The number comes from the orders LIST, where it is known to be what Jumia
  // calls the order, not from the items reply (which didn't carry it on
  // 2026-10-06), and never from the form.
  const orderNumber = await findOrderNumber(creds.accessToken, orderId);
  if (!orderNumber) {
    return {
      error: html(
        `<h2>Order</h2><p>I couldn't confirm this order's number with Jumia, so packing stays off. ` +
          `Jumia's items reply has these fields:</p><pre>${esc(describeShape(order.data.raw))}</pre>`,
        409,
      ),
    };
  }
  if (!(await isPackAllowed(orderNumber))) {
    return {
      error: html(
        `<h2>Order #${esc(orderNumber)}</h2>` +
          `<p>Packing isn't switched on for this order. It is allowed one order at a time, by the owner, because packing ` +
          `commits the order to a shipping provider and can't be undone.</p>`,
        403,
      ),
    };
  }
  return { creds, orderNumber, items: order.data.items, raw: order.data.raw };
}

export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId || !isAdmin(userId)) return new Response("Not found", { status: 404 });

  const orderId = new URL(req.url).searchParams.get("orderId") ?? "";
  if (!ORDER_ID_RE.test(orderId)) return html("<p>That isn't an order.</p>", 400);

  const loaded = await loadOrder(userId, orderId);
  if ("error" in loaded) return loaded.error;
  const { creds, orderNumber, items, raw } = loaded;

  const todo = items.filter(packable);
  if (todo.length === 0) {
    return html(
      `<h2>Order #${esc(orderNumber)}</h2><p>Nothing left to pack on this order: every item is packed, or not pending.</p>` +
        `<p>What Jumia sent, without the customer's details:</p><pre>${esc(describeShape(raw))}</pre>`,
    );
  }

  const providers = await getShipmentProviders(creds.accessToken, todo.map((i) => i.id));
  if (!providers.ok) return html(`<h2>Order #${esc(orderNumber)}</h2><p><b>Couldn't get the shipping providers.</b> ${esc(providers.message)}</p>`, 502);
  const byItem = new Map(providers.data.orderItems.map((o) => [o.id, o.shipmentProviders ?? []]));

  const rows = todo.map((i) => {
    const list = byItem.get(i.id) ?? [];
    const options = list
      .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${p.trackingCodeRequired ? " (needs a tracking code)" : ""}</option>`)
      .join("");
    return (
      `<fieldset style="margin:12px 0;padding:12px;border:1px solid #ccc;border-radius:6px"><legend>${esc(i.product?.name ?? i.id)}</legend>` +
      (list.length === 0
        ? `<p>Jumia lists no shipping provider for this item, so it can't be packed here.</p>`
        : `<label><input type="checkbox" name="item" value="${esc(i.id)}"> Pack this item</label><br>` +
          `<label>Shipping provider <select name="provider_${esc(i.id)}">${options}</select></label><br>` +
          `<label>Tracking code (only if the provider needs one) <input name="tracking_${esc(i.id)}" autocomplete="off"></label>`) +
      `</fieldset>`
    );
  }).join("");

  return html(
    `<h2>Pack order #${esc(orderNumber)}</h2>` +
      `<p>Each item you tick becomes its <b>own package, with its own tracking number and label</b>. ` +
      `Packing commits the item to the shipping provider you pick and <b>can't be undone from here</b>. ` +
      `To put several items in one package, pack them in Vendor Center instead.</p>` +
      `<form method="post" action="/admin/orders/pack"><input type="hidden" name="orderId" value="${esc(orderId)}">${rows}` +
      `<p><label><input type="checkbox" name="confirm" value="yes"> I understand this commits the ticked items to the courier and can't be undone.</label></p>` +
      `<button type="submit">Pack the ticked items</button></form>` +
      `<details style="margin-top:20px"><summary>What Jumia sent (no customer details)</summary><pre>${esc(describeShape(raw))}</pre></details>`,
  );
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId || !isAdmin(userId)) return new Response("Not found", { status: 404 });

  // Only from this site's own page.
  const origin = req.headers.get("origin");
  if (origin) {
    let originHost = "";
    try { originHost = new URL(origin).host; } catch { /* malformed: refused below */ }
    if (!originHost || (originHost !== new URL(req.url).host && originHost !== req.headers.get("host"))) {
      return new Response("Forbidden", { status: 403 });
    }
  }

  const form = await req.formData().catch(() => null);
  const orderId = String(form?.get("orderId") ?? "");
  if (!ORDER_ID_RE.test(orderId)) return html("<p>That isn't an order.</p>", 400);
  if (form?.get("confirm") !== "yes") return html("<p>Nothing was packed: the confirmation box wasn't ticked.</p>", 400);

  const ticked = (form?.getAll("item") ?? []).map(String);
  if (ticked.length === 0) return html("<p>Nothing was packed: no item was ticked.</p>", 400);

  const loaded = await loadOrder(userId, orderId);
  if ("error" in loaded) return loaded.error;
  const { creds, orderNumber, items } = loaded;

  // Each ticked item must still be packable, and the provider one Jumia lists for it.
  const chosen = ticked.map((id) => items.find((i) => i.id === id));
  if (chosen.some((i) => !i || !packable(i))) {
    return html(`<h2>Order #${esc(orderNumber)}</h2><p>Nothing was packed: a ticked item isn't pending and unpacked any more. Reload the order.</p>`, 409);
  }
  const providers = await getShipmentProviders(creds.accessToken, ticked);
  if (!providers.ok) return html(`<p><b>Couldn't check the shipping providers, so nothing was packed.</b> ${esc(providers.message)}</p>`, 502);
  const offered = new Map<string, ShipmentProvider[]>(providers.data.orderItems.map((o) => [o.id, o.shipmentProviders ?? []]));

  const packages: PackPackage[] = [];
  for (const id of ticked) {
    const providerId = String(form?.get(`provider_${id}`) ?? "");
    const provider = (offered.get(id) ?? []).find((p) => p.id === providerId);
    if (!provider) return html(`<p>Nothing was packed: the shipping provider chosen for an item isn't one Jumia offers for it.</p>`, 400);
    const trackingCode = String(form?.get(`tracking_${id}`) ?? "").trim();
    if (provider.trackingCodeRequired && !trackingCode) {
      return html(`<p>Nothing was packed: ${esc(provider.name)} needs a tracking code and none was entered.</p>`, 400);
    }
    packages.push({ orderItems: id, shipmentProviderId: provider.id, ...(provider.trackingCodeRequired ? { trackingCode } : {}) });
  }

  const result = await packItems(creds.accessToken, packages);
  if (!result.ok) return html(`<h2>Order #${esc(orderNumber)}</h2><p><b>Jumia didn't pack it.</b> ${esc(result.message)}</p>`, 502);

  const packed = result.data.success?.packages ?? [];
  const refused = result.data.error?.packages ?? [];
  console.info(`[orders] pack order #${orderNumber}: ${packed.length} package(s) packed, ${refused.length} refused`);

  const okRows = packed.map((p) => `<li>Packed. Tracking code <b>${esc(p.trackingCode)}</b></li>`).join("");
  const badRows = refused.map((p) => `<li>Refused: ${esc(p.error)}</li>`).join("");
  return html(
    `<h2>Order #${esc(orderNumber)}</h2>` +
      (packed.length ? `<ul>${okRows}</ul>` : "") +
      (refused.length ? `<p><b>Jumia refused:</b></p><ul>${badRows}</ul>` : "") +
      (packed.length
        ? `<form method="post" action="/admin/orders/label" target="_blank"><input type="hidden" name="orderId" value="${esc(orderId)}">` +
          `<button type="submit">Get the label</button></form>`
        : ""),
    refused.length && !packed.length ? 422 : 200,
  );
}
