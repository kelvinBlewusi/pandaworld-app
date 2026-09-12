import { endsWithDoneSignal, stripDoneSignal, formatDraftSummary } from "@/lib/whatsapp/draft";
import type { AutoAnalyzeResult } from "@/lib/actions/auto-analyze";

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

describe("formatDraftSummary", () => {
  const okResult: Extract<AutoAnalyzeResult, { ok: true }> = {
    ok: true,
    timings: { total_ms: 1234 },
    description: {} as never,
    category: { code: 123, name: "Blenders", path: "Home > Kitchen > Blenders", confidence: 0.9 },
    alternates: [],
    needsUserConfirmation: false,
    candidates_considered: 6,
    attributes_in_schema: 10,
    attributes_filled: 7,
    variations_detected: 0,
    title: "Panda 5L Blender",
    brand: "Panda",
  };

  it("includes the title, category path, and attribute count", () => {
    const text = formatDraftSummary(okResult, "abc-123");
    expect(text).toContain("Panda 5L Blender");
    expect(text).toContain("Home > Kitchen > Blenders");
    expect(text).toContain("7 attribute(s) filled in automatically");
  });

  it("never claims a price or stock value — those are seller-owned", () => {
    const text = formatDraftSummary(okResult, "abc-123");
    expect(text.toLowerCase()).toContain("can't guess your price or stock");
  });

  it("links to the listing's review page", () => {
    const text = formatDraftSummary(okResult, "abc-123");
    expect(text).toContain("/listings/abc-123/review");
  });

  it("falls back to a placeholder when title is missing", () => {
    const text = formatDraftSummary({ ...okResult, title: null as unknown as string }, "abc-123");
    expect(text).toContain("(untitled)");
  });
});
