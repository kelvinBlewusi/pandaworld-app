/**
 * POST /admin/orders/label (form field orderId): fetches the shipping label of
 * one of the signed-in admin's OWN shop's orders and shows the PDF. Read-only:
 * it reads the order's items and asks Jumia to print the label of the ones
 * already packed. It never packs, ships or changes an order (lib/jumia/orders.ts).
 *
 * A route handler isn't wrapped by app/admin/layout.tsx, so it checks admin
 * itself. Only ever the caller's own Jumia connection: orders carry other
 * people's names and addresses.
 */

import { auth } from "@clerk/nextjs/server";
import { isAdmin } from "@/lib/auth/is-admin";
import { getValidJumiaCredentials } from "@/lib/jumia/api";
import { getOrderItems, labelableItems, printLabels, type JumiaOrderItem } from "@/lib/jumia/orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function html(body: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>Shipping label</title><body style="font:14px/1.5 system-ui,sans-serif;max-width:720px;margin:32px auto;padding:0 16px">` +
      `${body}<p style="margin-top:24px"><a href="/admin/orders">← Back to orders</a></p>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

function itemsTable(items: JumiaOrderItem[]): string {
  const rows = items
    .map((i) =>
      `<tr><td>${esc(i.product?.name ?? i.id)}</td><td>${esc(i.status)}</td>` +
      `<td>${esc(i.trackingNumber ?? "not packed")}</td><td>${i.isFulfilledByJumia ? "Fulfilled by Jumia" : esc(i.shipmentType ?? "")}</td></tr>`,
    )
    .join("");
  return (
    `<table border="1" cellpadding="6" style="border-collapse:collapse;margin:12px 0;font-size:13px">` +
    `<tr><th>Item</th><th>Status</th><th>Tracking</th><th>Shipped by</th></tr>${rows}</table>`
  );
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId || !isAdmin(userId)) return new Response("Not found", { status: 404 });

  const form = await req.formData().catch(() => null);
  const orderId = String(form?.get("orderId") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) return html("<p>That isn't an order.</p>", 400);

  let creds: Awaited<ReturnType<typeof getValidJumiaCredentials>>;
  try {
    creds = await getValidJumiaCredentials(userId);
  } catch (e) {
    return html(`<p>Jumia isn't connected for your account (${esc((e as Error).message)}).</p>`, 400);
  }

  const order = await getOrderItems(creds.accessToken, orderId);
  if (!order.ok) return html(`<p><b>Couldn't read the order.</b> ${esc(order.message)}</p>`, 502);
  const { items, orderNumber } = order.data;

  const labelable = labelableItems(items);
  if (labelable.length === 0) {
    return html(
      `<h2>Order ${esc(orderNumber)}</h2>${itemsTable(items)}` +
        `<p>No item on this order is packed yet (or it's Fulfilled by Jumia), so Jumia has no label for it. ` +
        `Pack it in Vendor Center and it will work here.</p>`,
    );
  }

  const printed = await printLabels(creds.accessToken, labelable.map((i) => i.id));
  if (!printed.ok) {
    return html(`<h2>Order ${esc(orderNumber)}</h2>${itemsTable(items)}<p><b>Jumia wouldn't print the label.</b> ${esc(printed.message)}</p>`, 502);
  }

  const labels = printed.data.success?.labels ?? [];
  const refused = printed.data.error?.orderItems ?? [];
  if (labels.length === 0) {
    const why = refused.map((r) => `<li>${esc(r.id)}: ${esc(r.response?.code)}, ${esc(r.response?.message)}</li>`).join("");
    return html(`<h2>Order ${esc(orderNumber)}</h2>${itemsTable(items)}<p><b>No label came back.</b></p><ul>${why}</ul>`, 422);
  }

  // The label is a base64 PDF (the spec says so); check before trusting it,
  // since this page exists to learn what Jumia really sends.
  const pdfs = labels.map((l) => ({ l, bytes: Buffer.from(String(l.label ?? ""), "base64") }));
  const notPdf = pdfs.find((p) => p.bytes.subarray(0, 4).toString("latin1") !== "%PDF");
  if (notPdf) {
    return html(
      `<p><b>Jumia returned a label that isn't a PDF.</b> It starts with <code>${esc(String(notPdf.l.label).slice(0, 80))}</code>. ` +
        `Tell Claude what you see here.</p>`,
      502,
    );
  }

  const fileName = `Label-${String(orderNumber).replace(/[^\w-]/g, "")}.pdf`;
  if (pdfs.length === 1) {
    return new Response(new Uint8Array(pdfs[0].bytes), {
      status: 200,
      headers: {
        "Content-Type":        "application/pdf",
        "Content-Disposition": `inline; filename="${fileName}"`,
        "Cache-Control":       "no-store",
      },
    });
  }
  // Several packages: a link to each.
  const links = pdfs
    .map((p, i) => `<li><a download="Label-${esc(p.l.trackingNumber)}.pdf" href="data:application/pdf;base64,${esc(p.l.label)}">Package ${i + 1}: ${esc(p.l.trackingNumber)}</a></li>`)
    .join("");
  return html(`<h2>Order ${esc(orderNumber)}: ${pdfs.length} labels</h2><ul>${links}</ul>`);
}
