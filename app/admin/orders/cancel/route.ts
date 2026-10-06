/**
 * "Cancel order" from /admin/orders, for an order the owner has switched on:
 * the test bench for a WhatsApp cancel button.
 *
 *   GET  /admin/orders/cancel?orderId=…  a page that changes NOTHING: the items
 *        that would be cancelled, and what cancelling through the API means.
 *   POST /admin/orders/cancel            cancels them (PUT /orders/cancel).
 *
 * Cancelling a customer's order is the hardest change to take back, so on top
 * of the packing guards (lib/jumia/order-admin.ts: admin, same site, an order
 * switched on, the items exactly the ones the page showed) the owner types the
 * order number as well as ticking the confirmation. The order is read back
 * afterwards and the page shows each item as Jumia now has it.
 *
 * Jumia's cancel request has no field for a reason, so Jumia records its
 * default cancellation reason; to give one (out of stock…), cancel in Vendor
 * Center. A route handler isn't wrapped by app/admin/layout.tsx, so it checks
 * admin itself.
 */

import { auth } from "@clerk/nextjs/server";
import { isAdmin } from "@/lib/auth/is-admin";
import { cancelItems, getOrderItems, type JumiaOrderItem } from "@/lib/jumia/orders";
import { ORDER_ID_RE, itemStatus, loadAllowedOrder, sameOrigin } from "@/lib/jumia/order-admin";
import { esc, htmlPage as html, itemsTable } from "@/lib/jumia/order-pages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Jumia cancels items that are pending or ready to ship. Fulfilled by Jumia items aren't the seller's to cancel. */
const cancellable = (i: JumiaOrderItem) =>
  (itemStatus(i) === "PENDING" || itemStatus(i) === "READY_TO_SHIP") && !i.isFulfilledByJumia;

const isCanceled = (i: JumiaOrderItem) => itemStatus(i) === "CANCELED" || itemStatus(i) === "CANCELLED";

export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId || !isAdmin(userId)) return new Response("Not found", { status: 404 });

  const orderId = new URL(req.url).searchParams.get("orderId") ?? "";
  if (!ORDER_ID_RE.test(orderId)) return html("<p>That isn't an order.</p>", 400);

  const loaded = await loadAllowedOrder(userId, orderId);
  if ("error" in loaded) return loaded.error;
  const { orderNumber, items } = loaded;

  const todo = items.filter(cancellable);
  if (todo.length === 0) {
    return html(`<h2>Order #${esc(orderNumber)}</h2><p>Nothing to cancel: no item is pending or ready to ship.</p>${itemsTable(items)}`);
  }

  return html(
    `<h2>Cancel order #${esc(orderNumber)}</h2>` +
      `<p style="color:#b91c1c"><b>This cancels the customer's order and can't be undone.</b></p>` +
      `<ul>` +
      `<li>Jumia's API has no field for a reason, so Jumia records its <b>default cancellation reason</b>. ` +
      `To give one (out of stock, wrong price…), cancel in Vendor Center instead.</li>` +
      `<li>Cancellations by the seller can count against your shop's cancellation rate on Jumia.</li>` +
      `</ul>` +
      itemsTable(todo) +
      `<form method="post" action="/admin/orders/cancel"><input type="hidden" name="orderId" value="${esc(orderId)}">` +
      todo.map((i) => `<input type="hidden" name="item" value="${esc(i.id)}">`).join("") +
      `<p><label>Type the order number to confirm <input name="confirmNumber" autocomplete="off" inputmode="numeric"></label></p>` +
      `<p><label><input type="checkbox" name="confirm" value="yes"> I understand this cancels the customer's order and can't be undone.</label></p>` +
      `<button type="submit" style="color:#b91c1c">Cancel order</button></form>`,
  );
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId || !isAdmin(userId)) return new Response("Not found", { status: 404 });
  if (!sameOrigin(req)) return new Response("Forbidden", { status: 403 });

  const form = await req.formData().catch(() => null);
  const orderId = String(form?.get("orderId") ?? "");
  if (!ORDER_ID_RE.test(orderId)) return html("<p>That isn't an order.</p>", 400);
  if (form?.get("confirm") !== "yes") return html("<p>Nothing was cancelled: the confirmation box wasn't ticked.</p>", 400);
  const shown = Array.from(new Set((form?.getAll("item") ?? []).map(String)));
  if (shown.length === 0) return html("<p>Nothing was cancelled: no item was sent.</p>", 400);

  const loaded = await loadAllowedOrder(userId, orderId);
  if ("error" in loaded) return loaded.error;
  const { creds, orderNumber, items } = loaded;
  const head = `<h2>Order #${esc(orderNumber)}</h2>`;

  const typed = String(form?.get("confirmNumber") ?? "").trim().replace(/^#/, "");
  if (typed !== orderNumber) {
    return html(`${head}<p>Nothing was cancelled: the order number typed doesn't match #${esc(orderNumber)}.</p>`, 400);
  }

  // The items to cancel must be exactly the ones the page showed.
  const todo = items.filter(cancellable);
  if (todo.length !== shown.length || !shown.every((id) => todo.some((i) => i.id === id))) {
    return html(`${head}<p>Nothing was cancelled: the order changed since the page was opened. Go back and open it again.</p>`, 409);
  }
  const ids = todo.map((i) => i.id);

  const r = await cancelItems(creds.accessToken, ids);
  const refusals = r.ok ? (r.data.error?.orderItems ?? []).map((e) => `${e.response?.code ?? ""}: ${e.response?.message ?? ""}`) : [];
  console.info(
    `[orders] cancel order #${orderNumber}, ${ids.length} item(s): ` +
      (r.ok ? `${r.data.success?.orderItems?.length ?? 0} cancelled, ${refusals.length} refused` : `refused (${r.message.slice(0, 160)})`),
  );
  const reasons = r.ok
    ? Array.from(new Set((r.data.success?.orderItems ?? []).map((i) => i.cancellationReason?.description).filter(Boolean)))
    : [];
  const answer = r.ok
    ? `<details><summary>What Jumia answered</summary><ul>` +
      `<li>${r.data.success?.orderItems?.length ?? 0} item(s) cancelled${reasons.length ? `, reason recorded: ${esc(reasons.join(", "))}` : ""}</li>` +
      refusals.map((e) => `<li>Refused: ${esc(e)}</li>`).join("") +
      `</ul></details>`
    : `<p><b>Jumia didn't cancel it:</b> ${esc(r.message)}</p>`;

  // What Jumia now has is the truth, whatever the answer said.
  const after = await getOrderItems(creds.accessToken, orderId);
  if (!after.ok) {
    return html(`${head}${answer}<p><b>Couldn't read the order back</b> (${esc(after.message)}). Check it in Vendor Center.</p>`, 502);
  }
  const canceled = after.data.items.filter((i) => ids.includes(i.id) && isCanceled(i));
  const table = `<p>The order as Jumia has it now:</p>${itemsTable(after.data.items)}`;

  if (canceled.length === 0) {
    const note = r.ok && refusals.length === 0
      ? "Jumia said it was done, but no item reads CANCELED yet. Check the order in Vendor Center."
      : "Nothing on this order was cancelled.";
    return html(`${head}${answer}<p>${note}</p>${table}`, r.ok ? 422 : 502);
  }
  const partial = canceled.length < ids.length ? ` <b>Only ${canceled.length} of ${ids.length} items were cancelled.</b>` : "";
  return html(`${head}<p>Cancelled ${canceled.length} item(s).${partial}</p>${answer}${table}`);
}
