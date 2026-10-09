/**
 * What sellers can and can't ask of their Jumia shop (lib/jumia/capabilities.ts),
 * how the assistant answers what isn't possible, and a live product's other
 * details checked against its category (lib/whatsapp/live-details.ts). Owner,
 * 2026-10-09.
 */

import { CAPABILITIES, cannotAnswer, cannotList } from "@/lib/jumia/capabilities";
import { checkDetailValue, matchAttribute, resolveDetails } from "@/lib/whatsapp/live-details";
import { contentAction, parseAction, assistantLinks } from "@/lib/whatsapp/assistant";
import { feedItemResults, qcText, type ProductSet } from "@/lib/jumia/shop";
import type { JumiaCategoryAttribute } from "@/lib/jumia/categories";

const attr = (name: string, label: string, extra: Partial<JumiaCategoryAttribute> = {}): JumiaCategoryAttribute => ({
  name, label, type: "string", allowed_values: [], required: false, is_variant: false, ...extra,
});
const ATTRS = [
  attr("color", "Color", { type: "enum", allowed_values: ["Black", "White", "Blue"] }),
  attr("color_family", "Color Family", { type: "enum", allowed_values: ["Black", "White"] }),
  attr("main_material", "Main Material"),
  attr("product_weight", "Weight (kg)", { type: "number", not_zero_or_negative: true }),
  attr("size", "Size", { type: "enum", allowed_values: ["S", "M", "L", "XL"], is_variant: true }),
  attr("short_description", "Highlights"),
];
const SET: ProductSet = {
  id: "set-1", name: "Satin Gown", description: "", parentSku: "G", brand: { code: 1, name: "Generic" }, category: { code: 10, name: "Dresses" },
  images: [], attributes: [{ name: "color", value: "Black" }],
  variations: [
    { id: "v1", sellerSku: "G-M", variation: "M", barcode: null, attributes: [{ name: "size", value: "M" }] },
    { id: "v2", sellerSku: "G-L", variation: "L", barcode: null, attributes: [{ name: "size", value: "L" }] },
  ],
};

describe("the list of what's possible", () => {
  it("each entry once, every one not possible from the chat has the answer the seller gets", () => {
    const ids = CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of CAPABILITIES) {
      if (c.status === "vendor_center" || c.status === "impossible") expect({ id: c.id, answer: !!c.answer }).toEqual({ id: c.id, answer: true });
      if (c.status === "chat" || c.status === "whatsapp") expect({ id: c.id, requests: c.requests.length > 0 }).toEqual({ id: c.id, requests: true });
    }
  });

  it("the AI is told only what isn't possible, by key, and gets back the fixed answer", () => {
    expect(cannotList()).toContain("- delete_product: Delete a product");
    expect(cannotList()).not.toContain("live_stock");
    expect(cannotAnswer("delete_product")).toEqual({ text: expect.stringContaining("Jumia's API can't delete products"), link: "vendor_center" });
    expect(cannotAnswer("live_stock")).toBeNull();
    expect(cannotAnswer("made_up")).toBeNull();
  });

  it("\"cannot\" becomes that answer with its button, never the AI's own words", () => {
    const links = assistantLinks();
    expect(parseAction('{"type":"cannot","what":"delete_product"}', "delete the kettle from my shop", [], links))
      .toEqual({ type: "reply", text: expect.stringContaining("I can turn it off"), link: "vendor_center" });
    expect(parseAction('{"type":"cannot","what":"buyer_contact"}', "give me the buyer's phone number", [], links))
      .toMatchObject({ type: "reply", text: expect.stringContaining("doesn't share buyers' phone numbers"), link: null });
    expect(parseAction('{"type":"cannot","what":"teleport"}', "teleport my stock", [], links)).toEqual({ type: "unclear" });
  });
});

describe("a live product's other details", () => {
  it("their word finds the category's detail", () => {
    expect(matchAttribute("colour", ATTRS)?.name).toBe("color");
    expect(matchAttribute("color family", ATTRS)?.name).toBe("color_family");
    expect(matchAttribute("material", ATTRS)?.name).toBe("main_material");
    expect(matchAttribute("weight", ATTRS)?.name).toBe("product_weight");
    // Highlights and the like have their own way; nothing made up matches.
    expect(matchAttribute("highlights", ATTRS)).toBeNull();
    expect(matchAttribute("battery", ATTRS)).toBeNull();
  });

  it("the value Jumia takes, or what it takes instead", () => {
    expect(checkDetailValue(ATTRS[0], "white")).toEqual({ ok: true, value: "White" });
    expect(checkDetailValue(ATTRS[0], "purple")).toEqual({ ok: false, why: expect.stringContaining("It takes: Black, White, Blue") });
    expect(checkDetailValue(ATTRS[3], "2.5kg")).toEqual({ ok: true, value: "2.5" });
    expect(checkDetailValue(ATTRS[3], "heavy")).toMatchObject({ ok: false });
  });

  it("details, a barcode and a size's name as the update takes them", () => {
    expect(resolveDetails({ details: { colour: "blue", material: "satin" } }, SET, ATTRS, null)).toEqual({
      ok: true, fields: { attributes: [{ name: "color", label: "Color", value: "Blue" }, { name: "main_material", label: "Main Material", value: "satin" }] },
    });
    expect(resolveDetails({ details: { battery: "5000" } }, SET, ATTRS, null)).toEqual({ ok: false, why: expect.stringContaining("no detail called \"battery\"") });
    // Two sizes: which one's barcode?
    expect(resolveDetails({ barcode: "6001234567890" }, SET, ATTRS, null)).toEqual({ ok: false, why: expect.stringContaining("which one's barcode") });
    expect(resolveDetails({ barcode: "6001234567890" }, SET, ATTRS, "G-L")).toEqual({ ok: true, fields: { variations: [{ sellerSku: "G-L", barcode: "6001234567890" }] } });
    expect(resolveDetails({ size: { from: "M", to: "xl" } }, SET, ATTRS, null)).toEqual({ ok: true, fields: { variations: [{ sellerSku: "G-M", variation: "XL" }] } });
    expect(resolveDetails({ size: { from: "M", to: "L" } }, SET, ATTRS, null)).toEqual({ ok: false, why: "It already has a variation called L." });
    expect(resolveDetails({ size: { from: "M", to: "Medium" } }, SET, ATTRS, null)).toEqual({ ok: false, why: expect.stringContaining("It takes: S, M, L, XL") });
  });

  it("the AI's details are kept only when the value is in the message", () => {
    expect(contentAction({ type: "content_change", product: "neck fan", details: { colour: "white", material: "plastic" } }, "the neck fan's colour is white and it's plastic", ""))
      .toEqual({ type: "content_change", product: "neck fan", request: { details: { colour: "white", material: "plastic" } } });
    expect(contentAction({ type: "content_change", product: "neck fan", details: { colour: "red" } }, "change the neck fan's colour", ""))
      .toMatchObject({ type: "reply" });
    expect(contentAction({ type: "content_change", product: "gown", size: { from: "M", to: "Medium" } }, "rename size M of the gown to Medium", ""))
      .toEqual({ type: "content_change", product: "gown", request: { size: { from: "M", to: "Medium" } } });
    expect(contentAction({ type: "content_change", product: "kettle", barcode: "6001234567890" }, "the kettle's barcode is 600 1234 567890", ""))
      .toEqual({ type: "content_change", product: "kettle", request: { barcode: "6001234567890" } });
  });
});

describe("what Jumia says, in full", () => {
  it("the quality check's reason with its comment, once", () => {
    expect(qcText("Poor image quality", "Main image has a watermark")).toBe("Poor image quality: Main image has a watermark");
    expect(qcText("Poor image quality", null)).toBe("Poor image quality");
    expect(qcText(null, "Wrong category")).toBe("Wrong category");
    expect(qcText("Wrong category", "Wrong category: use Phones")).toBe("Wrong category: use Phones");
  });

  it("a refused change gives each country's message too", () => {
    const r = feedItemResults({ feedItems: [{ status: "FAILED", sellerSKU: "K-1", errors: { globalMessages: [], businessClients: [{ code: "jumia-gh", messages: ["Price is lower than the minimum"] }] } }] });
    expect(r.get("K-1")).toEqual({ failed: true, error: "Price is lower than the minimum" });
  });
});
