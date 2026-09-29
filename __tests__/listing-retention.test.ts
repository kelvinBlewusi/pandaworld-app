/**
 * Listing retention (lib/listings/retention.ts): photos come off listings
 * live on Jumia for 30 days, and photos no listing uses are deleted 7 days
 * after upload. Supabase's Free Plan Storage is 1 GB and never resets.
 */

const calls: { op: string; args: unknown[] }[] = [];
let updateResult: { data: unknown[] | null; error: { message: string } | null } = { data: [], error: null };
const rpc = jest.fn();
const remove = jest.fn();

function listingsQuery() {
  const q: Record<string, (...args: unknown[]) => unknown> = {};
  for (const op of ["update", "eq", "lt", "neq"]) {
    q[op] = (...args: unknown[]) => { calls.push({ op, args }); return q; };
  }
  q.select = () => Promise.resolve(updateResult);
  return q;
}

jest.mock("@/lib/supabase/server", () => ({
  createServerClient: () => ({
    from: () => listingsQuery(),
    rpc: (...args: unknown[]) => rpc(...args),
    storage: { from: () => ({ remove: (...args: unknown[]) => remove(...args) }) },
  }),
}));

import { clearOldLivePhotos, removeUnusedPhotos, LIVE_PHOTO_DAYS, UNUSED_PHOTO_DAYS } from "@/lib/listings/retention";

beforeEach(() => {
  calls.length = 0;
  rpc.mockReset();
  remove.mockReset();
  remove.mockResolvedValue({ data: [], error: null });
});

describe("clearOldLivePhotos", () => {
  it("empties photos only on live listings untouched for 30 days that still have some", async () => {
    updateResult = { data: [{ id: "a" }, { id: "b" }], error: null };
    const now = Date.parse("2026-10-31T00:00:00Z");

    expect(await clearOldLivePhotos(now)).toBe(2);

    expect(LIVE_PHOTO_DAYS).toBe(30);
    expect(calls).toEqual([
      { op: "update", args: [{ images: [], image_variants: null }] },
      { op: "eq",     args: ["status", "live"] },
      { op: "lt",     args: ["updated_at", "2026-10-01T00:00:00.000Z"] },
      { op: "neq",    args: ["images", "{}"] },
    ]);
  });

  it("reports a failure instead of pretending nothing was due", async () => {
    updateResult = { data: null, error: { message: "timeout" } };
    await expect(clearOldLivePhotos()).rejects.toThrow("timeout");
  });
});

describe("removeUnusedPhotos", () => {
  const names = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ name: `user_1/${from + i}.jpg` }));

  it("deletes the files stale_product_photos() finds, a batch at a time", async () => {
    rpc
      .mockResolvedValueOnce({ data: names(500), error: null })
      .mockResolvedValueOnce({ data: names(3, 500), error: null });

    expect(await removeUnusedPhotos()).toBe(503);

    expect(UNUSED_PHOTO_DAYS).toBe(7);
    expect(rpc).toHaveBeenCalledWith("stale_product_photos", { older_than: "7 days", max_rows: 500 });
    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove.mock.calls[1][0]).toEqual(["user_1/500.jpg", "user_1/501.jpg", "user_1/502.jpg"]);
  });

  it("does nothing when every photo is in use", async () => {
    rpc.mockResolvedValueOnce({ data: [], error: null });
    expect(await removeUnusedPhotos()).toBe(0);
    expect(remove).not.toHaveBeenCalled();
  });

  it("stops at the first storage error", async () => {
    rpc.mockResolvedValueOnce({ data: names(2), error: null });
    remove.mockResolvedValueOnce({ data: null, error: { message: "forbidden" } });
    await expect(removeUnusedPhotos()).rejects.toThrow("forbidden");
  });
});
