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
