/**
 * "Pack order and get label" (/admin/orders/pack). Packing commits a real
 * customer's order to a shipping provider and Jumia's API has no undo, so these
 * tests are mostly about what must NOT reach Jumia's pack calls: not an admin,
 * a request from another site, an order the owner hasn't named, an unticked
 * confirmation, an order that changed since the page was opened, a provider
 * Jumia doesn't offer for every item. Then: one package for the whole order,
 * the order read back, the label fetched. First used on the owner's shop on
 * 2026-10-06.
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
// The real items reply is a LIST of {orderId, orderNumber, items}; the spec shows one object.
let itemsReplyAsObject = false;
let providers: Record<string, { id: string; name: string; trackingCodeRequired?: boolean }[]> = {};
let packAnswer: { status: number; body: unknown } = { status: 201, body: {} };
// What the order's items become once a pack call reaches Jumia (null: unchanged).
let afterPack: JumiaOrderItem[] | null = null;
let labelsAnswer: { status: number; body: unknown } = { status: 201, body: {} };
const PDF_B64 = Buffer.from("%PDF-1.4 label").toString("base64");
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
  itemsReplyAsObject = false;
  providers = {
    [ITEM_A]: [{ id: PROVIDER, name: "GH-VDO-OWN-East Legon-Station" }, { id: PROVIDER_NEEDS_CODE, name: "Own courier", trackingCodeRequired: true }],
    [ITEM_B]: [{ id: PROVIDER, name: "GH-VDO-OWN-East Legon-Station" }, { id: PROVIDER_NEEDS_CODE, name: "Own courier", trackingCodeRequired: true }],
  };
  packAnswer = { status: 201, body: { success: { packages: [{ orderItems: [ITEM_A, ITEM_B], trackingCode: "DS-TRACK-1" }], total: 2 }, error: { packages: [], total: 0 } } };
  afterPack = [item(ITEM_A, { trackingNumber: "DS-TRACK-1" }), item(ITEM_B, { trackingNumber: "DS-TRACK-1" })];
  labelsAnswer = { status: 201, body: { success: { labels: [{ orderItemIds: [ITEM_A, ITEM_B], countryCode: "GH", trackingNumber: "DS-TRACK-1", label: PDF_B64 }], total: 1 }, error: { orderItems: [], total: 0 } } };
  global.fetch = jest.fn(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    let status = 200;
    let body: unknown = {};
    if (url.pathname === "/orders") body = { orders: listedOrders, nextToken: null, isLastPage: true };
    else if (url.pathname === "/orders/items") {
      const entry = {
        orderId: ORDER_ID,
        ...(itemsReplyNumber ? { orderNumber: itemsReplyNumber } : {}),
        shippingAddress: { firstName: "Emmanuel", city: "Takoradi" },
        items: orderItems,
      };
      body = itemsReplyAsObject ? entry : [entry];
    }
    else if (url.pathname === "/orders/shipment-providers") {
      body = { orderItems: url.searchParams.getAll("orderItemId").map((id) => ({ id, shipmentProviders: providers[id] ?? [] })) };
    } else if (url.pathname === "/v2/orders/pack" || url.pathname === "/orders/pack") {
      ({ status, body } = packAnswer);
      if (afterPack) orderItems = afterPack;
    } else if (url.pathname === "/orders/print-labels") ({ status, body } = labelsAnswer);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
});

const packCalls = () => calls.filter((c) => c.path === "/v2/orders/pack" || c.path === "/orders/pack");

function form(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const each of Array.isArray(v) ? v : [v]) fd.append(k, each);
  return fd;
}
const validFields = (over: Record<string, string | string[]> = {}) => ({
  orderId: ORDER_ID, confirm: "yes", api: "v2", item: [ITEM_A, ITEM_B], provider: PROVIDER, ...over,
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
    expect(await res.text()).toContain("Changes aren't switched on");
    expect(calls.map((c) => c.path)).toEqual(["/orders/items", "/orders"]);
  });

  // The screenshot that found it: "Order #" with no number, and packing refused.
  it("works when the items reply carries no order number, reading it from the orders list", async () => {
    itemsReplyNumber = undefined;
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Pack order #388626919");
  });

  // The screenshot that found the real shape: "0: object with orderId, orderNumber, items".
  it("reads the items from the real reply, a list with one entry per order", async () => {
    itemsReplyAsObject = false;
    const text = await (await get()).text();
    expect(text).toContain("Pack order #388626919");
    expect(text).toContain("Product aa");
    expect(text).toContain("Product bb");
  });

  it("also reads the single object the spec shows", async () => {
    itemsReplyAsObject = true;
    const text = await (await get()).text();
    expect(text).toContain("Pack order #388626919");
    expect(text).toContain("Product aa");
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
    expect(text).toContain("reply: list of 1");
    expect(text).toContain("[0].items: list of 2");
    expect(text).toContain("[0].shippingAddress: object with firstName, city");
    expect(text).not.toContain("Emmanuel");
    expect(text).not.toContain("Takoradi");
    expect(packCalls()).toHaveLength(0);
  });

  it("offers one package for the whole order, with the providers Jumia offers for every item, and changes nothing", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Pack order #388626919 and get the label");
    expect(text).toContain("<b>2 items</b>");
    expect(text).toContain("one package");
    expect(text).toContain("GH-VDO-OWN-East Legon-Station");
    expect(text).toContain("Own courier (needs a tracking code)");
    expect(text).toContain(`name="item" value="${ITEM_A}"`);
    expect(text).toContain(`name="item" value="${ITEM_B}"`);
    expect(text).toContain("Pack order and get label");
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("offers only the providers that take every item, and lists everything Jumia sent per item", async () => {
    providers[ITEM_B] = [{ id: PROVIDER, name: "GH-VDO-OWN-East Legon-Station" }];
    const text = await (await get()).text();
    expect(text).toContain(`name="provider" value="${PROVIDER}"`);
    expect(text).not.toContain(`name="provider" value="${PROVIDER_NEEDS_CODE}"`);
    expect(text).toContain("Drop-off station: 1 that takes every item");
    expect(text).toContain("Product aa: <b>2</b> stations: GH-VDO-OWN-East Legon-Station, Own courier (needs a tracking code)");
    expect(text).toContain("Product bb: <b>1</b> station: GH-VDO-OWN-East Legon-Station");
  });

  it("sends the owner to Vendor Center when no provider takes every item", async () => {
    providers[ITEM_B] = [{ id: "eeeeeeee-0000-4000-8000-00000000000e", name: "Other station" }];
    const res = await get();
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("Pack this order in Vendor Center");
  });

  it("leaves out an item already packed", async () => {
    orderItems = [item(ITEM_A, { trackingNumber: "JG-1" }), item(ITEM_B)];
    const text = await (await get()).text();
    expect(text).toContain("This item goes");
    expect(text).not.toContain(`name="item" value="${ITEM_A}"`);
    expect(text).toContain("Not in this package");
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

  it("packs nothing with no items, or an unknown pack call", async () => {
    expect((await post(validFields({ item: [] }))).status).toBe(400);
    expect((await post(validFields({ api: "v3" }))).status).toBe(400);
    expect((await post(validFields({ api: "" }))).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("packs nothing for an order that isn't switched on", async () => {
    db.tables.app_settings = [];
    const res = await post(validFields());
    expect(res.status).toBe(403);
    expect(packCalls()).toHaveLength(0);
  });

  it("packs nothing when the order changed since the page was opened", async () => {
    // An item packed, shipped or moved to Jumia meanwhile.
    for (const changed of [{ trackingNumber: "JG-1" }, { status: "SHIPPED" }, { isFulfilledByJumia: true }]) {
      orderItems = [item(ITEM_A, changed), item(ITEM_B)];
      expect((await post(validFields())).status).toBe(409);
    }
    // An item the page didn't show.
    orderItems = [item(ITEM_A), item(ITEM_B), item("eeeeeeee-0000-4000-8000-000000000009")];
    expect((await post(validFields())).status).toBe(409);
    // The page showed fewer items than are left, or one that isn't on the order.
    orderItems = [item(ITEM_A), item(ITEM_B)];
    expect((await post(validFields({ item: [ITEM_A] }))).status).toBe(409);
    expect((await post(validFields({ item: [ITEM_A, "eeeeeeee-0000-4000-8000-000000000009"] }))).status).toBe(409);
    expect(packCalls()).toHaveLength(0);
  });

  it("packs nothing with a provider Jumia doesn't offer for every item", async () => {
    expect((await post(validFields({ provider: "ffffffff-0000-4000-8000-00000000000a" }))).status).toBe(400);
    providers[ITEM_B] = [{ id: PROVIDER, name: "GH-VDO-OWN-East Legon-Station" }];
    expect((await post(validFields({ provider: PROVIDER_NEEDS_CODE, tracking: "E1" }))).status).toBe(400);
    expect(packCalls()).toHaveLength(0);
  });

  it("needs a tracking code when the provider requires one, and sends it", async () => {
    const missing = await post(validFields({ provider: PROVIDER_NEEDS_CODE }));
    expect(missing.status).toBe(400);
    expect(packCalls()).toHaveLength(0);

    await post(validFields({ provider: PROVIDER_NEEDS_CODE, tracking: " E123456 " }));
    expect(packCalls()[0].body).toEqual({
      packages: [{ orderItems: [ITEM_A, ITEM_B], shipmentProviderId: PROVIDER_NEEDS_CODE, trackingCode: "E123456" }],
    });
  });

  it("packs the whole order as ONE package, reads it back and gives the label", async () => {
    const res = await post(validFields());
    expect(res.status).toBe(200);
    expect(packCalls()).toHaveLength(1);
    expect(packCalls()[0].path).toBe("/v2/orders/pack");
    expect(packCalls()[0].body).toEqual({ packages: [{ orderItems: [ITEM_A, ITEM_B], shipmentProviderId: PROVIDER }] });

    const paths = calls.map((c) => c.path);
    // Read back after packing, then the label for the packed items.
    expect(paths.lastIndexOf("/orders/items")).toBeGreaterThan(paths.indexOf("/v2/orders/pack"));
    expect(calls.find((c) => c.path === "/orders/print-labels")?.body).toEqual({ orderItemIds: [ITEM_A, ITEM_B] });

    const text = await res.text();
    expect(text).toContain("Packed 2 item(s) into <b>1 package</b>");
    expect(text).toContain("GH-VDO-OWN-East Legon-Station");
    expect(text).toContain(`href="data:application/pdf;base64,${PDF_B64}"`);
    expect(text).toContain("Download label (tracking DS-TRACK-1)");
    expect(text).toContain("/admin/orders/label");
  });

  it("says so when Jumia made a package per item", async () => {
    afterPack = [item(ITEM_A, { trackingNumber: "DS-1" }), item(ITEM_B, { trackingNumber: "DS-2" })];
    expect(await (await post(validFields())).text()).toContain("into <b>2 packages</b>");
  });

  it("goes by what Jumia has afterwards, not by its answer: a partial pack is shown as partial", async () => {
    afterPack = [item(ITEM_A, { trackingNumber: "DS-1" }), item(ITEM_B)];
    const text = await (await post(validFields())).text();
    expect(text).toContain("Only 1 of 2 items were packed");
    expect(calls.find((c) => c.path === "/orders/print-labels")?.body).toEqual({ orderItemIds: [ITEM_A] });
  });

  it("when Jumia refuses the list and nothing was packed, offers the older pack call, which asks again", async () => {
    packAnswer = { status: 400, body: { message: "Invalid orderItems format" } };
    afterPack = null;
    const res = await post(validFields());
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain("Invalid orderItems format");
    expect(text).toContain("Nothing on this order was packed");
    expect(text).toContain('name="api" value="v1"');
    expect(text).toContain("Try the older pack call");
    // The offer is a form with the confirmation unticked: nothing more is sent by itself.
    expect(text).toContain('<input type="checkbox" name="confirm" value="yes">');
    expect(calls.some((c) => c.path === "/orders/print-labels")).toBe(false);
  });

  it("the older call sends the items as a list with their provider", async () => {
    packAnswer = { status: 201, body: { success: { packages: [{ orderItems: [ITEM_A, ITEM_B], countryCode: "GH", trackingNumber: "DS-TRACK-1" }], total: 2 }, error: { orderItems: [], total: 0 } } };
    const res = await post(validFields({ api: "v1" }));
    expect(res.status).toBe(200);
    expect(packCalls()).toHaveLength(1);
    expect(packCalls()[0].path).toBe("/orders/pack");
    expect(packCalls()[0].body).toEqual({
      orderItems: [{ id: ITEM_A, shipmentProviderId: PROVIDER }, { id: ITEM_B, shipmentProviderId: PROVIDER }],
    });
    expect(await res.text()).toContain("into <b>1 package</b>");
  });

  it("the older call isn't used for a provider that needs a tracking code (it has no field for one)", async () => {
    const res = await post(validFields({ api: "v1", provider: PROVIDER_NEEDS_CODE, tracking: "E1" }));
    expect(res.status).toBe(400);
    expect(packCalls()).toHaveLength(0);
  });

  it("shows what Jumia refused", async () => {
    packAnswer = { status: 201, body: { success: { packages: [], total: 0 }, error: { packages: [{ orderItems: [ITEM_A, ITEM_B], error: "Order items are not from the same order." }], total: 2 } } };
    afterPack = null;
    const res = await post(validFields());
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("Order items are not from the same order.");
  });

  it("when the order can't be read back, says to check Vendor Center and offers nothing more", async () => {
    let itemsReads = 0;
    const base = global.fetch;
    global.fetch = jest.fn(async (input: URL | string, init?: RequestInit) => {
      if (new URL(String(input)).pathname === "/orders/items" && ++itemsReads === 2) {
        return new Response(JSON.stringify({ message: "busy" }), { status: 500 });
      }
      return base(input, init);
    }) as unknown as typeof fetch;
    const res = await post(validFields());
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain("Check it in Vendor Center");
    expect(text).not.toContain("Try the older pack call");
  });

  it("packs but still shows the order when the label isn't ready, with a button to fetch it", async () => {
    labelsAnswer = { status: 201, body: { success: { labels: [], total: 0 }, error: { orderItems: [], total: 0 } } };
    const res = await post(validFields());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Packed 2 item(s)");
    expect(text).toContain("didn't return the label yet");
    expect(text).toContain("Open the label");
  });

  it("never marks ready to ship or cancels", async () => {
    await post(validFields());
    const writes = calls.filter((c) => c.method === "POST").map((c) => c.path);
    expect(writes).toEqual(["/v2/orders/pack", "/orders/print-labels"]);
    expect(calls.some((c) => /ready-to-ship|cancel/.test(c.path))).toBe(false);
  });

  it("reports a Jumia error without saying it was packed, and never shows the token", async () => {
    packAnswer = { status: 403, body: { message: "Forbidden" } };
    afterPack = null;
    const res = await post(validFields());
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain("VC - Order Manager");
    expect(text).not.toContain("Packed 2");
    expect(text).not.toContain("tok_secret");
  });
});

describe("describeShape", () => {
  it("describes a list reply by its first entry", () => {
    const text = describeShape([{ orderId: "o1", orderNumber: "123", shippingAddress: { firstName: "Emmanuel" }, items: [{ id: "i1", status: "PENDING", product: { name: "Kettle" } }] }]);
    expect(text).toContain("reply: list of 1");
    expect(text).toContain('[0].orderNumber: "123"');
    expect(text).toContain("[0].shippingAddress: object with firstName");
    expect(text).toContain('[0].items[0].status: "PENDING"');
    expect(text).not.toContain("Emmanuel");
  });

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
