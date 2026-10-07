import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/auth/is-admin";
import { getValidJumiaCredentials } from "@/lib/jumia/api";
import { getOrderItems } from "@/lib/jumia/orders";
import { labelsPdf, statusOf } from "@/lib/jumia/order-flow";
import { sendButtonsWithDocumentIfConfigured } from "@/lib/whatsapp/client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ─── POST /api/worker/label-test ─────────────────────────────────────────────
//
// The owner's way to try shipping labels on one of their own orders without
// the bot's order list (owner, 2026-10-07: "test the label on my shop - note
// i cancelled the order"; a cancelled order isn't in "orders"). app_settings
// `label_test` holds { userId, orderId }: an admin's own order. It's emptied
// first, then the label is asked for with the bot's own call (labelsPdf) and,
// when Jumia sends one, the PDF goes to that admin's linked WhatsApp. Answers
// with what Jumia said, for the pg_net response log.
//
// Read-only on the order: print-labels changes nothing (lib/jumia/orders.ts);
// it never packs, ships or cancels. No credits are charged.
//
// Security: the same Bearer CRON_SECRET contract as the other workers, and
// only an admin's own Jumia connection (labels carry a customer's address).

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return new NextResponse("Server not configured", { status: 500 });
  if (req.headers.get("authorization") !== `Bearer ${cronSecret}`) return new NextResponse("Unauthorized", { status: 401 });

  const db = createServerClient();
  const { data } = await db.from("app_settings").select("value").eq("key", "label_test").maybeSingle();
  const ask = (data?.value ?? null) as { userId?: unknown; orderId?: unknown } | null;
  const userId = typeof ask?.userId === "string" ? ask.userId : "";
  const orderId = typeof ask?.orderId === "string" ? ask.orderId : "";
  if (!userId || !orderId) return NextResponse.json({ ok: false, error: "nothing asked" });
  await db.from("app_settings").update({ value: null }).eq("key", "label_test");
  if (!isAdmin(userId)) return NextResponse.json({ ok: false, error: "admins' own orders only" }, { status: 403 });
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) return NextResponse.json({ ok: false, error: "not an order id" }, { status: 400 });

  try {
    const creds = await getValidJumiaCredentials(userId);
    const order = await getOrderItems(creds.accessToken, orderId);
    if (!order.ok) return NextResponse.json({ ok: false, step: "read order", error: order.message });
    const items = order.data.items.map((i) => ({ status: statusOf(i), tracking: i.trackingNumber ?? null, fbj: !!i.isFulfilledByJumia }));
    const r = await labelsPdf(creds.accessToken, order.data.items);
    if (!r.ok) return NextResponse.json({ ok: false, step: "label", orderNumber: order.data.orderNumber, items, reason: r.reason });

    const { data: wa } = await db.from("whatsapp_connections").select("phone_number").eq("user_id", userId).limit(1);
    const to = ((wa ?? []) as { phone_number: string | null }[])[0]?.phone_number?.replace(/^\+/, "");
    let sent = false;
    let sendError: string | null = null;
    if (to) {
      try {
        await sendButtonsWithDocumentIfConfigured(
          to, r.pdf, `Jumia-label-${order.data.orderNumber}.pdf`,
          `🏷️ Test label for #${order.data.orderNumber} (${items[0]?.status.toLowerCase().replace(/_/g, " ") ?? "order"}). Nothing on the order was changed and no credits were used.`,
          [{ id: "menu", title: "Menu" }],
        );
        sent = true;
      } catch (e) {
        sendError = (e as Error).message;
      }
    }
    return NextResponse.json({ ok: true, orderNumber: order.data.orderNumber, items, labels: r.labels, pdfBytes: r.pdf.length, sent, sendError });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
