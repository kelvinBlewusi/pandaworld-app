/**
 * "Pack order and get label" from /admin/orders, for one order the owner has
 * named: the test bench for the WhatsApp button of the same name.
 *
 *   GET  /admin/orders/pack?orderId=…  a page that changes NOTHING: the items
 *        still to pack and the shipping providers Jumia offers for all of them.
 *   POST /admin/orders/pack            packs those items into ONE package, as
 *        Vendor Center does, then fetches its label.
 *
 * Packing gives the package a tracking number and commits the items to the
 * shipping provider. Jumia's API has no undo for it, so every guard fails closed:
 *   - admin only, and only the caller's OWN Jumia connection;
 *   - only an order number listed in app_settings (lib/jumia/pack-allowlist.ts);
 *   - the owner picks the provider and ticks the confirmation;
 *   - on POST the order is read again: the items still to pack must be exactly
 *     the ones the page showed, each pending, unpacked and seller-shipped, and
 *     the provider one Jumia offers for every one of them;
 *   - a POST from another site is refused.
 * Whatever Jumia answers, the order is read again afterwards and the page shows
 * each item as Jumia now has it, so a partial or unexpected result is seen, not
 * assumed.
 *
 * Which shape puts several items in one package is what this tries
 * (lib/jumia/orders.ts, PackPackage): first POST /v2/orders/pack with the item
 * ids as a list; if Jumia refuses and nothing was packed, the page offers the
 * older POST /orders/pack, which takes a list of items.
 * A route handler isn't wrapped by app/admin/layout.tsx, so it checks admin itself.
 */

import { auth } from "@clerk/nextjs/server";
import { isAdmin } from "@/lib/auth/is-admin";
import { getValidJumiaCredentials } from "@/lib/jumia/api";
import {
  findOrderNumber, getOrderItems, getShipmentProviders, labelableItems, packItems, packItemsV1, printLabels,
  type JumiaOrderItem, type ShipmentProvider,
} from "@/lib/jumia/orders";
import { isPackAllowed } from "@/lib/jumia/pack-allowlist";
import { describeShape, esc, htmlPage as html, itemsTable } from "@/lib/jumia/order-pages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Pack, read back and print in one request.
export const maxDuration = 60;

const ORDER_ID_RE = /^[0-9a-f-]{36}$/i;

/** Still to pack: pending, no tracking number yet, shipped by the seller. */
const packable = (i: JumiaOrderItem) =>
  String(i.status).toUpperCase() === "PENDING" && !i.trackingNumber && !i.isFulfilledByJumia;

const itemName = (i: JumiaOrderItem) => i.product?.name ?? i.id;

/** The providers Jumia offers for every one of the items: one package goes with one provider. */
function commonProviders(ids: string[], byItem: Map<string, ShipmentProvider[]>): ShipmentProvider[] {
  const [first, ...rest] = ids.map((id) => byItem.get(id) ?? []);
  return (first ?? []).filter((p) => rest.every((list) => list.some((q) => q.id === p.id)));
}

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
  // calls the order, never from the form.
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
  const common = commonProviders(todo.map((i) => i.id), byItem);

  if (common.length === 0) {
    const perItem = todo
      .map((i) => `<li>${esc(itemName(i))}: ${esc((byItem.get(i.id) ?? []).map((p) => p.name).join(", ") || "none")}</li>`)
      .join("");
    return html(
      `<h2>Order #${esc(orderNumber)}</h2>` +
        `<p>Jumia offers no shipping provider that takes all these items, so they can't go in one package here. ` +
        `Pack this order in Vendor Center.</p><ul>${perItem}</ul>`,
      409,
    );
  }

  const others = items.filter((i) => !packable(i));
  const options = common
    .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${p.trackingCodeRequired ? " (needs a tracking code)" : ""}</option>`)
    .join("");
  return html(
    `<h2>Pack order #${esc(orderNumber)} and get the label</h2>` +
      `<p>${todo.length === 1 ? "This item goes" : `All <b>${todo.length} items</b> go`} into <b>one package</b>, as Vendor Center ` +
      `does, with one tracking number and one label. Packing commits ${todo.length === 1 ? "it" : "them"} to the shipping ` +
      `provider you pick and <b>can't be undone from here</b>.</p>` +
      `<ul>${todo.map((i) => `<li>${esc(itemName(i))}</li>`).join("")}</ul>` +
      (others.length ? `<p>Not in this package (already packed, or not pending): ${others.map((i) => esc(itemName(i))).join(", ")}</p>` : "") +
      `<form method="post" action="/admin/orders/pack"><input type="hidden" name="orderId" value="${esc(orderId)}">` +
      todo.map((i) => `<input type="hidden" name="item" value="${esc(i.id)}">`).join("") +
      `<input type="hidden" name="api" value="v2">` +
      `<p><label>Shipping provider <select name="provider">${options}</select></label></p>` +
      (common.some((p) => p.trackingCodeRequired)
        ? `<p><label>Tracking code (only if the provider needs one) <input name="tracking" autocomplete="off"></label></p>`
        : "") +
      `<p><label><input type="checkbox" name="confirm" value="yes"> I understand this commits the order to the courier and can't be undone.</label></p>` +
      `<button type="submit">Pack order and get label</button></form>` +
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
  const api = String(form?.get("api") ?? "");
  if (api !== "v2" && api !== "v1") return html("<p>Nothing was packed: unknown pack call.</p>", 400);

  const shown = Array.from(new Set((form?.getAll("item") ?? []).map(String)));
  if (shown.length === 0) return html("<p>Nothing was packed: no item was sent.</p>", 400);

  const loaded = await loadOrder(userId, orderId);
  if ("error" in loaded) return loaded.error;
  const { creds, orderNumber, items } = loaded;
  const head = `<h2>Order #${esc(orderNumber)}</h2>`;

  // The items still to pack must be exactly the ones the page showed.
  const todo = items.filter(packable);
  if (todo.length !== shown.length || !shown.every((id) => todo.some((i) => i.id === id))) {
    return html(
      `${head}<p>Nothing was packed: the order changed since the page was opened (an item was packed, cancelled or added). ` +
        `Go back and open it again.</p>`,
      409,
    );
  }
  const ids = todo.map((i) => i.id);

  const providers = await getShipmentProviders(creds.accessToken, ids);
  if (!providers.ok) return html(`${head}<p><b>Couldn't check the shipping providers, so nothing was packed.</b> ${esc(providers.message)}</p>`, 502);
  const common = commonProviders(ids, new Map(providers.data.orderItems.map((o) => [o.id, o.shipmentProviders ?? []])));
  const provider = common.find((p) => p.id === String(form?.get("provider") ?? ""));
  if (!provider) return html(`${head}<p>Nothing was packed: that shipping provider isn't one Jumia offers for all these items.</p>`, 400);
  const trackingCode = String(form?.get("tracking") ?? "").trim();
  if (provider.trackingCodeRequired && !trackingCode) {
    return html(`${head}<p>Nothing was packed: ${esc(provider.name)} needs a tracking code and none was entered.</p>`, 400);
  }
  if (provider.trackingCodeRequired && api === "v1") {
    return html(`${head}<p>Nothing was packed: the older pack call can't send the tracking code ${esc(provider.name)} needs.</p>`, 400);
  }

  // Pack, in the shape being tried.
  let made: { items: string[]; tracking: string }[] = [];
  let refusals: string[] = [];
  let failure: string | null = null;
  if (api === "v2") {
    const r = await packItems(creds.accessToken, [
      { orderItems: ids, shipmentProviderId: provider.id, ...(provider.trackingCodeRequired ? { trackingCode } : {}) },
    ]);
    if (!r.ok) failure = r.message;
    else {
      made = (r.data.success?.packages ?? []).map((p) => ({ items: p.orderItems ?? [], tracking: p.trackingCode }));
      refusals = (r.data.error?.packages ?? []).map((p) => p.error);
    }
  } else {
    const r = await packItemsV1(creds.accessToken, ids.map((id) => ({ id, shipmentProviderId: provider.id })));
    if (!r.ok) failure = r.message;
    else {
      made = (r.data.success?.packages ?? []).map((p) => ({ items: p.orderItems ?? [], tracking: p.trackingNumber }));
      refusals = (r.data.error?.orderItems ?? []).map((e) => `${e.response?.code ?? ""}: ${e.response?.message ?? ""}`);
    }
  }
  const callName = api === "v2" ? "POST /v2/orders/pack, items as a list" : "POST /orders/pack (older call)";
  console.info(
    `[orders] pack order #${orderNumber}, ${ids.length} item(s), via ${callName}: ` +
      (failure ? `refused (${failure.slice(0, 160)})` : `${made.length} package(s) packed, ${refusals.length} refused`),
  );

  const answer = failure
    ? `<p><b>Jumia didn't pack it</b> (${esc(callName)}): ${esc(failure)}</p>`
    : `<details><summary>What Jumia answered (${esc(callName)})</summary><ul>` +
      made.map((p) => `<li>Package of ${p.items.length} item(s), tracking ${esc(p.tracking)}</li>`).join("") +
      refusals.map((e) => `<li>Refused: ${esc(e)}</li>`).join("") +
      `</ul></details>`;

  // What Jumia now has is the truth, whatever the answer said.
  const after = await getOrderItems(creds.accessToken, orderId);
  if (!after.ok) {
    return html(
      `${head}${answer}<p><b>Couldn't read the order back</b> (${esc(after.message)}). Check it in Vendor Center before trying again.</p>`,
      502,
    );
  }
  const table = `<p>The order as Jumia has it now:</p>${itemsTable(after.data.items)}`;
  const packed = labelableItems(after.data.items.filter((i) => ids.includes(i.id)));

  if (packed.length === 0) {
    // Nothing packed: the v2 list shape may be what Jumia refused, so offer the older call.
    const retry =
      api === "v2" && !provider.trackingCodeRequired
        ? `<p>If Jumia's reason above is about the request's format, the older pack call takes a list of items:</p>` +
          `<form method="post" action="/admin/orders/pack"><input type="hidden" name="orderId" value="${esc(orderId)}">` +
          ids.map((id) => `<input type="hidden" name="item" value="${esc(id)}">`).join("") +
          `<input type="hidden" name="api" value="v1"><input type="hidden" name="provider" value="${esc(provider.id)}">` +
          `<p><label><input type="checkbox" name="confirm" value="yes"> I understand this commits the order to the courier and can't be undone.</label></p>` +
          `<button type="submit">Try the older pack call</button></form>`
        : "";
    return html(`${head}${answer}<p>Nothing on this order was packed.</p>${table}${retry}`, failure ? 502 : 422);
  }

  const packages = new Set(packed.map((i) => i.trackingNumber)).size;
  const partial =
    packed.length < ids.length
      ? `<p><b>Only ${packed.length} of ${ids.length} items were packed.</b> Pack the rest in Vendor Center.</p>`
      : "";
  const summary =
    `<p>✅ Packed ${packed.length} item(s) into <b>${packages} package${packages === 1 ? "" : "s"}</b>` +
    ` with ${esc(provider.name)}.</p>${partial}`;

  // The label, straight away.
  const labelForm =
    `<form method="post" action="/admin/orders/label" target="_blank"><input type="hidden" name="orderId" value="${esc(orderId)}">` +
    `<button type="submit">Open the label</button></form>`;
  const printed = await printLabels(creds.accessToken, packed.map((i) => i.id));
  const labels = printed.ok ? printed.data.success?.labels ?? [] : [];
  const pdfs = labels.filter((l) => Buffer.from(String(l.label ?? ""), "base64").subarray(0, 4).toString("latin1") === "%PDF");
  const labelPart = pdfs.length
    ? `<ul>${pdfs
        .map((l) => `<li><a download="Label-${esc(l.trackingNumber)}.pdf" href="data:application/pdf;base64,${esc(l.label)}">Download label (tracking ${esc(l.trackingNumber)})</a></li>`)
        .join("")}</ul>${labelForm}`
    : `<p>Packed, but Jumia didn't return the label yet${printed.ok ? "" : `: ${esc(printed.message)}`}. Try in a moment:</p>${labelForm}`;

  return html(`${head}${summary}${labelPart}${answer}${table}`);
}
