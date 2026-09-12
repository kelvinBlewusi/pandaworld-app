import { looksActionable } from "@/lib/whatsapp/intent";

describe("looksActionable", () => {
  it("matches text containing a product number", () => {
    expect(looksActionable("go ahead with 2")).toBe(true);
    expect(looksActionable("the second one, 2")).toBe(true);
  });

  it("matches text containing a recognizable action word", () => {
    expect(looksActionable("go ahead and push everything")).toBe(true);
    expect(looksActionable("please submit")).toBe(true);
    expect(looksActionable("change the price")).toBe(true);
  });

  it("does not match plain chit-chat with no number or action word", () => {
    expect(looksActionable("thanks")).toBe(false);
    expect(looksActionable("ok")).toBe(false);
    expect(looksActionable("cool, looks great")).toBe(false);
  });

  it("does not match confused/off-topic replies that used to misfire as edit attempts on a 1-product batch", () => {
    // Confirmed live: these were each getting sent to handleEdit as an
    // "edit product 1" instruction on a single-product batch, because
    // parseEditCommand's implicit fallback matches ANY text — looksActionable
    // is now the gate intake.ts uses to catch these instead.
    expect(looksActionable("Hi")).toBe(false);
    expect(looksActionable("New listing")).toBe(false);
    expect(looksActionable("New product")).toBe(false);
    expect(looksActionable("Done")).toBe(false);
    expect(looksActionable("Are you done?")).toBe(false);
    expect(looksActionable("Delete")).toBe(false);
  });
});
