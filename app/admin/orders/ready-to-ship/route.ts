/**
 * "Ready to ship" from /admin/orders, for an order the owner has switched on:
 * the test bench for the WhatsApp button of the same name.
 *
 *   GET  /admin/orders/ready-to-ship?orderId=…  a page that changes NOTHING: the
 *        packed items Jumia would mark, with their tracking numbers.
 *   POST /admin/orders/ready-to-ship            marks them (POST /orders/ready-to-ship).
 *
 * Guards as for packing (lib/jumia/order-admin.ts): admin, same site, an order
 * switched on, the confirmation ticked, and the items to mark exactly the ones
 * the page showed, still pending and packed. The order is read back afterwards
 * and the page shows each item as Jumia now has it.
 * A route handler isn't wrapped by app/admin/layout.tsx, so it checks admin itself.
 */

import { auth } from "@clerk/nextjs/server";
import { isAdmin } from "@/lib/auth/is-admin";
import { getOrderItems, markReadyToShip, type JumiaOrderItem } from "@/lib/jumia/orders";
import { ORDER_ID_RE, itemStatus, loadAllowedOrder, sameOrigin } from "@/lib/jumia/order-admin";
import { esc, htmlPage as html, itemsTable } from "@/lib/jumia/order-pages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Can be marked: pending, packed (it has a tracking number), shipped by the seller. */
const markable = (i: JumiaOrderItem) => itemStatus(i) === "PENDING" && !!i.trackingNumber && !i.isFulfilledByJumia;

export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId || !isAdmin(userId)) return new Response("Not found", { status: 404 });

  const orderId = new URL(req.url).searchParams.get("orderId") ?? "";
  if (!ORDER_ID_RE.test(orderId)) return html("<p>That isn't an order.</p>", 400);

  const loaded = await loadAllowedOrder(userId, orderId);
  if ("error" in loaded) return loaded.error;
  const { orderNumber, items } = loaded;
  const head = `<h2>Order #${esc(orderNumber)}</h2>`;

  const todo = items.filter(markable);
  if (todo.length === 0) {
    const why = items.some((i) => itemStatus(i) === "PENDING" && !i.trackingNumber)
      ? "Nothing to mark yet: pack the order first (Pack &amp; get label)."
      : "Nothing to mark: no item is pending and packed. It may already be ready to ship.";
    return html(`${head}<p>${why}</p>${itemsTable(items)}`);
  }

  return html(
    `<h2>Mark order #${esc(orderNumber)} ready to ship</h2>` +
      `<p>Tells Jumia the package is ready to hand over to the courier. It <b>can't be undone from here</b>.</p>` +
      itemsTable(todo) +
      `<form method="post" action="/admin/orders/ready-to-ship"><input type="hidden" name="orderId" value="${esc(orderId)}">` +
      todo.map((i) => `<input type="hidden" name="item" value="${esc(i.id)}">`).join("") +
      `<p><label><input type="checkbox" name="confirm" value="yes"> I understand this tells Jumia the order is ready to hand over, and can't be undone.</label></p>` +
      `<button type="submit">Mark ready to ship</button></form>`,
  );
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId || !isAdmin(userId)) return new Response("Not found", { status: 404 });
  if (!sameOrigin(req)) return new Response("Forbidden", { status: 403 });

  const form = await req.formData().catch(() => null);
  const orderId = String(form?.get("orderId") ?? "");
  if (!ORDER_ID_RE.test(orderId)) return html("<p>That isn't an order.</p>", 400);
  if (form?.get("confirm") !== "yes") return html("<p>Nothing was changed: the confirmation box wasn't ticked.</p>", 400);
  const shown = Array.from(new Set((form?.getAll("item") ?? []).map(String)));
  if (shown.length === 0) return html("<p>Nothing was changed: no item was sent.</p>", 400);

  const loaded = await loadAllowedOrder(userId, orderId);
  if ("error" in loaded) return loaded.error;
  const { creds, orderNumber, items } = loaded;
  const head = `<h2>Order #${esc(orderNumber)}</h2>`;

  // The items to mark must be exactly the ones the page showed.
  const todo = items.filter(markable);
  if (todo.length !== shown.length || !shown.every((id) => todo.some((i) => i.id === id))) {
    return html(`${head}<p>Nothing was changed: the order changed since the page was opened. Go back and open it again.</p>`, 409);
  }
  const ids = todo.map((i) => i.id);

  const r = await markReadyToShip(creds.accessToken, ids);
  const refusals = r.ok ? (r.data.error?.orderItems ?? []).map((e) => `${e.response?.code ?? ""}: ${e.response?.message ?? ""}`) : [];
  console.info(
    `[orders] ready to ship order #${orderNumber}, ${ids.length} item(s): ` +
      (r.ok ? `${r.data.success?.total ?? r.data.success?.packages?.length ?? 0} done, ${refusals.length} refused` : `refused (${r.message.slice(0, 160)})`),
  );
  const answer = r.ok
    ? `<details><summary>What Jumia answered</summary><ul>` +
      (r.data.success?.packages ?? []).map((p) => `<li>Package ${esc(p.trackingNumber)}: ${(p.orderItems ?? []).length} item(s) ready to ship</li>`).join("") +
      refusals.map((e) => `<li>Refused: ${esc(e)}</li>`).join("") +
      `</ul></details>`
    : `<p><b>Jumia didn't mark it ready to ship:</b> ${esc(r.message)}</p>`;

  // What Jumia now has is the truth, whatever the answer said.
  const after = await getOrderItems(creds.accessToken, orderId);
  if (!after.ok) {
    return html(`${head}${answer}<p><b>Couldn't read the order back</b> (${esc(after.message)}). Check it in Vendor Center.</p>`, 502);
  }
  const ours = after.data.items.filter((i) => ids.includes(i.id));
  const moved = ours.filter((i) => itemStatus(i) !== "PENDING");
  const table = `<p>The order as Jumia has it now:</p>${itemsTable(after.data.items)}`;

  if (moved.length === 0) {
    const note = r.ok && refusals.length === 0
      ? "Jumia said it was done, but the items still read PENDING. Check the order in Vendor Center."
      : "Nothing on this order changed.";
    return html(`${head}${answer}<p>${note}</p>${table}`, r.ok ? 422 : 502);
  }
  const statuses = Array.from(new Set(moved.map((i) => i.status))).join(", ");
  const partial = moved.length < ids.length ? ` <b>Only ${moved.length} of ${ids.length} items changed.</b>` : "";
  return html(`${head}<p>✅ ${moved.length} item(s) now ${esc(statuses)}.${partial}</p>${answer}${table}`);
}
