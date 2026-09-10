import { isDoneMessage, formatDraftSummary } from "@/lib/whatsapp/draft";
import type { AutoAnalyzeResult } from "@/lib/actions/auto-analyze";

describe("isDoneMessage", () => {
  it("matches the bare word", () => {
    expect(isDoneMessage("done")).toBe(true);
  });

  it("is case-insensitive and tolerates trailing punctuation", () => {
    expect(isDoneMessage("Done")).toBe(true);
    expect(isDoneMessage("DONE!")).toBe(true);
    expect(isDoneMessage("done.")).toBe(true);
  });

  it("tolerates surrounding whitespace", () => {
    expect(isDoneMessage("  done  ")).toBe(true);
  });

  it("does not match other messages", () => {
    expect(isDoneMessage("done with the photos, one more coming")).toBe(false);
    expect(isDoneMessage("not done yet")).toBe(false);
    expect(isDoneMessage("")).toBe(false);
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
