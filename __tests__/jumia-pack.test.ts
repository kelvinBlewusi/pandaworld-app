/**
 * Packing an order from /admin/orders/pack. Packing commits a real customer's
 * order to a shipping provider and Jumia's API has no undo, so these tests are
 * mostly about what must NOT reach POST /v2/orders/pack: not an admin, a
 * request from another site, an order the owner hasn't named, an unticked
 * confirmation, an item that is no longer pending, a provider Jumia doesn't
 * offer. First used on order #388626919 (2026-10-06).
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

import { GET as packPage, POST as packRoute } from "@/app/admin/orders/pack/route";
import { packAllowedNumbers, isPackAllowed } from "@/lib/jumia/pack-allowlist";
import type { JumiaOrderItem } from "@/lib/jumia/orders";
import { describeShape } from "@/lib/jumia/order-pages";

const ORDER_ID = "41ea7c3b-20f0-466d-a095-e6e909298180";
const ITEM_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ITEM_B = "bbbbbbbb-0000-4000-8000-000000000002";
const PROVIDER = "cccccccc-0000-4000-8000-000000000003";
const PROVIDER_NEEDS_CODE = "dddddddd-0000-4000-8000-000000000004";

const item = (id: string, over: Partial<JumiaOrderItem> = {}): JumiaOrderItem => ({
  id, status: "PENDING", trackingNumber: null, shipmentType: "Dropshipping", isFulfilledByJumia: false,
  product: { name: `Product ${id.slice(0, 2)}`, sellerSku: "SKU" }, ...over,
});

let orderItems: JumiaOrderItem[] = [];
// What GET /orders lists (the number is read from here), and what the items
// reply claims: on 2026-10-06 the real items reply carried no order number.
let listedOrders: { id: string; number: string }[] = [];
let itemsReplyNumber: string | undefined;
let providers: Record<string, { id: string; name: string; trackingCodeRequired?: boolean }[]> = {};
let packAnswer: { status: number; body: unknown } = { status: 201, body: {} };
const calls: { method: string; path: string; body?: unknown }[] = [];

beforeEach(() => {
  db = new FakeDb();
  db.tables.app_settings = [{ key: "orders_pack_allowed_numbers", value: ["388626919"] }];
  clerkUser = "user_admin";
  process.env.ADMIN_USER_IDS = "user_admin";
  calls.length = 0;
  orderItems = [item(ITEM_A), item(ITEM_B)];
  listedOrders = [{ id: ORDER_ID, number: "388626919" }];
  itemsReplyNumber = undefined;
  providers = {
    [ITEM_A]: [{ id: PROVIDER, name: "Jumia Pickup Station" }, { id: PROVIDER_NEEDS_CODE, name: "Own courier", trackingCodeRequired: true }],
    [ITEM_B]: [{ id: PROVIDER, name: "Jumia Pickup Station" }],
  };
  packAnswer = { status: 201, body: { success: { packages: [{ orderItems: [ITEM_A], trackingCode: "JG-TRACK-1" }], total: 1 }, error: { packages: [], total: 0 } } };
  global.fetch = jest.fn(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    let status = 200;
    let body: unknown = {};
    if (url.pathname === "/orders") body = { orders: listedOrders, nextToken: null, isLastPage: true };
    else if (url.pathname === "/orders/items") {
      body = {
        orderId: ORDER_ID,
        ...(itemsReplyNumber ? { orderNumber: itemsReplyNumber } : {}),
        shippingAddress: { firstName: "Emmanuel", city: "Takoradi" },
        items: orderItems,
      };
    }
    else if (url.pathname === "/orders/shipment-providers") {
      body = { orderItems: url.searchParams.getAll("orderItemId").map((id) => ({ id, shipmentProviders: providers[id] ?? [] })) };
    } else if (url.pathname === "/v2/orders/pack") ({ status, body } = packAnswer);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
});

const packCalls = () => calls.filter((c) => c.path === "/v2/orders/pack");
const onlyOneKindOfWrite = () =>
  expect(calls.filter((c) => c.method === "POST").every((c) => c.path === "/v2/orders/pack")).toBe(true);

function form(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const each of Array.isArray(v) ? v : [v]) fd.append(k, each);
  return fd;
}
const validFields = (over: Record<string, string | string[]> = {}) => ({
  orderId: ORDER_ID, confirm: "yes", item: [ITEM_A], [`provider_${ITEM_A}`]: PROVIDER, ...over,
});
const post = (fields: Record<string, string | string[]>, headers: Record<string, string> = {}) =>
  packRoute(new Request("https://pandaworldai.site/admin/orders/pack", { method: "POST", body: form(fields), headers }));
const get = (orderId = ORDER_ID) => packPage(new Request(`https://pandaworldai.site/admin/orders/pack?orderId=${orderId}`));

describe("which orders may be packed", () => {
  it("is none until the owner names one", async () => {
    db.tables.app_settings = [];
    expect(await packAllowedNumbers()).toEqual([]);
    expect(await isPackAllowed("388626919")).toBe(false);
  });

  it("is just the numbers listed", async () => {
    expect(await isPackAllowed("388626919")).toBe(true);
    expect(await isPackAllowed("355926919")).toBe(false);
  });

  it.each([["388626919"], [388626919], [{ n: "388626919" }], [null], [["12"]], [["abc12345"]]])(
    "ignores a malformed setting (%p), so a typo never switches packing on",
    async (value) => {
      db.tables.app_settings = [{ key: "orders_pack_allowed_numbers", value }];
      expect(await packAllowedNumbers()).toEqual([]);
    },
  );
});

describe("the confirmation page", () => {
  it("is not found for anyone but an admin", async () => {
    clerkUser = "user_seller";
    expect((await get()).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("refuses an order that isn't switched on, without asking Jumia for providers", async () => {
    db.tables.app_settings = [{ key: "orders_pack_allowed_numbers", value: ["111111111"] }];
    const res = await get();
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("Packing isn't switched on");
    expect(calls.map((c) => c.path)).toEqual(["/orders/items", "/orders"]);
  });

  // The screenshot that found it: "Order #" with no number, and packing refused.
  it("works when the items reply carries no order number, reading it from the orders list", async () => {
    itemsReplyNumber = undefined;
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Pack order #388626919");
  });

  it("takes the number from the orders list, not from what the items reply claims", async () => {
    listedOrders = [{ id: ORDER_ID, number: "111111111" }];
    itemsReplyNumber = "388626919";
    expect((await get()).status).toBe(403);
    expect((await post(validFields())).status).toBe(403);
    expect(packCalls()).toHaveLength(0);
  });

  it("refuses when Jumia's list doesn't contain the order, and shows the shape of its reply without customer details", async () => {
    listedOrders = [];
    const res = await get();
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).toContain("couldn't confirm this order's number");
    expect(text).toContain("items: list of 2");
    expect(text).toContain("shippingAddress: object with firstName, city");
    expect(text).not.toContain("Emmanuel");
    expect(text).not.toContain("Takoradi");
    expect(packCalls()).toHaveLength(0);
  });

  it("shows each item with the providers Jumia offers for it, and changes nothing", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Pack order #388626919");
    expect(text).toContain("Jumia Pickup Station");
    expect(text).toContain("Own courier (needs a tracking code)");
    expect(text).toContain("own package");
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("says so when there is nothing left to pack", async () => {
    orderItems = [item(ITEM_A, { trackingNumber: "JG-1" })];
    const res = await get();
    expect(await res.text()).toContain("Nothing left to pack");
    expect(calls.map((c) => c.path)).toEqual(["/orders/items", "/orders"]);
  });
});

describe("packing", () => {
  it("is not found for anyone but an admin, and calls nothing", async () => {
    clerkUser = "user_seller";
    expect((await post(validFields())).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("refuses a request from another site", async () => {
    expect((await post(validFields(), { origin: "https://evil.example" })).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("accepts a request from this site's own page", async () => {
    expect((await post(validFields(), { origin: "https://pandaworldai.site" })).status).toBe(200);
    expect(packCalls()).toHaveLength(1);
  });

  it("packs nothing without the confirmation ticked", async () => {
    const res = await post(validFields({ confirm: "" }));
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("packs nothing when no item is ticked", async () => {
    const res = await post(validFields({ item: [] }));
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("packs nothing for an order that isn't switched on", async () => {
    db.tables.app_settings = [];
    const res = await post(validFields());
    expect(res.status).toBe(403);
    expect(packCalls()).toHaveLength(0);
  });

  it("packs nothing when a ticked item is no longer pending and unpacked", async () => {
    orderItems = [item(ITEM_A, { trackingNumber: "JG-1" }), item(ITEM_B)];
    expect((await post(validFields())).status).toBe(409);
    orderItems = [item(ITEM_A, { status: "SHIPPED" }), item(ITEM_B)];
    expect((await post(validFields())).status).toBe(409);
    orderItems = [item(ITEM_A, { isFulfilledByJumia: true }), item(ITEM_B)];
    expect((await post(validFields())).status).toBe(409);
    expect(packCalls()).toHaveLength(0);
  });

  it("packs nothing for an item that isn't on this order", async () => {
    const res = await post(validFields({ item: ["eeeeeeee-0000-4000-8000-000000000009"] }));
    expect(res.status).toBe(409);
    expect(packCalls()).toHaveLength(0);
  });

  it("packs nothing with a provider Jumia doesn't offer for that item", async () => {
    const res = await post(validFields({ [`provider_${ITEM_A}`]: "ffffffff-0000-4000-8000-00000000000a" }));
    expect(res.status).toBe(400);
    expect(packCalls()).toHaveLength(0);
  });

  it("needs a tracking code when the provider requires one, and sends it", async () => {
    const missing = await post(validFields({ [`provider_${ITEM_A}`]: PROVIDER_NEEDS_CODE }));
    expect(missing.status).toBe(400);
    expect(packCalls()).toHaveLength(0);

    await post(validFields({ [`provider_${ITEM_A}`]: PROVIDER_NEEDS_CODE, [`tracking_${ITEM_A}`]: " E123456 " }));
    expect(packCalls()[0].body).toEqual({
      packages: [{ orderItems: ITEM_A, shipmentProviderId: PROVIDER_NEEDS_CODE, trackingCode: "E123456" }],
    });
  });

  it("sends one package per ticked item, in the shape Jumia's own sample uses, and only the ticked ones", async () => {
    packAnswer = { status: 201, body: { success: { packages: [{ orderItems: [ITEM_A], trackingCode: "JG-TRACK-1" }], total: 1 }, error: { packages: [], total: 0 } } };
    const res = await post(validFields());
    expect(packCalls()).toHaveLength(1);
    expect(packCalls()[0].body).toEqual({ packages: [{ orderItems: ITEM_A, shipmentProviderId: PROVIDER }] });
    const text = await res.text();
    expect(text).toContain("JG-TRACK-1");
    expect(text).toContain("/admin/orders/label");

    calls.length = 0;
    await post(validFields({ item: [ITEM_A, ITEM_B], [`provider_${ITEM_B}`]: PROVIDER }));
    expect(packCalls()[0].body).toEqual({
      packages: [
        { orderItems: ITEM_A, shipmentProviderId: PROVIDER },
        { orderItems: ITEM_B, shipmentProviderId: PROVIDER },
      ],
    });
  });

  it("never makes any other change to an order", async () => {
    await post(validFields());
    onlyOneKindOfWrite();
    expect(calls.some((c) => /print-labels|ready-to-ship|cancel/.test(c.path))).toBe(false);
  });

  it("shows what Jumia refused", async () => {
    packAnswer = { status: 201, body: { success: { packages: [], total: 0 }, error: { packages: [{ orderItems: [ITEM_A], error: "Order items are not from the same order." }], total: 1 } } };
    const res = await post(validFields());
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("Order items are not from the same order.");
  });

  it("reports a Jumia error without saying it was packed, and never shows the token", async () => {
    packAnswer = { status: 403, body: { message: "Forbidden" } };
    const res = await post(validFields());
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain("VC - Order Manager");
    expect(text).not.toContain("tok_secret");
  });
});

describe("describeShape", () => {
  it("shows field names and types, values only for harmless fields, and objects as their field names", () => {
    const text = describeShape({
      orderId: "abc", shippingAddress: { firstName: "Emmanuel", address: "12 Some Road" },
      items: [{ id: "i1", status: "PENDING", trackingNumber: null, itemPrice: 12.5, product: { name: "Kettle" }, customerPhone: "0240000000" }],
    });
    expect(text).toContain('orderId: "abc"');
    expect(text).toContain("shippingAddress: object with firstName, address");
    expect(text).toContain("items: list of 1");
    expect(text).toContain('items[0].status: "PENDING"');
    expect(text).toContain("items[0].trackingNumber: null");
    expect(text).toContain("items[0].itemPrice: number");
    expect(text).toContain("items[0].product: object with name");
    expect(text).toContain("items[0].customerPhone: string");
    expect(text).not.toContain("Emmanuel");
    expect(text).not.toContain("12 Some Road");
    expect(text).not.toContain("0240000000");
  });

  it("copes with an empty or odd reply", () => {
    expect(describeShape(null)).toBe("");
    expect(describeShape("text")).toBe("");
  });
});
