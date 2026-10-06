/**
 * Ready to ship and Cancel from /admin/orders (2026-10-06). Both change a real
 * customer's order with no undo in Jumia's API, so most of these tests are
 * about what must NOT reach Jumia: not an admin, another site, an order the
 * owner hasn't switched on, no confirmation (and for Cancel, the wrong order
 * number typed), an order that changed since the page was opened.
 */

import { FakeDb } from "./helpers/fake-supabase";

let db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({ createServerClient: () => db }));
jest.mock("@/lib/jumia/oauth", () => ({ JUMIA_API_BASE: "https://vendor-api.jumia.com" }));

let clerkUser: string | null = "user_admin";
jest.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: clerkUser }) }));
jest.mock("@/lib/jumia/api", () => ({
  getValidJumiaCredentials: async () => ({ accessToken: "tok_secret", shopId: "s", currency: "GHS", country: "GH" }),
}));

import { GET as rtsPage, POST as rtsRoute } from "@/app/admin/orders/ready-to-ship/route";
import { GET as cancelPage, POST as cancelRoute } from "@/app/admin/orders/cancel/route";
import type { JumiaOrderItem } from "@/lib/jumia/orders";

const ORDER_ID = "41ea7c3b-20f0-466d-a095-e6e909298180";
const ITEM_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ITEM_B = "bbbbbbbb-0000-4000-8000-000000000002";

const item = (id: string, over: Partial<JumiaOrderItem> = {}): JumiaOrderItem => ({
  id, status: "PENDING", trackingNumber: null, shipmentType: "Dropshipping", isFulfilledByJumia: false,
  product: { name: `Product ${id.slice(0, 2)}`, sellerSku: "SKU" }, ...over,
});
const packed = (id: string, over: Partial<JumiaOrderItem> = {}) => item(id, { trackingNumber: "DS-GKC-355926919-1", ...over });

let orderItems: JumiaOrderItem[] = [];
let afterChange: JumiaOrderItem[] | null = null;
let answer: { status: number; body: unknown } = { status: 201, body: {} };
const calls: { method: string; path: string; body?: unknown }[] = [];

beforeEach(() => {
  db = new FakeDb();
  db.tables.app_settings = [{ key: "orders_pack_allowed_numbers", value: ["355926919"] }];
  clerkUser = "user_admin";
  process.env.ADMIN_USER_IDS = "user_admin";
  calls.length = 0;
  orderItems = [packed(ITEM_A), packed(ITEM_B)];
  afterChange = null;
  answer = { status: 201, body: {} };
  global.fetch = jest.fn(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    let status = 200;
    let body: unknown = {};
    if (url.pathname === "/orders") body = { orders: [{ id: ORDER_ID, number: "355926919" }], nextToken: null, isLastPage: true };
    else if (url.pathname === "/orders/items") body = [{ orderId: ORDER_ID, orderNumber: "355926919", items: orderItems }];
    else if (url.pathname === "/orders/ready-to-ship" || url.pathname === "/orders/cancel") {
      ({ status, body } = answer);
      if (afterChange) orderItems = afterChange;
    }
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
});

const writes = () => calls.filter((c) => c.method !== "GET");

function form(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const each of Array.isArray(v) ? v : [v]) fd.append(k, each);
  return fd;
}
const req = (path: string, fields: Record<string, string | string[]>, headers: Record<string, string> = {}) =>
  new Request(`https://pandaworldai.site${path}`, { method: "POST", body: form(fields), headers });
const getReq = (path: string) => new Request(`https://pandaworldai.site${path}?orderId=${ORDER_ID}`);

describe("Ready to ship", () => {
  const fields = (over: Record<string, string | string[]> = {}) => ({ orderId: ORDER_ID, confirm: "yes", item: [ITEM_A, ITEM_B], ...over });
  const post = (over: Record<string, string | string[]> = {}, headers: Record<string, string> = {}) =>
    rtsRoute(req("/admin/orders/ready-to-ship", fields(over), headers));

  it("is not found for anyone but an admin", async () => {
    clerkUser = "user_seller";
    expect((await rtsPage(getReq("/admin/orders/ready-to-ship"))).status).toBe(404);
    expect((await post()).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("is off for an order the owner hasn't switched on", async () => {
    db.tables.app_settings = [];
    expect((await rtsPage(getReq("/admin/orders/ready-to-ship"))).status).toBe(403);
    expect((await post()).status).toBe(403);
    expect(writes()).toHaveLength(0);
  });

  it("the page lists the packed items and changes nothing", async () => {
    const res = await rtsPage(getReq("/admin/orders/ready-to-ship"));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Mark order #355926919 ready to ship");
    expect(text).toContain("DS-GKC-355926919-1");
    expect(text).toContain(`name="item" value="${ITEM_A}"`);
    expect(writes()).toHaveLength(0);
  });

  it("says to pack first when nothing is packed", async () => {
    orderItems = [item(ITEM_A)];
    expect(await (await rtsPage(getReq("/admin/orders/ready-to-ship"))).text()).toContain("pack the order first");
  });

  it("changes nothing from another site, without the confirmation, or when the order changed", async () => {
    expect((await post({}, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ confirm: "" })).status).toBe(400);
    expect((await post({ item: [ITEM_A] })).status).toBe(409);
    orderItems = [packed(ITEM_A), packed(ITEM_B, { status: "READY_TO_SHIP" })];
    expect((await post()).status).toBe(409);
    expect(writes()).toHaveLength(0);
  });

  it("marks the order's packed items and reports what Jumia now has", async () => {
    answer = { status: 201, body: { success: { packages: [{ orderItems: [ITEM_A, ITEM_B], countryCode: "GH", trackingNumber: "DS-GKC-355926919-1" }], total: 2 }, error: { orderItems: [], total: 0 } } };
    afterChange = [packed(ITEM_A, { status: "READY_TO_SHIP" }), packed(ITEM_B, { status: "READY_TO_SHIP" })];
    const res = await post();
    expect(res.status).toBe(200);
    expect(writes()).toEqual([{ method: "POST", path: "/orders/ready-to-ship", body: { orderItemIds: [ITEM_A, ITEM_B] } }]);
    expect(await res.text()).toContain("2 item(s) now READY_TO_SHIP");
  });

  it("doesn't claim success when the items still read pending", async () => {
    answer = { status: 201, body: { success: { packages: [], total: 0 }, error: { orderItems: [], total: 0 } } };
    const res = await post();
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("still read PENDING");
  });

  it("shows Jumia's refusal and never shows the token", async () => {
    answer = { status: 403, body: { message: "Forbidden" } };
    const res = await post();
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain("VC - Order Manager");
    expect(text).not.toContain("tok_secret");
  });
});

describe("Cancel", () => {
  const fields = (over: Record<string, string | string[]> = {}) => ({
    orderId: ORDER_ID, confirm: "yes", confirmNumber: "355926919", item: [ITEM_A, ITEM_B], ...over,
  });
  const post = (over: Record<string, string | string[]> = {}, headers: Record<string, string> = {}) =>
    cancelRoute(req("/admin/orders/cancel", fields(over), headers));

  it("is not found for anyone but an admin", async () => {
    clerkUser = "user_seller";
    expect((await cancelPage(getReq("/admin/orders/cancel"))).status).toBe(404);
    expect((await post()).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("is off for an order the owner hasn't switched on", async () => {
    db.tables.app_settings = [{ key: "orders_pack_allowed_numbers", value: ["388626919"] }];
    expect((await post()).status).toBe(403);
    expect(writes()).toHaveLength(0);
  });

  it("the page warns about the default reason, asks for the number, and changes nothing", async () => {
    orderItems = [item(ITEM_A), packed(ITEM_B, { status: "READY_TO_SHIP" })];
    const text = await (await cancelPage(getReq("/admin/orders/cancel"))).text();
    expect(text).toContain("Cancel order #355926919");
    expect(text).toContain("default cancellation reason");
    expect(text).toContain('name="confirmNumber"');
    expect(text).toContain(`name="item" value="${ITEM_A}"`);
    expect(text).toContain(`name="item" value="${ITEM_B}"`);
    expect(writes()).toHaveLength(0);
  });

  it("offers nothing to cancel once shipped, cancelled, or Fulfilled by Jumia", async () => {
    orderItems = [item(ITEM_A, { status: "SHIPPED" }), item(ITEM_B, { status: "CANCELED" }), item("cccccccc-0000-4000-8000-000000000003", { isFulfilledByJumia: true })];
    expect(await (await cancelPage(getReq("/admin/orders/cancel"))).text()).toContain("Nothing to cancel");
  });

  it("cancels nothing without the confirmation, with the wrong number typed, from another site, or when the order changed", async () => {
    expect((await post({ confirm: "" })).status).toBe(400);
    expect((await post({ confirmNumber: "" })).status).toBe(400);
    expect((await post({ confirmNumber: "388626919" })).status).toBe(400);
    expect((await post({}, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ item: [ITEM_A] })).status).toBe(409);
    expect(writes()).toHaveLength(0);
  });

  it("cancels the order's items with PUT /orders/cancel and reports what Jumia now has", async () => {
    answer = {
      status: 200,
      body: {
        success: { orderItems: [ITEM_A, ITEM_B].map((id) => ({ id, countryCode: "GH", cancellationReason: { id: "r", description: "Default Cancellation Reason" } })), total: 2 },
        error: { orderItems: [], total: 0 },
      },
    };
    afterChange = [item(ITEM_A, { status: "CANCELED" }), item(ITEM_B, { status: "CANCELED" })];
    const res = await post({ confirmNumber: " #355926919 " });
    expect(res.status).toBe(200);
    expect(writes()).toEqual([{ method: "PUT", path: "/orders/cancel", body: { orderItemIds: [ITEM_A, ITEM_B] } }]);
    const text = await res.text();
    expect(text).toContain("Cancelled 2 item(s)");
    expect(text).toContain("Default Cancellation Reason");
  });

  it("shows what Jumia refused", async () => {
    answer = {
      status: 200,
      body: { success: { orderItems: [], total: 0 }, error: { orderItems: [{ id: ITEM_A, response: { code: "not_allowed_status", message: "Only order items in pending and ready to ship status can be cancelled" } }], total: 1 } },
    };
    const res = await post();
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("Only order items in pending and ready to ship status can be cancelled");
  });

  it("never packs or marks ready to ship", async () => {
    afterChange = [item(ITEM_A, { status: "CANCELED" }), item(ITEM_B, { status: "CANCELED" })];
    await post();
    expect(calls.some((c) => /pack|ready-to-ship|print-labels/.test(c.path))).toBe(false);
  });
});
