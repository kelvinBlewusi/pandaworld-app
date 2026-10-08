/**
 * POST /api/listing-assistant/products: the web chat's product form, how every
 * seller lists on the web (2026-10-08). Checks each product before the batch
 * is made: photos that are the seller's own, a price, a whole quantity.
 */

let signedInAs: string | null = "admin";
jest.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: signedInAs }) }));
jest.mock("@/lib/rate-limit", () => ({ checkRateLimit: () => null, RATE_LIMITS: { assistantMessage: {} } }));
jest.mock("@/lib/observability/errors", () => ({ logAppError: () => undefined }));
const started: { userId: string; address: string; id: string; products: unknown[] }[] = [];
jest.mock("@/lib/whatsapp/intake", () => ({
  startBatchFromForm: async (userId: string, address: string, id: string, products: unknown[]) => {
    started.push({ userId, address, id, products });
    return { ok: true };
  },
}));
let assistantOn = true;
jest.mock("@/lib/whatsapp/listing-assistant", () => ({
  MAX_ALBUM: 8,
  listingAssistantFor: async () => assistantOn,
  ownMedia: (userId: string, m: string) => (m.startsWith(`web:${userId}/`) ? m : null),
}));

import { POST } from "@/app/api/listing-assistant/products/route";

const call = (body: unknown) => POST(new Request("https://x.test", { method: "POST", body: JSON.stringify(body) }) as never);
const product = (patch: Record<string, unknown> = {}) => ({ mediaIds: ["web:admin/assistant/a.jpg"], price: 150, quantity: 2, sizes: "S, M", colour: "black", notes: "", ...patch });

beforeEach(() => { signedInAs = "admin"; assistantOn = true; started.length = 0; });

it("is there for every seller, and not while the assistant is switched off", async () => {
  signedInAs = "seller";
  expect((await call({ id: "web-123456789", products: [product({ mediaIds: ["web:seller/assistant/a.jpg"] })] })).status).toBe(200);
  expect(started.map((s) => s.address)).toEqual(["web:seller"]);
  assistantOn = false;
  expect((await call({ id: "web-123456789", products: [product({ mediaIds: ["web:seller/assistant/a.jpg"] })] })).status).toBe(403);
  expect(started).toHaveLength(1);
});

it("makes the batch from an admin's products, under their web chat", async () => {
  const res = await call({ id: "web-123456789", products: [product(), product({ price: "99.5", quantity: null })] });
  expect(res.status).toBe(200);
  expect(started).toEqual([{
    userId: "admin", address: "web:admin", id: "web-123456789",
    products: [
      { mediaIds: ["web:admin/assistant/a.jpg"], price: 150, quantity: 2, sizes: "S, M", colour: "black", notes: "" },
      { mediaIds: ["web:admin/assistant/a.jpg"], price: 99.5, quantity: null, sizes: "S, M", colour: "black", notes: "" },
    ],
  }]);
});

it("says which product needs what, and makes nothing", async () => {
  const body = async (r: Response) => ((await r.json()) as { error: string }).error;
  expect(await body(await call({ id: "web-123456789", products: [product(), product({ mediaIds: [] })] }))).toBe("Product 2 needs at least one photo.");
  expect(await body(await call({ id: "web-123456789", products: [product({ price: 0 })] }))).toBe("Product 1 needs its price.");
  expect(await body(await call({ id: "web-123456789", products: [product({ quantity: 1.5 })] }))).toBe("Product 1's quantity should be a whole number.");
  expect(await body(await call({ id: "web-123456789", products: [product({ mediaIds: ["web:someone/assistant/x.jpg"] })] }))).toBe("A photo isn't yours to send.");
  expect(started).toHaveLength(0);
});
