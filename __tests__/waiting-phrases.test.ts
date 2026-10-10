import { waitPhrases, waitTopic } from "@/components/assistant/waiting-phrases";

describe("web chat waiting phrases", () => {
  it("picks the phrases by what the seller asked", () => {
    expect(waitTopic("what's out of stock?")).toBe("stock");
    expect(waitTopic("How many orders did I get this week?")).toBe("orders");
    expect(waitTopic("when is my next payout")).toBe("payouts");
    expect(waitTopic("change the blender's price to 300")).toBe("change");
    expect(waitTopic("I want to list 3 products")).toBe("listing");
    expect(waitTopic("give me insight on my shop")).toBe("report");
    expect(waitTopic("fix my rejected products")).toBe("rejected");
    expect(waitTopic("polish 2")).toBe("polish");
    expect(waitTopic("hello")).toBe("general");
    expect(waitTopic(null, { photos: true })).toBe("photos");
    expect(waitTopic("blender 250", { photos: true })).toBe("photos");
    expect(waitTopic(null, { form: true })).toBe("listing");
  });

  it("starts with the topic's own phrases and ends with general ones", () => {
    const stock = waitPhrases("stock");
    expect(stock[0]).toBe("Opening the shop");
    expect(stock).toContain("Counting inventory");
    expect(stock).toContain("Hang tight");
    expect(new Set(stock).size).toBe(stock.length);
    expect(waitPhrases("general")[0]).toBe("On it");
  });
});
