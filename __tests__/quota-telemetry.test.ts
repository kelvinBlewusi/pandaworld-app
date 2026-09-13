import { isQuotaError, trackGeminiCall, readGeminiTelemetry } from "@/lib/ai/quota-telemetry";

// This classifier is the whole point of the telemetry: before it, a quota
// rejection and a "that model doesn't exist" rejection produced identical
// log lines, so the one failure meaning "the project is at its ceiling"
// was indistinguishable from routine model drift.
describe("isQuotaError", () => {
  it("recognises the shapes both SDKs actually throw", () => {
    // Vertex
    expect(isQuotaError(new Error("[VertexAI.ClientError]: got status: 429 Too Many Requests"))).toBe(true);
    // AI Studio
    expect(isQuotaError(new Error("[GoogleGenerativeAI Error]: [429 Too Many Requests] Resource has been exhausted"))).toBe(true);
    expect(isQuotaError(new Error("RESOURCE_EXHAUSTED: Quota exceeded for aiplatform.googleapis.com"))).toBe(true);
    expect(isQuotaError(new Error("Rate limit exceeded for this project"))).toBe(true);
  });

  it("does not mistake ordinary model drift for a quota problem", () => {
    // The failure the fallback chain exists for — must stay distinct, or
    // the counter measures nothing.
    expect(isQuotaError(new Error("[404 Not Found] models/gemini-3.5-flash-lite is not found"))).toBe(false);
    expect(isQuotaError(new Error("Could not download any of the 3 images for analysis"))).toBe(false);
    expect(isQuotaError(new Error("400 Bad Request: invalid argument"))).toBe(false);
  });

  it("handles non-Error rejections without throwing", () => {
    expect(isQuotaError("got status: 429")).toBe(true);
    expect(isQuotaError(null)).toBe(false);
    expect(isQuotaError(undefined)).toBe(false);
  });
});

describe("trackGeminiCall", () => {
  it("returns the call's value and leaves nothing in flight", async () => {
    const before = readGeminiTelemetry();
    await expect(trackGeminiCall(async () => "ok")).resolves.toBe("ok");
    const after = readGeminiTelemetry();
    expect(after.calls).toBe(before.calls + 1);
    expect(after.inFlight).toBe(0);
  });

  it("rethrows untouched — it observes, it never changes behaviour", async () => {
    const boom = new Error("got status: 429");
    await expect(trackGeminiCall(async () => { throw boom; })).rejects.toBe(boom);
    expect(readGeminiTelemetry().inFlight).toBe(0);
  });

  it("counts a quota rejection but not an ordinary failure", async () => {
    const before = readGeminiTelemetry().quotaErrors;
    await expect(trackGeminiCall(async () => { throw new Error("404 Not Found"); })).rejects.toThrow();
    expect(readGeminiTelemetry().quotaErrors).toBe(before);

    await expect(trackGeminiCall(async () => { throw new Error("RESOURCE_EXHAUSTED"); })).rejects.toThrow();
    expect(readGeminiTelemetry().quotaErrors).toBe(before + 1);
  });

  it("records peak concurrency — the number that decides the fan-out", async () => {
    // 3 workers x CLAIM_LIMIT 3 x ~4 passes is a burst of roughly 36, and
    // nothing has ever confirmed the project tolerates that. Peak has to
    // survive the calls completing, or it can't be read after the fact.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });

    const inflight = [1, 2, 3, 4].map(() => trackGeminiCall(async () => { await gate; return 1; }));
    expect(readGeminiTelemetry().inFlight).toBe(4);

    release();
    await Promise.all(inflight);

    expect(readGeminiTelemetry().inFlight).toBe(0);
    expect(readGeminiTelemetry().peakInFlight).toBeGreaterThanOrEqual(4);
  });
});
