/**
 * Reading a seller's reply as the value of a field their product is held
 * without (lib/whatsapp/missing-value.ts).
 */

jest.mock("@/lib/supabase/server", () => ({ createServerClient: () => ({}) }));
jest.mock("@/lib/actions/ai", () => ({ extractAttributesForCategory: async () => ({ dynamic_attributes: {} }) }));

import { missingValueQuestion, parseMissingValue } from "@/lib/whatsapp/missing-value";
import type { JumiaCategoryAttribute } from "@/lib/jumia/categories";

const attr = (patch: Partial<JumiaCategoryAttribute>): JumiaCategoryAttribute => ({
  name: "x", label: "X", type: "string", allowed_values: [], required: true, is_variant: false, ...patch,
});
const WEIGHT = attr({ name: "product_weight", label: "Weight (kg)" });

describe("parseMissingValue", () => {
  it.each([
    ["0.5", "0.5"],
    ["0.5kg", "0.5"],
    ["1,5 kg", "1.5"],
    ["500g", "0.5"],
    ["about 2 kilograms", "2"],
  ])("reads the weight %s as %s kg", (text, value) => {
    expect(parseMissingValue(WEIGHT, text)).toEqual({ ok: true, value });
  });

  it("asks again for a weight it can't read", () => {
    expect(parseMissingValue(WEIGHT, "heavy")).toEqual({ ok: false, hint: expect.stringContaining("weight in kg") });
    expect(parseMissingValue(WEIGHT, "0")).toMatchObject({ ok: false });
  });

  it("needs a whole number where Jumia does", () => {
    const pieces = attr({ name: "pieces", label: "Pieces", type: "number", decimal_places: 0 });
    expect(parseMissingValue(pieces, "2.5")).toMatchObject({ ok: false });
    expect(parseMissingValue(pieces, "3")).toEqual({ ok: true, value: "3" });
  });

  it("takes one of a field's allowed values, typed or tapped", () => {
    const gender = attr({ name: "gender", label: "Gender", type: "enum", allowed_values: ["Female", "Male", "Unisex"] });
    expect(parseMissingValue(gender, "female")).toEqual({ ok: true, value: "Female" });
    expect(parseMissingValue(gender, "uni")).toEqual({ ok: true, value: "Unisex" });
    expect(parseMissingValue(gender, "value:1")).toEqual({ ok: true, value: "Male" });
    expect(parseMissingValue(gender, "kids")).toEqual({ ok: false, hint: "Pick one of: Female, Male, Unisex." });
  });

  it("takes text as written, within the field's limit", () => {
    const model = attr({ name: "model", label: "Model", max_length: 5 });
    expect(parseMissingValue(model, "  AB-1234 ")).toEqual({ ok: true, value: "AB-12" });
  });
});

describe("missingValueQuestion", () => {
  it("asks for a weight in kg, with a skip", () => {
    const q = missingValueQuestion(WEIGHT, "Product 1 — Shower Cream");
    expect(q.body).toBe("📝 *Product 1 — Shower Cream*\n\nJumia needs its *Weight (kg)* before it can be listed. Reply with the weight in kg, e.g. *0.5*.");
    expect(q.options.map((o) => o.id)).toEqual(["skip value"]);
  });

  it("lists a field's allowed values to tap when they fit", () => {
    const q = missingValueQuestion(attr({ label: "Gender", allowed_values: ["Female", "Male"] }), "Wig");
    expect(q.options.map((o) => o.id)).toEqual(["value:0", "value:1", "skip value"]);
  });
});
