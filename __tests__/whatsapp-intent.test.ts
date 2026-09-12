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
});
