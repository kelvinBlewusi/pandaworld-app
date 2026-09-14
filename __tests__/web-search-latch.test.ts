import {
  webSearch,
  isWebSearchEnabled,
  webSearchDisabledReason,
  __resetWebSearchLatch,
} from "@/lib/ai/web-search";

// Confirmed live 2026-09-14: every gap-fill was paying for a round trip to
// be told
//   403 "Requests to this API customsearch method
//        google.customsearch.v1.CustomSearchService.List are blocked."
// and swallowing it as an ordinary miss — so grounding had been silently
// off for an unknown length of time while still costing a call per
// analysis. A configuration error is not a cache miss.
// Google will not let one API key hold the Gemini API restriction AND any
// other: ticking Custom Search greys Gemini out with "Cannot be combined
// with the currently selected API restrictions", because Gemini keys must
// be bound to a service account. GOOGLE_API_KEY is the AI Studio fallback
// for generation, embeddings and extension-fill, so it physically cannot
// also be the Custom Search key — hence a separate variable.
describe("Custom Search key selection", () => {
  const realFetch = global.fetch;
  const saved = { ...process.env };
  afterEach(() => { global.fetch = realFetch; process.env = { ...saved }; });

  // Distinct query per test on purpose: webSearch caches a successful
  // result for an hour keyed by the query, so a shared string would give
  // the next test a cache hit and no fetch to inspect.
  function captureKey() {
    const seen: string[] = [];
    global.fetch = (async (url: string) => {
      seen.push(new URL(String(url)).searchParams.get("key") ?? "");
      return { ok: true, status: 200, json: async () => ({ items: [] }), text: async () => "" };
    }) as unknown as typeof fetch;
    return seen;
  }

  beforeEach(() => {
    __resetWebSearchLatch();
    process.env.GOOGLE_CSE_ID = "cx";
  });

  it("prefers the dedicated key over the shared Gemini one", async () => {
    process.env.GOOGLE_API_KEY     = "gemini-key";
    process.env.GOOGLE_CSE_API_KEY = "search-key";
    const seen = captureKey();
    await webSearch("dedicated-key-probe");
    expect(seen).toEqual(["search-key"]);
  });

  it("falls back to GOOGLE_API_KEY so nothing breaks before the new var is set", async () => {
    process.env.GOOGLE_API_KEY = "gemini-key";
    delete process.env.GOOGLE_CSE_API_KEY;
    const seen = captureKey();
    await webSearch("fallback-key-probe");
    expect(seen).toEqual(["gemini-key"]);
  });

  it("is enabled on the dedicated key alone, with no shared key present", async () => {
    delete process.env.GOOGLE_API_KEY;
    process.env.GOOGLE_CSE_API_KEY = "search-key";
    expect(isWebSearchEnabled()).toBe(true);
  });

  it("is disabled when neither key is set", () => {
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_CSE_API_KEY;
    expect(isWebSearchEnabled()).toBe(false);
  });
});

describe("web search — permanent-failure latch", () => {
  const realFetch = global.fetch;
  const saved = { ...process.env };

  beforeEach(() => {
    __resetWebSearchLatch();
    process.env.GOOGLE_API_KEY = "k";
    process.env.GOOGLE_CSE_ID  = "cx";
  });
  afterEach(() => {
    global.fetch = realFetch;
    process.env = { ...saved };
  });

  const respond = (status: number, body: string) => {
    const calls = { n: 0 };
    global.fetch = (async () => {
      calls.n++;
      return { ok: status >= 200 && status < 300, status, text: async () => body, json: async () => ({}) };
    }) as unknown as typeof fetch;
    return calls;
  };

  it("stops calling the API after the exact 403 seen in production", async () => {
    const calls = respond(403, JSON.stringify({
      error: { code: 403, message: "Requests to this API customsearch method google.customsearch.v1.CustomSearchService.List are blocked." },
    }));

    expect(await webSearch("hard hat specs")).toEqual([]);
    expect(calls.n).toBe(1);

    // Every later analysis must cost nothing at all.
    expect(await webSearch("a different query")).toEqual([]);
    expect(await webSearch("and another")).toEqual([]);
    expect(calls.n).toBe(1);
  });

  it("reports a reason a human can act on", async () => {
    respond(403, "Requests to this API customsearch method ... are blocked.");
    await webSearch("q");
    expect(webSearchDisabledReason()).toMatch(/not enabled|API restrictions/);
  });

  it("tells callers to stop building queries once latched", async () => {
    expect(isWebSearchEnabled()).toBe(true);
    respond(403, "blocked");
    await webSearch("q");
    expect(isWebSearchEnabled()).toBe(false);
  });

  it("latches on an invalid key and on exhausted quota", async () => {
    respond(400, JSON.stringify({ error: { message: "API key not valid. Please pass a valid API key." } }));
    await webSearch("q");
    expect(webSearchDisabledReason()).toMatch(/not valid/);

    __resetWebSearchLatch();
    respond(429, "rateLimitExceeded");
    await webSearch("q");
    expect(webSearchDisabledReason()).toMatch(/quota/);
  });

  it("does NOT latch on a transient failure — those must keep retrying", async () => {
    // A 500 or a Google blip is not a configuration problem. Latching on
    // it would switch grounding off for the rest of the process over
    // something that fixes itself in seconds.
    const calls = respond(500, "backend error");
    await webSearch("q1");
    await webSearch("q2");
    expect(calls.n).toBe(2);
    expect(webSearchDisabledReason()).toBeNull();
    expect(isWebSearchEnabled()).toBe(true);
  });

  it("does not latch on a 400 that isn't about credentials", async () => {
    const calls = respond(400, "Some other bad request");
    await webSearch("q1");
    await webSearch("q2");
    expect(calls.n).toBe(2);
    expect(webSearchDisabledReason()).toBeNull();
  });
});
