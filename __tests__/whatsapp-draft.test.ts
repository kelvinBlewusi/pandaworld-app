import { endsWithDoneSignal, stripDoneSignal, isProductNumber } from "@/lib/whatsapp/draft";

describe("endsWithDoneSignal", () => {
  it("matches the bare word", () => {
    expect(endsWithDoneSignal("done")).toBe(true);
  });

  it("is case-insensitive and tolerates trailing punctuation", () => {
    expect(endsWithDoneSignal("Done")).toBe(true);
    expect(endsWithDoneSignal("DONE!")).toBe(true);
    expect(endsWithDoneSignal("done.")).toBe(true);
  });

  it("tolerates surrounding whitespace", () => {
    expect(endsWithDoneSignal("  done  ")).toBe(true);
  });

  it("matches a caption/note that ENDS with done, e.g. a price note", () => {
    expect(endsWithDoneSignal("Price 40\nDone")).toBe(true);
    expect(endsWithDoneSignal("sizes M L XL, done")).toBe(true);
    expect(endsWithDoneSignal("this is a pack of 6. Done!")).toBe(true);
  });

  it("does not match messages where 'done' isn't the last word", () => {
    expect(endsWithDoneSignal("done with the photos, one more coming")).toBe(false);
    expect(endsWithDoneSignal("not done yet")).toBe(false);
    expect(endsWithDoneSignal("this design is done by hand, very detailed")).toBe(false);
    expect(endsWithDoneSignal("")).toBe(false);
  });
});

describe("stripDoneSignal", () => {
  it("removes a trailing done, keeping the rest of the note", () => {
    expect(stripDoneSignal("Price 40\nDone")).toBe("Price 40");
    expect(stripDoneSignal("sizes M L XL, done")).toBe("sizes M L XL,");
  });

  it("returns an empty string when the whole text was just the done-signal", () => {
    expect(stripDoneSignal("done")).toBe("");
    expect(stripDoneSignal("Done!")).toBe("");
  });
});

describe("isProductNumber", () => {
  it("is one of the batch's product numbers, alone", () => {
    expect(isProductNumber("2", 3)).toBe(true);
    expect(isProductNumber(" #3 ", 3)).toBe(true);
    expect(isProductNumber("1.", 1)).toBe(true);
  });

  it("isn't a number outside the batch, or anything with more in it", () => {
    expect(isProductNumber("4", 3)).toBe(false);
    expect(isProductNumber("0", 3)).toBe(false);
    expect(isProductNumber("169", 3)).toBe(false);
    expect(isProductNumber("2 pieces", 3)).toBe(false);
    expect(isProductNumber("price 2", 3)).toBe(false);
  });
});
