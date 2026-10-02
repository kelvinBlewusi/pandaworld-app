/**
 * POST /api/extension/polish-images — the extension's admin-only Polish
 * images prototype: rough photos in, four generated product shots out.
 */

let authUser: string | null = "user_admin";
jest.mock("@/lib/security/extension-keys", () => ({
  authenticateExtensionKey: async () => (authUser ? { ok: true, userId: authUser } : { ok: false, error: "Invalid API key" }),
}));
jest.mock("@/lib/auth/is-admin", () => ({ isAdmin: (id: string) => id === "user_admin" }));

const generated: { sources: number; context?: string }[] = [];
jest.mock("@/lib/gemini-image", () => ({
  isGeminiImageEnabled: () => true,
  generateProductShots: async (sources: unknown[], _userId: string, opts: { productContext?: string }) => {
    generated.push({ sources: sources.length, context: opts.productContext });
    return [
      { id: "main", label: "Main image", url: "https://cdn.test/main.png" },
      { id: "angle", label: "Angle", url: "https://cdn.test/angle.png" },
      { id: "lifestyle", label: "Lifestyle", error: "timed out" },
      { id: "detail", label: "Detail", url: "https://cdn.test/detail.png" },
    ];
  },
}));

import { POST } from "@/app/api/extension/polish-images/route";

const PHOTO = `data:image/jpeg;base64,${Buffer.alloc(2048, 1).toString("base64")}`;
const call = (body: unknown) => POST(new Request("https://pandaworldai.site/api/extension/polish-images", {
  method: "POST", headers: { authorization: "Bearer pw_live_x", "content-type": "application/json" }, body: JSON.stringify(body),
}));

beforeEach(() => { authUser = "user_admin"; generated.length = 0; });

it("needs a valid API key", async () => {
  authUser = null;
  expect((await call({ images: [{ dataUrl: PHOTO }] })).status).toBe(401);
});

it("is for admins only while it's a prototype", async () => {
  authUser = "user_seller";
  const res = await call({ images: [{ dataUrl: PHOTO }] });
  expect(res.status).toBe(403);
  expect(generated).toHaveLength(0);
});

it("needs at least one photo", async () => {
  expect((await call({ images: [] })).status).toBe(400);
});

it("returns the four shots from up to three photos, with the seller's notes as context", async () => {
  const res = await call({ images: [{ dataUrl: PHOTO }, { dataUrl: PHOTO }, { dataUrl: PHOTO }, { dataUrl: PHOTO }], notes: "Palmolive shower cream 250ml" });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.images.map((i: { id: string }) => i.id)).toEqual(["main", "angle", "lifestyle", "detail"]);
  expect(generated).toEqual([{ sources: 3, context: "Palmolive shower cream 250ml" }]);
});
