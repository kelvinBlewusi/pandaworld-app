/**
 * Owner, 2026-10-09: details Jumia locks after approval said plainly, fixing
 * rejected products from the chat, a new size and more photos for a live
 * product.
 */

const upserts: unknown[] = [];
jest.mock("@/lib/supabase/server", () => ({
  createServerClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { value: ["warranty_type"] } }) }) }),
      upsert: (row: unknown) => { upserts.push(row); return Promise.resolve({ error: null }); },
    }),
  }),
}));

import { detailWord, lockedDetailIn, lockedDetails, lockedText } from "@/lib/jumia/locked-details";
import { explainRefusal } from "@/lib/whatsapp/shop-notices";
import { fieldsFor, fixPlan, parseFixTap } from "@/lib/whatsapp/fix-rejected";
import { newVariationItem, newVariationSku, withImages, type ProductSet } from "@/lib/jumia/shop";
import { variantAxis } from "@/lib/whatsapp/shop";
import { parseAction, assistantLinks } from "@/lib/whatsapp/assistant";
import { CAPABILITIES, cannotList } from "@/lib/jumia/capabilities";
import type { JumiaCategoryAttribute } from "@/lib/jumia/categories";

const FAN_REFUSAL = "The [color] cannot be updated since the product has been already approved in at least one country.";

describe("details Jumia locks once a product is approved", () => {
  it("reads the detail from Jumia's refusal", () => {
    expect(lockedDetailIn(FAN_REFUSAL)).toBe("color");
    expect(lockedDetailIn("The [color_family] cannot be updated since the product has already been approved")).toBe("color_family");
    expect(lockedDetailIn("Invalid value for [color]")).toBeNull();
    expect(lockedDetailIn(null)).toBeNull();
  });

  it("says it the way a seller can act on", () => {
    expect(detailWord("color")).toBe("colour");
    expect(detailWord("color_family", "Color Family")).toBe("colour");
    expect(detailWord("main_material", "Main Material")).toBe("main material");
    expect(lockedText("colour", "white")).toBe(
      "Jumia doesn't let a product's colour change once its quality check has approved it. To sell one in white, list it as a new product, or ask Jumia's seller support to correct this one.",
    );
  });

  it("the neck fan's refusal comes out plainly, and a new locked detail is kept", async () => {
    const said = await explainRefusal(FAN_REFUSAL, { kind: "content", fields: { attributes: [{ name: "color", label: "Color", value: "white" }] } });
    expect(said).toContain("Jumia doesn't let a product's colour change once its quality check has approved it");
    expect(said).toContain("To sell one in white");
    expect(said).not.toContain("[color]");
    expect(await explainRefusal("Price is too low", null)).toBe("Price is too low");
    // Known from the first refusal and from what was kept; a new one is kept for every seller.
    const known = await lockedDetails();
    expect(known.has("color")).toBe(true);
    expect(known.has("warranty_type")).toBe(true);
    await explainRefusal("The [model] cannot be updated since the product has been already approved in at least one country.", null);
    expect(upserts).toContainEqual(expect.objectContaining({ key: "jumia_locked_attributes", value: expect.arrayContaining(["color", "model", "warranty_type"]) }));
  });

  it("is on the list of what isn't possible", () => {
    expect(cannotList()).toContain("- locked_details:");
    expect(CAPABILITIES.find((c) => c.id === "add_size")?.status).toBe("chat");
    expect(CAPABILITIES.find((c) => c.id === "extra_photos")?.status).toBe("chat");
    expect(CAPABILITIES.find((c) => c.id === "fix_rejected")?.status).toBe("chat");
  });
});

describe("fixing a rejected product from the chat", () => {
  it("rewrites what Jumia's reason is about", () => {
    expect(fieldsFor("Wrong Title: the name doesn't say what it is")).toEqual(["name"]);
    expect(fieldsFor("Wrong Description")).toEqual(["description"]);
    expect(fieldsFor("Poor quality content")).toEqual(["name", "description"]);
    const plan = fixPlan({ kind: "redraft", why: "Jumia's quality check rejected it (Wrong Title)." }, "Portable USB Neck Fan – 360°", "Wrong Title");
    expect(plan).toMatchObject({ kind: "rewrite", fields: ["name"], instructions: expect.stringContaining("Wrong Title") });
  });

  it("asks for what only the seller knows, in the words that change it", () => {
    const brand = fixPlan({ kind: "ask_brand", why: " (Wrong Brand)" }, "Portable USB Neck Fan – 360°", "Wrong Brand");
    expect(brand).toMatchObject({ kind: "say", text: expect.stringContaining("change the portable usb neck fan's brand to") });
    const value = fixPlan({ kind: "ask_value", field: "fda_number", fieldLabel: "FDA Number", question: "What is its FDA registration number?" }, "Shea Butter Cream", "");
    expect(value).toMatchObject({ kind: "say", text: expect.stringContaining("the shea butter cream's fda number is") });
  });

  it("says plainly what Jumia's API can't change, with Vendor Center", () => {
    for (const action of [
      { kind: "ask_photos", why: "" }, { kind: "switch_category", path: "Home > Fans" }, { kind: "ask_category" }, { kind: "ask_price", why: "" }, { kind: "ask_details" },
    ] as const) {
      expect(fixPlan(action, "Neck Fan", "")).toMatchObject({ kind: "say", vendorCenter: true });
    }
    expect(fixPlan({ kind: "ask_details" }, "Neck Fan", "")).toMatchObject({ text: expect.stringContaining("fix the neck fan: <the reason>") });
  });

  it("knows a tap on the list", () => {
    expect(parseFixTap("qcfix:NF-001")).toBe("NF-001");
    expect(parseFixTap("fix:abc")).toBeNull();
    expect(parseFixTap("fix my products")).toBeNull();
  });
});

const attr = (name: string, label: string, extra: Partial<JumiaCategoryAttribute> = {}): JumiaCategoryAttribute => ({
  name, label, type: "string", allowed_values: [], required: false, is_variant: false, ...extra,
});
const GOWN: ProductSet = {
  id: "set-1", name: "Satin Gown", description: "<p>Soft satin.</p>", parentSku: "GOWN", brand: { code: 1, name: "Generic" }, category: { code: 10, name: "Dresses" },
  images: [{ url: "https://img/2.jpg", primary: false }, { url: "https://img/1.jpg", primary: true }],
  attributes: [{ name: "main_material", value: "Satin" }],
  variations: [
    { id: "v1", sellerSku: "GOWN-M", variation: "M", barcode: null, attributes: [{ name: "size", value: "M" }, { name: "color", value: "Black" }] },
    { id: "v2", sellerSku: "GOWN-L", variation: "L", barcode: null, attributes: [{ name: "size", value: "L" }, { name: "color", value: "Black" }] },
  ],
};

describe("a new size for a live product", () => {
  it("gets its own SKU under the parent", () => {
    expect(newVariationSku("GOWN", "XL", ["GOWN-M", "GOWN-L"])).toBe("GOWN-XL");
    expect(newVariationSku("GOWN", "XL", ["GOWN-XL"])).toBe("GOWN-XL-2");
    expect(newVariationSku("GOWN", "EU 42 / UK 8", [])).toBe("GOWN-EU-42-UK-8");
  });

  it("finds the size detail its sizes use", () => {
    const attrs = [attr("color", "Color", { is_variant: true, allowed_values: ["Black", "White"] }), attr("size", "Size", { is_variant: true, allowed_values: ["S", "M", "L", "XL"] })];
    expect(variantAxis(attrs, GOWN)?.name).toBe("size");
  });

  it("is the whole product with its new size, stock and price", () => {
    const item = newVariationItem(GOWN, { kind: "add_variation", variation: "XL", sellerSku: "GOWN-XL", price: 150, stock: 4, axis: "size" }, "GHS") as Record<string, unknown>;
    expect(item).toMatchObject({
      parentSku: "GOWN", sellerSku: "GOWN-XL", variation: "XL", name: { value: "Satin Gown" }, brand: { code: 1 }, category: { code: 10 },
      price: { value: 150, currency: "GHS" }, stock: 4,
    });
    const attrs = item.attributes as { name: string; value: string }[];
    expect(attrs).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "variation", value: "XL" }), expect.objectContaining({ name: "size", value: "XL" }),
      expect.objectContaining({ name: "color", value: "Black" }), expect.objectContaining({ name: "main_material", value: "Satin" }),
    ]));
    expect(attrs.filter((a) => a.name === "size")).toHaveLength(1);
    expect(newVariationItem(GOWN, { kind: "add_variation", variation: "M", sellerSku: "X", price: 1, stock: 1, axis: "size" }, "GHS")).toBe("It already has M");
  });

  it("the AI's size, stock and price are kept only when they're in the message", () => {
    const links = assistantLinks();
    expect(parseAction('{"type":"add_size","product":"gown","size":"XL","stock":4,"price":150}', "add size XL to the gown, 4 pieces at 150", [], links))
      .toEqual({ type: "add_size", product: "gown", request: { size: "XL", stock: 4, price: 150 } });
    expect(parseAction('{"type":"add_size","product":"gown","size":"XL","stock":5,"price":200}', "add XL to the gown", [], links))
      .toEqual({ type: "add_size", product: "gown", request: { size: "XL", stock: null, price: null } });
    expect(parseAction('{"type":"add_size","product":"gown","size":"XXL","stock":null,"price":null}', "add a bigger size to the gown", [], links))
      .toMatchObject({ type: "reply" });
  });
});

describe("more photos for a live product", () => {
  it("keeps its main photo first and adds the new ones after, up to 8", () => {
    const out = withImages(GOWN.images, ["https://new/a.jpg", "https://img/2.jpg", "https://new/b.jpg"]);
    expect(out.map((i) => i.url)).toEqual(["https://img/1.jpg", "https://img/2.jpg", "https://new/a.jpg", "https://new/b.jpg"]);
    expect(out.map((i) => i.primary)).toEqual([true, false, false, false]);
    expect(withImages(GOWN.images, Array.from({ length: 10 }, (_, i) => `https://new/${i}.jpg`))).toHaveLength(8);
    expect(withImages(GOWN.images, undefined)).toBe(GOWN.images);
  });

  it("the action needs the product named", () => {
    const links = assistantLinks();
    expect(parseAction('{"type":"add_photos","product":"neck fan"}', "I want to add more pictures to the neck fan", [], links)).toEqual({ type: "add_photos", product: "neck fan" });
    expect(parseAction('{"type":"add_photos","product":"blender"}', "add more pictures", [], links)).toMatchObject({ type: "reply" });
  });

  it("fix_rejected keeps only what was said", () => {
    const links = assistantLinks();
    expect(parseAction('{"type":"fix_rejected","product":null,"reason":null}', "can you fix my rejected products?", [], links))
      .toEqual({ type: "fix_rejected", product: null, reason: null });
    expect(parseAction('{"type":"fix_rejected","product":"neck fan","reason":"Wrong Title, the name doesn\'t say what it is"}',
      "fix the neck fan: Wrong Title, the name doesn't say what it is", [], links))
      .toEqual({ type: "fix_rejected", product: "neck fan", reason: "Wrong Title, the name doesn't say what it is" });
    expect(parseAction('{"type":"fix_rejected","product":"neck fan","reason":"Blurry photos"}', "fix the neck fan", [], links))
      .toEqual({ type: "fix_rejected", product: "neck fan", reason: null });
  });
});
