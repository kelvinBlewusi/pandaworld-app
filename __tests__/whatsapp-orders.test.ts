/**
 * Jumia orders on WhatsApp (lib/whatsapp/orders.ts, lib/jumia/order-flow.ts,
 * lib/whatsapp/order-alerts.ts), built 2026-10-06 from the flow agreed with
 * the owner: grouped alerts, Pack all & get labels as ONE PDF, Ready to ship
 * all, Pick orders, Cancel with a confirmation, gated by pack, every Jumia
 * country.
 */

import { PDFDocument } from "pdf-lib";
import { FakeDb } from "./helpers/fake-supabase";

let db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({ createServerClient: () => db }));
jest.mock("@/lib/jumia/oauth", () => ({ JUMIA_API_BASE: "https://vendor-api.jumia.com" }));

let shopCountry = "GH";
jest.mock("@/lib/jumia/api", () => ({
  getValidJumiaCredentials: async () => ({ accessToken: "tok_secret", shopId: "s", currency: "GHS", country: shopCountry }),
}));
jest.mock("@/lib/jumia/credentials", () => ({ getJumiaConnectionKind: async () => "connected" }));
jest.mock("@/lib/whatsapp/jumia-connect", () => ({ promptJumiaConnection: jest.fn() }));

let featureOn = true;
let blockedBy: "pack" | "credits" = "pack";
jest.mock("@/lib/billing/features", () => ({
  hasFeature: jest.fn(async () => featureOn),
  featureAccess: jest.fn(async () => (featureOn ? { ok: true } : { ok: false, blockedBy })),
  featureMinPackName: () => "Pro",
}));

type Sent = { kind: string; to: string; body?: string; buttons?: { id: string; title: string }[]; rows?: { id: string; title: string; description?: string }[]; bytes?: Uint8Array; filename?: string; caption?: string; template?: string; values?: string[]; payloads?: string[] };
const sent: Sent[] = [];
jest.mock("@/lib/whatsapp/client", () => ({
  LIST_MAX_ROWS: 10,
  sendTextIfConfigured: async (to: string, body: string) => { sent.push({ kind: "text", to, body }); },
  sendButtonsIfConfigured: async (to: string, body: string, buttons: { id: string; title: string }[]) => { sent.push({ kind: "buttons", to, body, buttons }); },
  sendListIfConfigured: async (to: string, body: string, _b: string, rows: Sent["rows"]) => { sent.push({ kind: "list", to, body, rows }); },
  sendCtaUrlIfConfigured: async (to: string, body: string) => { sent.push({ kind: "cta", to, body }); },
  sendDocumentIfConfigured: async (to: string, bytes: Uint8Array, filename: string, caption?: string) => { sent.push({ kind: "document", to, bytes, filename, caption }); },
  sendTemplateIfConfigured: async (to: string, template: string, _lang: string, values: string[], payloads: string[]) => { sent.push({ kind: "template", to, template, values, payloads }); },
}));

import {
  alertText, formatAmount, handleOrderMessage, parseOrderCommand, stationShortName, templateValues,
} from "@/lib/whatsapp/orders";
import { inQuietHours, runOrderAlerts } from "@/lib/whatsapp/order-alerts";
import type { JumiaOrderItem } from "@/lib/jumia/orders";
import type { WaitingOrder } from "@/lib/jumia/order-flow";
import { jumiaCountryByCode } from "@/lib/marketing/countries";

const PHONE = "233200000000";
const O1 = "11111111-0000-4000-8000-000000000001";
const O2 = "22222222-0000-4000-8000-000000000002";
const I1 = "aaaaaaaa-0000-4000-8000-000000000001";
const I2 = "aaaaaaaa-0000-4000-8000-000000000002";
const I3 = "aaaaaaaa-0000-4000-8000-000000000003";
const STATION = "cccccccc-0000-4000-8000-000000000001";
const STATION_2 = "cccccccc-0000-4000-8000-000000000002";

const item = (id: string, name: string, over: Partial<JumiaOrderItem> = {}): JumiaOrderItem => ({
  id, status: "PENDING", trackingNumber: null, shipmentType: "Dropshipping", isFulfilledByJumia: false,
  deliveryOption: "Pickup Station", paidPriceLocal: 100, country: { code: "GH", currencyCode: "GHS" },
  product: { name, sellerSku: name }, ...over,
});

let orders: { id: string; number: string; totalAmountLocal: { currency: string; value: number }; deliveryOption: string; createdAt: string }[] = [];
let items: Record<string, JumiaOrderItem[]> = {};
let providers: Record<string, { id: string; name: string; trackingCodeRequired?: boolean }[]> = {};
let packRefused = false;
let labelPdf = "";
const calls: { method: string; path: string; body?: unknown }[] = [];

async function tinyPdf(text: string): Promise<string> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]).drawText(text, { x: 10, y: 100, size: 12 });
  return Buffer.from(await doc.save()).toString("base64");
}

beforeAll(async () => { labelPdf = await tinyPdf("label"); });

beforeEach(() => {
  db = new FakeDb();
  sent.length = 0;
  calls.length = 0;
  featureOn = true;
  blockedBy = "pack";
  shopCountry = "GH";
  packRefused = false;
  orders = [
    { id: O1, number: "355926919", totalAmountLocal: { currency: "GHS", value: 238 }, deliveryOption: "Pickup Station", createdAt: "2026-10-06T12:23:22Z" },
    { id: O2, number: "401233871", totalAmountLocal: { currency: "GHS", value: 210 }, deliveryOption: "Pickup Station", createdAt: "2026-10-06T13:00:00Z" },
  ];
  items = {
    [O1]: [item(I1, "NASF2-90 Top Mounted Freezer - 65 Ltrs"), item(I2, "SC-8500W Multifunction Blender Robot")],
    [O2]: [item(I3, "Portable Cordless Chainsaw")],
  };
  providers = {
    [I1]: [{ id: STATION, name: "GH-VDO-OWN-East Legon-Station" }],
    [I2]: [{ id: STATION, name: "GH-VDO-OWN-East Legon-Station" }],
    [I3]: [{ id: STATION, name: "GH-VDO-OWN-East Legon-Station" }],
  };
  global.fetch = jest.fn(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body });
    let status = 200;
    let out: unknown = {};
    const all = () => Object.values(items).flat();
    if (url.pathname === "/orders") out = { orders, nextToken: null, isLastPage: true };
    else if (url.pathname === "/orders/items") {
      out = url.searchParams.getAll("orderId").map((id) => ({ orderId: id, orderNumber: orders.find((o) => o.id === id)?.number, items: items[id] ?? [] }));
    } else if (url.pathname === "/orders/shipment-providers") {
      out = { orderItems: url.searchParams.getAll("orderItemId").map((id) => ({ id, shipmentProviders: providers[id] ?? [] })) };
    } else if (url.pathname === "/v2/orders/pack") {
      // What Jumia answered live on 2026-10-06 for a station that takes no code.
      status = 400;
      out = { message: "Tracking Code should not be null." };
    } else if (url.pathname === "/orders/pack") {
      status = 201;
      const its = (body as { orderItems: { id: string; shipmentProviderId: string }[] }).orderItems;
      const n = calls.filter((c) => c.path === "/orders/pack").length;
      if (packRefused) out = { success: { packages: [], total: 0 }, error: { orderItems: its.map((i) => ({ id: i.id, response: { code: "not_allowed_status", message: "Order items are not pending" } })), total: its.length } };
      else {
        for (const { id } of its) { const it = all().find((i) => i.id === id); if (it) it.trackingNumber = `DS-GKC-${n}`; }
        out = { success: { packages: [{ orderItems: its.map((i) => i.id), countryCode: "GH", trackingNumber: `DS-GKC-${n}` }], total: its.length }, error: { orderItems: [], total: 0 } };
      }
    } else if (url.pathname === "/orders/print-labels") {
      status = 201;
      const ids = (body as { orderItemIds: string[] }).orderItemIds;
      const tracks = Array.from(new Set(ids.map((id) => all().find((i) => i.id === id)?.trackingNumber)));
      out = { success: { labels: tracks.map((t) => ({ orderItemIds: ids, countryCode: "GH", trackingNumber: t, label: labelPdf })), total: tracks.length }, error: { orderItems: [], total: 0 } };
    } else if (url.pathname === "/orders/ready-to-ship") {
      status = 201;
      for (const id of (body as { orderItemIds: string[] }).orderItemIds) { const it = all().find((i) => i.id === id); if (it) it.status = "READY_TO_SHIP"; }
      out = { success: { packages: [], total: 1 }, error: { orderItems: [], total: 0 } };
    } else if (url.pathname === "/orders/cancel") {
      for (const id of (body as { orderItemIds: string[] }).orderItemIds) { const it = all().find((i) => i.id === id); if (it) it.status = "CANCELED"; }
      out = { success: { orderItems: [], total: 1 }, error: { orderItems: [], total: 0 } };
    }
    return new Response(JSON.stringify(out), { status });
  }) as unknown as typeof fetch;
});

const say = (text: string) => handleOrderMessage("user_seller", PHONE, text);
const writes = () => calls.filter((c) => c.method !== "GET");
const last = (kind: string) => [...sent].reverse().find((s) => s.kind === kind)!;

describe("commands", () => {
  it("reads typed words and tapped ids, and nothing else", () => {
    expect(parseOrderCommand("orders")).toEqual({ kind: "list" });
    expect(parseOrderCommand(" My Orders ")).toEqual({ kind: "list" });
    expect(parseOrderCommand("jumia orders?")).toEqual({ kind: "list" });
    expect(parseOrderCommand("orders:packall")).toEqual({ kind: "pack_all" });
    expect(parseOrderCommand(`orders:packat:${STATION}`)).toEqual({ kind: "pack_all", stationId: STATION });
    expect(parseOrderCommand(`opackat:${O1}:${STATION}`)).toEqual({ kind: "pack", orderId: O1, stationId: STATION });
    expect(parseOrderCommand(`ocancelyes:${O1}`)).toEqual({ kind: "cancel", orderId: O1 });
    expect(parseOrderCommand("3 orders of rice")).toBeNull();
    expect(parseOrderCommand("done")).toBeNull();
    expect(parseOrderCommand(undefined)).toBeNull();
  });

  it("isn't an order command: intake handles it as before, with no lookups", async () => {
    expect(await say("hello")).toBe(false);
    expect(sent).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

describe("formatting, for every country", () => {
  const GH = jumiaCountryByCode("GH");
  const NG = jumiaCountryByCode("NG");
  const waiting = (id: string, number: string, its: JumiaOrderItem[], value = 238): WaitingOrder =>
    ({ id, number, createdAt: "", total: { currency: "GHS", value }, delivery: "Pickup Station", items: its });

  it("amounts in the shop's currency, whole units where the country uses them", () => {
    expect(formatAmount(238.5, "GHS", GH)).toBe("GHS 238.5");
    expect(formatAmount(12500.4, "NGN", NG)).toBe("NGN 12,500");
    expect(formatAmount(15000, "XOF", jumiaCountryByCode("CI"))).toBe("XOF 15,000");
  });

  it("one order in full, the same product twice as 2 ×", () => {
    const text = alertText([waiting(O1, "355926919", [item(I1, "Pedestal Fan"), item(I2, "Pedestal Fan"), item(I3, "LGNT Tablet")])], GH);
    expect(text).toContain("🛒 New Jumia order #355926919");
    expect(text).toContain("3 items · GHS 238 · Pickup Station");
    expect(text).toContain("• 2 × Pedestal Fan · GHS 100 each");
    expect(text).toContain("• LGNT Tablet · GHS 100");
  });

  it("several orders one line each, cut to WhatsApp's 1,024 characters with +N more", () => {
    const many = Array.from({ length: 60 }, (_, n) => waiting(`${n}`.padStart(36, "0"), `3559269${n}`, [item(I1, "x")], 10));
    const text = alertText(many, GH);
    expect(text).toContain("🛒 60 new Jumia orders · GHS 600");
    expect(text.length).toBeLessThanOrEqual(1024);
    expect(text).toMatch(/\+\d+ more$/);
  });

  it("template values hold no new line, at most 3 products named", () => {
    const values = templateValues([
      waiting(O1, "355926919", [item(I1, "NASF2-90 Top Mounted Freezer - 65 Ltrs, Manual Defrost"), item(I2, "Blender")]),
      waiting(O2, "401233871", [item(I3, "Chainsaw"), item(I1, "Kettle")], 210),
    ], GH);
    expect(values).toEqual([
      "355926919 and 1 more",
      "NASF2-90 Top Mounted Freezer…, Blender, Chainsaw (+1 more)",
      "GHS 448",
      "Pickup Station",
    ]);
    expect(values.every((v) => !v.includes("\n"))).toBe(true);
  });

  it("station codes from any country read as a short name", () => {
    expect(stationShortName("GH-VDO-OWN-East Legon-Station")).toBe("East Legon VDO");
    expect(stationShortName("KE-VDO-3PL-Karen-Station")).toBe("Karen VDO");
    expect(stationShortName("GH-VDO-OWN-Adum-Kumasi")).toBe("Adum Kumasi VDO");
    expect(stationShortName("Odd name")).toBe("Odd name");
  });
});

describe("gated by pack", () => {
  it("a seller without the pack is told which pack has it, and nothing is read or changed", async () => {
    featureOn = false;
    expect(await say("orders")).toBe(true);
    expect(await say(`opack:${O1}`)).toBe(true);
    expect(sent.map((s) => s.kind)).toEqual(["cta", "cta"]);
    expect(sent[0].body).toContain("come with the Pro pack");
    expect(calls).toHaveLength(0);
  });

  it("a seller with the pack but out of credits is told to buy credits, not to upgrade", async () => {
    featureOn = false;
    blockedBy = "credits";
    await say("orders");
    expect(sent[0].body).toContain("out of credits");
    expect(sent[0].body).not.toContain("Pro pack");
    expect(calls).toHaveLength(0);
  });
});

describe("the flow", () => {
  it("'orders' shows what's waiting, with Pack all and Pick orders", async () => {
    await say("orders");
    const msg = last("buttons");
    expect(msg.body).toContain("To pack (2)");
    expect(msg.body).toContain("#355926919 · 2 items · GHS 238");
    expect(msg.buttons!.map((b) => b.id)).toEqual(["orders:packall", "orders:pick"]);
    expect(writes()).toHaveLength(0);
  });

  it("Pack all: one package per order, Jumia giving the tracking number, one PDF of every label, then Ready to ship all", async () => {
    await say("orders:packall");
    // The older pack call, one per order: v2 wants a tracking code the
    // station doesn't take (live, 2026-10-06), and is never called.
    expect(writes().filter((c) => c.path === "/orders/pack").map((c) => c.body)).toEqual([
      { orderItems: [{ id: I1, shipmentProviderId: STATION }, { id: I2, shipmentProviderId: STATION }] },
      { orderItems: [{ id: I3, shipmentProviderId: STATION }] },
    ]);
    expect(calls.some((c) => c.path === "/v2/orders/pack")).toBe(false);
    expect(writes().filter((c) => c.path === "/orders/print-labels")).toHaveLength(1);

    const doc = last("document");
    expect(doc.filename).toMatch(/^Jumia-labels-2-orders-\d{4}-\d{2}-\d{2}\.pdf$/);
    expect(doc.caption).toBe("Shipping labels for #355926919, #401233871");
    expect((await PDFDocument.load(doc.bytes!)).getPageCount()).toBe(2);

    const summary = last("buttons");
    expect(summary.body).toContain("✅ Packed 2 orders for East Legon VDO:");
    expect(summary.body).toContain("#355926919 · DS-GKC-1");
    expect(summary.body).toContain("#401233871 · DS-GKC-2");
    expect(summary.buttons!.map((b) => b.id)).toEqual(["orders:rtsall", "orders:pick"]);
    expect(calls.some((c) => /ready-to-ship|cancel/.test(c.path))).toBe(false);
  });

  it("asks where to drop off when Jumia offers more than one station, packing nothing until then", async () => {
    providers[I3] = [{ id: STATION, name: "GH-VDO-OWN-East Legon-Station" }, { id: STATION_2, name: "GH-VDO-OWN-Agility-Station" }];
    await say(`opack:${O2}`);
    const list = last("list");
    expect(list.rows!.map((r) => r.id)).toEqual([`opackat:${O2}:${STATION}`, `opackat:${O2}:${STATION_2}`]);
    expect(list.rows!.map((r) => r.title)).toEqual(["East Legon VDO", "Agility VDO"]);
    expect(writes()).toHaveLength(0);

    await say(`opackat:${O2}:${STATION_2}`);
    expect(writes().find((c) => c.path === "/orders/pack")!.body).toEqual({ orderItems: [{ id: I3, shipmentProviderId: STATION_2 }] });
    expect(last("document").filename).toBe("Jumia-label-401233871.pdf");
  });

  it("a refused order is reported, and never blocks the others' result", async () => {
    packRefused = true;
    await say("orders:packall");
    expect(sent.some((s) => s.kind === "document")).toBe(false);
    const msg = last("buttons");
    expect(msg.body).toContain("Not packed:");
    expect(msg.body).toContain("⚠️ #355926919: Order items are not pending");
  });

  it("Ready to ship all marks every packed order in one call", async () => {
    for (const it of Object.values(items).flat()) it.trackingNumber = "DS-GKC-1";
    await say("orders:rtsall");
    expect(writes()).toEqual([{ method: "POST", path: "/orders/ready-to-ship", body: { orderItemIds: [I1, I2, I3] } }]);
    expect(last("text").body).toContain("✅ 2 orders ready to ship: #355926919, #401233871");
  });

  it("Cancel asks first; only the confirmation cancels", async () => {
    await say(`ocancel:${O1}`);
    const ask = last("buttons");
    expect(ask.body).toContain("Cancel order #355926919?");
    expect(ask.body).toContain("default cancellation reason");
    expect(ask.buttons!.map((b) => b.id)).toEqual([`ocancelyes:${O1}`, `order:${O1}`]);
    expect(writes()).toHaveLength(0);

    await say(`ocancelyes:${O1}`);
    expect(writes()).toEqual([{ method: "PUT", path: "/orders/cancel", body: { orderItemIds: [I1, I2] } }]);
    expect(last("text").body).toBe("Order #355926919 is cancelled.");
  });

  it("an order no longer waiting is said so, and nothing changes", async () => {
    items[O1] = items[O1].map((i) => ({ ...i, status: "SHIPPED" }));
    await say(`opack:${O1}`);
    expect(last("text").body).toContain("isn't waiting any more");
    expect(writes()).toHaveLength(0);
  });

  it("never shows the Jumia token", async () => {
    await say("orders:packall");
    expect(JSON.stringify(sent)).not.toContain("tok_secret");
  });
});

describe("alerts", () => {
  const at = (iso: string) => new Date(iso);
  const seed = (over: { inboundAt?: string | null; template?: boolean; lastAlertAt?: string } = {}) => {
    db.tables.whatsapp_connections = [{ user_id: "user_seller", phone_number: PHONE }];
    db.tables.jumia_connections = [{ user_id: "user_seller", status: "active" }];
    db.tables.whatsapp_message_log = over.inboundAt === null ? [] : [{ phone_number: PHONE, direction: "inbound", created_at: over.inboundAt ?? "2026-10-06T15:00:00Z" }];
    db.tables.app_settings = over.template ? [{ key: "order_alert_template", value: { name: "jumia_new_order", language: "en" } }] : [];
    db.tables.order_alerts = over.lastAlertAt ? [{ user_id: "user_seller", order_id: "older", alerted_at: over.lastAlertAt }] : [];
  };

  it("quiet from 10pm to 7am in the seller's own timezone", () => {
    expect(inQuietHours(at("2026-10-06T22:30:00Z"), "Africa/Accra")).toBe(true);
    expect(inQuietHours(at("2026-10-07T06:59:00Z"), "Africa/Accra")).toBe(true);
    expect(inQuietHours(at("2026-10-07T07:00:00Z"), "Africa/Accra")).toBe(false);
    expect(inQuietHours(at("2026-10-06T19:30:00Z"), "Africa/Nairobi")).toBe(true); // 22:30 in Nairobi
    expect(inQuietHours(at("2026-10-06T19:30:00Z"), "Africa/Accra")).toBe(false);
  });

  it("inside the 24 hours: our own grouped message, each order alerted once", async () => {
    seed();
    const run = await runOrderAlerts(at("2026-10-06T16:05:00Z"));
    expect(run.alerted).toBe(2);
    expect(last("buttons").body).toContain("🛒 2 new Jumia orders · GHS 448");
    expect(db.tables.order_alerts.map((r) => r.order_id).sort()).toEqual([O1, O2].sort());

    sent.length = 0;
    await runOrderAlerts(at("2026-10-06T17:05:00Z"));
    expect(sent).toHaveLength(0);
  });

  it("at most one alert per 30 minutes", async () => {
    seed({ lastAlertAt: "2026-10-06T15:50:00Z" });
    await runOrderAlerts(at("2026-10-06T16:05:00Z"));
    expect(sent).toHaveLength(0);
    await runOrderAlerts(at("2026-10-06T16:25:00Z"));
    expect(sent).toHaveLength(1);
  });

  it("held overnight, sent together after 7am", async () => {
    seed({ inboundAt: "2026-10-06T21:00:00Z" });
    await runOrderAlerts(at("2026-10-06T23:15:00Z"));
    expect(sent).toHaveLength(0);
    await runOrderAlerts(at("2026-10-07T07:05:00Z"));
    expect(last("buttons").body).toContain("2 new Jumia orders");
  });

  it("outside the 24 hours: the template, its button carrying the command", async () => {
    seed({ inboundAt: "2026-10-04T10:00:00Z", template: true });
    await runOrderAlerts(at("2026-10-06T16:05:00Z"));
    const t = last("template");
    expect(t.template).toBe("jumia_new_order");
    expect(t.values![0]).toBe("355926919 and 1 more");
    expect(t.payloads).toEqual(["orders:packall"]);
  });

  it("outside the 24 hours with no template: held, not marked, so it goes out once the seller writes", async () => {
    seed({ inboundAt: null });
    const run = await runOrderAlerts(at("2026-10-06T16:05:00Z"));
    expect(run.held).toBe(1);
    expect(sent).toHaveLength(0);
    expect(db.tables.order_alerts).toHaveLength(0);
  });

  it("only sellers with the pack", async () => {
    seed();
    featureOn = false;
    await runOrderAlerts(at("2026-10-06T16:05:00Z"));
    expect(sent).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("works the same for a shop in another country, by its own clock", async () => {
    seed();
    shopCountry = "KE";
    await runOrderAlerts(at("2026-10-06T19:30:00Z")); // 22:30 in Nairobi
    expect(sent).toHaveLength(0);
    await runOrderAlerts(at("2026-10-06T04:05:00Z")); // 07:05 in Nairobi
    expect(sent).toHaveLength(1);
  });
});
