/** Small HTML pages for the admin's order routes (app/admin/orders/*): what Jumia sends is escaped, never trusted. */

export const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function htmlPage(body: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>Orders</title><body style="font:14px/1.5 system-ui,sans-serif;max-width:720px;margin:32px auto;padding:0 16px">` +
      `${body}<p style="margin-top:24px"><a href="/admin/orders">← Back to orders</a></p>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

/** Fields whose values are shown in describeShape; everything else shows only its type. */
const SAFE_VALUES = new Set(["id", "orderId", "orderNumber", "number", "status", "trackingNumber", "shipmentType", "isFulfilledByJumia", "deliveryOption", "sellerSku"]);

/**
 * What a Jumia reply looks like, without the customer's details: its field
 * names and types, with the value only for a few harmless fields. Shown to the
 * owner on the pack page so a reply that differs from the spec can be seen
 * and fixed (the order number was missing on 2026-10-06). Names and addresses
 * are objects here and print as their field names only.
 */
export function describeShape(raw: unknown): string {
  const show = (prefix: string, k: string, v: unknown): string => {
    if (Array.isArray(v)) return `${prefix}${k}: list of ${v.length}`;
    if (v && typeof v === "object") return `${prefix}${k}: object with ${Object.keys(v).join(", ") || "nothing"}`;
    return `${prefix}${k}: ${SAFE_VALUES.has(k) ? JSON.stringify(v) : v === null ? "null" : typeof v}`;
  };
  // A reply that is a list (the real items reply is) is described by its first entry.
  const lines: string[] = [];
  let top: unknown = raw;
  let prefix = "";
  if (Array.isArray(raw)) {
    lines.push(`reply: list of ${raw.length}`);
    top = raw[0];
    prefix = "[0].";
  }
  const obj = (top && typeof top === "object" ? top : {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) lines.push(show(prefix, k, v));
  const first = Array.isArray(obj.items) ? obj.items[0] : undefined;
  if (first && typeof first === "object") {
    for (const [k, v] of Object.entries(first as Record<string, unknown>)) lines.push(show(`${prefix}items[0].`, k, v));
  }
  return lines.join("\n");
}
