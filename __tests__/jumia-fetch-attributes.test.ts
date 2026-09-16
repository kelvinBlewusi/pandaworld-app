/**
 * fetchAttributesFromJumia against the corrected GET
 * /catalog/attribute-sets/{sid} response shape (Jumia's own 2026-09-16
 * doc changelog). The original Postman spec this was written against was
 * wrong on both points under test here:
 *
 *   - `validations` is a single OBJECT, not an array
 *   - its keys are lowercase (minLength, maxLength, ...), not
 *     capitalised (MinLength, MaxLength, ...)
 *
 * Reading `validations[0].MinLength` off the real shape is
 * `undefined[0].undefined` — silently null every time. min_length and
 * max_length have never actually held a value in production; this file
 * pins the fix so it can't regress back to the wrong shape.
 */

import { fetchAttributesFromJumia } from "@/lib/jumia/categories";

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

function mockJsonResponse(status: number, body: unknown) {
  global.fetch = jest.fn(async () => ({
    ok:     status >= 200 && status < 300,
    status,
    json:   async () => body,
  })) as unknown as typeof fetch;
}

describe("fetchAttributesFromJumia — validations shape", () => {
  it("reads length bounds from the real shape: a single object, lowercase keys", () => {
    return (async () => {
      mockJsonResponse(200, {
        attributes: [{
          name: "model_name", description: "Model name", type: "TEXT",
          mandatory: true, variation: false, sid: "abc",
          validations: { minLength: 3, maxLength: 60 },
        }],
      });
      const attrs = await fetchAttributesFromJumia("token", "sid-1");
      expect(attrs[0].min_length).toBe(3);
      expect(attrs[0].max_length).toBe(60);
    })();
  });

  it("still reads the originally-documented (array, capitalised) shape defensively", async () => {
    mockJsonResponse(200, {
      attributes: [{
        name: "model_name", description: "Model name", type: "TEXT",
        mandatory: true, variation: false, sid: "abc",
        validations: [{ MinLength: 3, MaxLength: 60 }],
      }],
    });
    const attrs = await fetchAttributesFromJumia("token", "sid-1");
    expect(attrs[0].min_length).toBe(3);
    expect(attrs[0].max_length).toBe(60);
  });

  it("returns null bounds rather than throwing when validations is absent", async () => {
    mockJsonResponse(200, {
      attributes: [{ name: "model_name", type: "TEXT", mandatory: false, variation: false }],
    });
    const attrs = await fetchAttributesFromJumia("token", "sid-1");
    expect(attrs[0].min_length).toBeNull();
    expect(attrs[0].max_length).toBeNull();
  });

  it("maps a NUMBER_FLOAT attribute to number end to end", async () => {
    mockJsonResponse(200, {
      attributes: [{ name: "weight_ratio", type: "NUMBER_FLOAT", mandatory: false, variation: false }],
    });
    const attrs = await fetchAttributesFromJumia("token", "sid-1");
    expect(attrs[0].type).toBe("number");
  });
});

describe("fetchAttributesFromJumia — error handling", () => {
  it("throws on a non-auth failure instead of silently returning an empty schema", async () => {
    // The Catalog service's real error shape, per the corrected doc:
    // { code, message } — not the { data: [...] } wrapper this endpoint
    // was originally documented with.
    mockJsonResponse(500, { code: "ATTR_SET_LOOKUP_FAILED", message: "Internal error" });
    await expect(fetchAttributesFromJumia("token", "sid-1")).rejects.toThrow(/500.*Internal error.*ATTR_SET_LOOKUP_FAILED/);
  });

  // The caller (fetchAndCacheCategoryTree) treats a thrown error as a
  // transient soft-fail and an empty array as "this category genuinely
  // has zero attributes" — worth downgrading out of the picker. Before
  // this fix, both a real 500 and a genuinely-empty schema returned []
  // identically, so a transient failure could wrongly downgrade a
  // perfectly listable category.
  it("still throws on 401/403 with the pre-existing auth-failure message", async () => {
    mockJsonResponse(401, {});
    await expect(fetchAttributesFromJumia("token", "sid-1")).rejects.toThrow(/JUMIA_AUTH_FAILED/);
  });

  it("returns an empty array (not a throw) for a genuinely empty 200 response", async () => {
    mockJsonResponse(200, { attributes: [] });
    await expect(fetchAttributesFromJumia("token", "sid-1")).resolves.toEqual([]);
  });
});
