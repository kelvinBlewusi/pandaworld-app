/**
 * Deciding what to do about a Jumia quality-check rejection
 * (lib/jumia/qc-remedy.ts): Jumia's known reasons from a table, anything
 * else from the AI, and never a redraft for a fact only the seller has.
 */

let aiReply: string | Error = "{}";
const aiPrompts: string[] = [];
jest.mock("@/lib/ai/gemini-client", () => ({
  callGeminiBackend: async (_model: string, parts: { text: string }[]) => {
    aiPrompts.push(parts[0].text);
    if (aiReply instanceof Error) throw aiReply;
    return { text: aiReply, model: "m", backend: "vertex" };
  },
}));

import { decideQcAction, qcActionFromAi, qcActionFromTable, type QcContext } from "@/lib/jumia/qc-remedy";

const FIELDS = [
  { name: "fda", label: "FDA" },
  { name: "certifications", label: "Certifications" },
  { name: "product_weight", label: "Weight (kg)" },
];
const ctx = (reason: string | null, comment: string | null, patch: Partial<QcContext> = {}): QcContext => ({
  reason, comment, title: "Collagen With Burn Dietary Supplement", brand: "Generic",
  categoryPath: "Health & Beauty > Vitamins & Dietary Supplements", fields: FIELDS, ...patch,
});

beforeEach(() => {
  aiReply = "{}";
  aiPrompts.length = 0;
});

describe("Jumia's known reasons", () => {
  // The three real 2026-09-30 rejections.
  it("switches to the category Jumia suggests", () => {
    expect(qcActionFromTable(ctx("Wrong Category",
      "Category mismatch: AI suggests Grocery / Beverages / Bottled Beverages, Water & Drink Mixes / Soft Drinks (shares 3 path segments but leaf differs)")))
      .toEqual({ kind: "switch_category", path: "Grocery > Beverages > Bottled Beverages, Water & Drink Mixes > Soft Drinks" });
  });

  it("asks for the FDA number, for the category's own FDA field", () => {
    const action = qcActionFromTable(ctx(null,
      "Kindly Provide Product's Health/Food Regulation Registration Number. (Mandatory FDA registration number is missing.)"));
    expect(action).toMatchObject({ kind: "ask_value", field: "fda", fieldLabel: "FDA" });
    expect((action as { question: string }).question).toContain("FDA registration number");
  });

  it("puts the FDA number in the description when the category has no field for it", () => {
    expect(qcActionFromTable(ctx("Missing FDA number", null, { fields: [] })))
      .toMatchObject({ kind: "ask_value", field: null, fieldLabel: "FDA registration number" });
  });

  it("asks for Vendor Center's reason when Jumia gave none", () => {
    expect(qcActionFromTable(ctx("Other Reason", "Rejected"))).toEqual({ kind: "ask_details" });
    expect(qcActionFromTable(ctx(null, null))).toEqual({ kind: "ask_details" });
  });

  // Jumia's published reason list, and what each needs.
  it.each([
    ["Poor Quality", null, "ask_photos"],
    ["Image Corrupt", null, "ask_photos"],
    ["Wrong Image", "The image does not match the product", "ask_photos"],
    ["Poor Image Quality", "Images are blurry and have a watermark", "ask_photos"],
    ["Wrong Brand", "The product image shows NIVEA, create it with the correct brand", "ask_brand"],
    ["Product Pricing", "Price is not realistic", "ask_price"],
    ["Wrong Title", null, "redraft"],
    ["Wrong Description", "The description doesn't match the product", "redraft"],
    ["Missing Information", "Please add the product dimensions", "redraft"],
    ["Wrong Category", null, "ask_category"],
    ["Brand Banned", null, "cannot_fix"],
    ["Prohibited Product", null, "cannot_fix"],
    ["Counterfeit", "Product appears to be a replica", "cannot_fix"],
    ["Duplicate Product", null, "cannot_fix"],
  ])("%s / %s → %s", (reason, comment, kind) => {
    expect(qcActionFromTable(ctx(reason, comment))?.kind).toBe(kind);
  });

  it("doesn't read 'not permitted to be sold' as a permit to ask for", () => {
    expect(qcActionFromTable(ctx(null, "This product is not permitted to be sold on Jumia"))?.kind).toBe("cannot_fix");
  });

  it("explains a banned brand with Jumia's words and what to do", () => {
    const action = qcActionFromTable(ctx("Brand Banned", null));
    expect((action as { why: string }).why).toBe(
      "Jumia doesn't let your shop sell this brand (Brand Banned). If you're an authorised seller of it, Jumia seller support can turn it on for your shop.",
    );
  });

  it("leaves a reason it doesn't know to the AI", () => {
    expect(qcActionFromTable(ctx("Packaging Issue", "Outer box must be sealed"))).toBeNull();
  });
});

describe("the AI, for reasons the table doesn't know", () => {
  it("reads its choice, keeping a field only if the category has it", async () => {
    aiReply = '{"action":"ask_value","field":"certifications","fieldLabel":"Certifications","question":"What is the product\'s safety certificate number?"}';
    expect(await qcActionFromAi(ctx("Packaging Issue", "Provide safety certificate"))).toEqual({
      kind: "ask_value", field: "certifications", fieldLabel: "Certifications",
      question: "What is the product's safety certificate number?",
    });

    aiReply = '{"action":"ask_value","field":"made_up_field","fieldLabel":"Batch number","question":"What is the batch number?"}';
    expect(await qcActionFromAi(ctx("X", "Y"))).toMatchObject({ kind: "ask_value", field: null, fieldLabel: "Batch number" });
  });

  it("gets Jumia's words, the listing and the category's fields", async () => {
    aiReply = '{"action":"redraft","why":"The highlights repeat the title"}';
    expect(await qcActionFromAi(ctx("Content Issue", "Highlights repeat the title"))).toEqual({
      kind: "redraft", why: "Jumia's quality check flagged the listing (The highlights repeat the title).",
    });
    expect(aiPrompts[0]).toContain('Rejection comment: "Highlights repeat the title"');
    expect(aiPrompts[0]).toContain("fda (FDA)");
    expect(aiPrompts[0]).toContain("Never choose redraft for a fact only the seller knows");
  });

  it("is null for an unusable answer or a failed call", async () => {
    aiReply = '{"action":"delete_everything"}';
    expect(await qcActionFromAi(ctx("X", "Y"))).toBeNull();
    aiReply = "no json here";
    expect(await qcActionFromAi(ctx("X", "Y"))).toBeNull();
    aiReply = new Error("quota");
    expect(await qcActionFromAi(ctx("X", "Y"))).toBeNull();
  });
});

describe("decideQcAction", () => {
  it("uses the table without calling the AI", async () => {
    expect(await decideQcAction(ctx("Wrong Title", null))).toEqual({ action: expect.objectContaining({ kind: "redraft" }), source: "table" });
    expect(aiPrompts).toHaveLength(0);
  });

  it("asks the AI about the rest, and redrafts once if it can't say", async () => {
    aiReply = '{"action":"ask_photos","why":"The box is open"}';
    expect(await decideQcAction(ctx("Packaging Issue", "Outer box must be sealed")))
      .toEqual({ action: { kind: "ask_photos", why: " (The box is open)" }, source: "ai" });

    aiReply = new Error("down");
    expect(await decideQcAction(ctx("Packaging Issue", "Outer box must be sealed")))
      .toEqual({ action: { kind: "redraft", why: "Jumia's quality check rejected it (Packaging Issue: Outer box must be sealed)." }, source: "fallback" });
  });
});
