/**
 * Jumia orders and shipping labels, read-only (lib/jumia/orders.ts and the
 * admin's /admin/orders/label): list orders, read an order's items, fetch the
 * label of items already packed. Nothing here may pack, ship or change an
 * order: every test that reaches the route also checks no such call was made.
 */

jest.mock("@/lib/jumia/oauth", () => ({ JUMIA_API_BASE: "https://vendor-api.jumia.com" }));

let clerkUser: string | null = "user_admin";
jest.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: clerkUser }) }));
let credsError: Error | null = null;
jest.mock("@/lib/jumia/api", () => ({
  getValidJumiaCredentials: async () => {
    if (credsError) throw credsError;
    return { accessToken: "tok_secret", shopId: "s", currency: "GHS", country: "GH" };
  },
}));

import { listOrders, getOrderItems, printLabels, labelableItems, describeError, type JumiaOrderItem } from "@/lib/jumia/orders";
import { POST as labelRoute } from "@/app/admin/orders/label/route";

const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
let answer: (url: URL, method: string) => { status: number; body: unknown } = () => ({ status: 200, body: {} });

beforeEach(() => {
  calls.length = 0;
  clerkUser = "user_admin";
  credsError = null;
  process.env.ADMIN_USER_IDS = "user_admin";
  global.fetch = jest.fn(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body as string | undefined });
    const { status, body } = answer(url, init?.method ?? "GET");
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
});

const ORDER_ID = "41ea7c3b-20f0-466d-a095-e6e909298180";
const item = (over: Partial<JumiaOrderItem> = {}): JumiaOrderItem => ({
  id: "ddf7113b-2796-4641-86ef-c4c7083d9b59", status: "PENDING", trackingNumber: "JG-00D-393842527-9589",
  shipmentType: "Dropshipping", isFulfilledByJumia: false, product: { name: "Kettle", sellerSku: "SKU-1" }, ...over,
});
const PDF_B64 = Buffer.from("%PDF-1.4 fake label").toString("base64");

describe("the Jumia client", () => {
  it("lists orders with the filters Jumia names, comma-separating statuses, and the bearer token", async () => {
    answer = () => ({ status: 200, body: { orders: [], nextToken: null, isLastPage: true } });
    const r = await listOrders("tok_secret", { status: ["PENDING", "SHIPPED"], createdAfter: "2026-09-06", createdBefore: "2026-10-07", size: 50, sort: "DESC" });
    expect(r.ok).toBe(true);
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe("/orders");
    expect(u.searchParams.get("status")).toBe("PENDING,SHIPPED");
    expect(u.searchParams.get("createdAfter")).toBe("2026-09-06");
    expect(u.searchParams.get("size")).toBe("50");
    expect(u.searchParams.get("sort")).toBe("DESC");
    expect(calls[0].method).toBe("GET");
    expect(calls[0].headers.Authorization).toBe("Bearer tok_secret");
  });

  it("reads an order's items by id", async () => {
    answer = () => ({ status: 200, body: { orderId: ORDER_ID, orderNumber: "338997922", items: [item()] } });
    const r = await getOrderItems("tok", ORDER_ID);
    expect(r.ok && r.data.items).toHaveLength(1);
    expect(new URL(calls[0].url).searchParams.get("orderId")).toBe(ORDER_ID);
  });

  it("prints labels with a POST of the item ids", async () => {
    answer = () => ({ status: 201, body: { success: { labels: [], total: 0 }, error: { orderItems: [], total: 0 } } });
    await printLabels("tok", ["a", "b"]);
    expect(calls[0].method).toBe("POST");
    expect(new URL(calls[0].url).pathname).toBe("/orders/print-labels");
    expect(JSON.parse(calls[0].body!)).toEqual({ orderItemIds: ["a", "b"] });
    expect(calls[0].headers["Content-Type"]).toBe("application/json");
  });

  it("names the missing role on a 403, and says to reconnect on a 401", async () => {
    answer = () => ({ status: 403, body: { message: "Forbidden" } });
    const r403 = await listOrders("tok");
    expect(!r403.ok && r403.message).toContain("VC - Order Viewer");
    answer = () => ({ status: 401, body: { error: "invalid_token" } });
    const r401 = await listOrders("tok");
    expect(!r401.ok && r401.message).toContain("Reconnect Jumia");
  });

  it("reports a network failure instead of throwing", async () => {
    global.fetch = jest.fn(async () => { throw new Error("socket hang up"); }) as unknown as typeof fetch;
    const r = await listOrders("tok");
    expect(r).toEqual({ ok: false, status: 0, message: "Couldn't reach Jumia: socket hang up" });
  });

  it("describes errors from any of Jumia's shapes", () => {
    expect(describeError(422, { errors: [{ message: "bad status" }] }, "")).toContain("bad status");
    expect(describeError(500, null, "plain text failure")).toContain("plain text failure");
  });

  it("only offers items that are packed and shipped by the seller", () => {
    const packed = item();
    const notPacked = item({ id: "2", trackingNumber: null });
    const jumia = item({ id: "3", isFulfilledByJumia: true });
    expect(labelableItems([packed, notPacked, jumia]).map((i) => i.id)).toEqual([packed.id]);
  });
});

describe("/admin/orders/label", () => {
  const post = (orderId: string | null = ORDER_ID) => {
    const fd = new FormData();
    if (orderId !== null) fd.set("orderId", orderId);
    return labelRoute(new Request("https://pandaworldai.site/admin/orders/label", { method: "POST", body: fd }));
  };
  const noWritesToOrders = () =>
    expect(calls.some((c) => /\/pack|ready-to-ship|\/cancel/.test(c.url))).toBe(false);

  it("is not found for anyone but an admin, and calls nothing", async () => {
    clerkUser = "user_seller";
    expect((await post()).status).toBe(404);
    clerkUser = null;
    expect((await post()).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("rejects a malformed order id", async () => {
    expect((await post("../../etc")).status).toBe(400);
    expect((await post(null)).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("says so when Jumia isn't connected", async () => {
    credsError = new Error("JUMIA_NOT_CONNECTED");
    const res = await post();
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("JUMIA_NOT_CONNECTED");
  });

  it("returns the label as a PDF for a packed order, asking Jumia only to print it", async () => {
    answer = (url) => url.pathname === "/orders/items"
      ? { status: 200, body: { orderId: ORDER_ID, orderNumber: "338997922", items: [item()] } }
      : { status: 201, body: { success: { labels: [{ orderItemIds: [item().id], countryCode: "GH", trackingNumber: "JG-1", label: PDF_B64 }], total: 1 }, error: { orderItems: [], total: 0 } } };
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toBe('inline; filename="Label-338997922.pdf"');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("%PDF-1.4 fake label");
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(["GET /orders/items", "POST /orders/print-labels"]);
    expect(JSON.parse(calls[1].body!)).toEqual({ orderItemIds: [item().id] });
    noWritesToOrders();
  });

  it("doesn't ask for a label when nothing is packed", async () => {
    answer = () => ({ status: 200, body: { orderId: ORDER_ID, orderNumber: "1", items: [item({ trackingNumber: null })] } });
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(await res.text()).toContain("No item on this order is packed yet");
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/orders/items"]);
    noWritesToOrders();
  });

  it("shows Jumia's reason when it prints nothing", async () => {
    answer = (url) => url.pathname === "/orders/items"
      ? { status: 200, body: { orderId: ORDER_ID, orderNumber: "1", items: [item()] } }
      : { status: 201, body: { success: { labels: [], total: 0 }, error: { orderItems: [{ id: item().id, response: { code: "not_allowed_status", message: "Not packed" } }], total: 1 } } };
    const res = await post();
    expect(res.status).toBe(422);
    const text = await res.text();
    expect(text).toContain("not_allowed_status");
    expect(text).toContain("Not packed");
  });

  it("won't pass on a label that isn't a PDF, and shows what it was", async () => {
    answer = (url) => url.pathname === "/orders/items"
      ? { status: 200, body: { orderId: ORDER_ID, orderNumber: "1", items: [item()] } }
      : { status: 201, body: { success: { labels: [{ orderItemIds: [item().id], countryCode: "GH", trackingNumber: "JG-1", label: "https://files.example/label.pdf" }], total: 1 } } };
    const res = await post();
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("https://files.example/label.pdf");
  });

  it("escapes what Jumia sends before putting it in the page", async () => {
    answer = () => ({ status: 200, body: { orderId: ORDER_ID, orderNumber: "1", items: [item({ trackingNumber: null, product: { name: "<img src=x onerror=alert(1)>" } })] } });
    const text = await (await post()).text();
    expect(text).not.toContain("<img src=x");
    expect(text).toContain("&lt;img src=x");
  });

  it("never shows the access token", async () => {
    answer = () => ({ status: 403, body: { message: "Forbidden" } });
    const res = await post();
    expect(await res.text()).not.toContain("tok_secret");
  });

  it("links each package when an order has several labels", async () => {
    answer = (url) => url.pathname === "/orders/items"
      ? { status: 200, body: { orderId: ORDER_ID, orderNumber: "7", items: [item()] } }
      : { status: 201, body: { success: { labels: [
          { orderItemIds: ["a"], countryCode: "GH", trackingNumber: "JG-A", label: PDF_B64 },
          { orderItemIds: ["b"], countryCode: "GH", trackingNumber: "JG-B", label: PDF_B64 },
        ], total: 2 } } };
    const text = await (await post()).text();
    expect(text).toContain("2 labels");
    expect(text).toContain("JG-A");
    expect(text).toContain("JG-B");
  });
});
