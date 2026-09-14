import { withRetry } from "@/lib/whatsapp/analysis-queue";

// PostgREST on this project intermittently answers with a 504 — its own
// log says "Warp server error: Thread killed by timeout manager" while
// Postgres sits idle (25/60 connections, no locks, no slow queries), so
// it is the REST layer rather than the database. Measured at ~11% of
// worker ticks, and worse since the 3x fan-out put three workers on the
// same instant.
describe("withRetry", () => {
  const ok = <T,>(data: T) => ({ data, error: null });
  const fail = (message: string) => ({ data: null, error: { message } });

  it("does not retry a call that succeeds", async () => {
    let calls = 0;
    const result = await withRetry("t", async () => { calls++; return ok([1, 2]); });
    expect(result).toEqual({ data: [1, 2], error: null });
    expect(calls).toBe(1);
  });

  it("retries once and returns the retry's success", async () => {
    // The whole point: a cold PostgREST thread almost always answers the
    // second time.
    let calls = 0;
    const result = await withRetry("t", async () => {
      calls++;
      return calls === 1 ? fail("Gateway Timeout") : ok(["recovered"]);
    });
    expect(result).toEqual({ data: ["recovered"], error: null });
    expect(calls).toBe(2);
  });

  it("gives up after exactly two attempts, surfacing the error", async () => {
    // Retrying harder would pile load onto the thing already struggling,
    // and pg_cron's next tick covers a real outage anyway.
    let calls = 0;
    const result = await withRetry("t", async () => { calls++; return fail("Gateway Timeout"); });
    expect(calls).toBe(2);
    expect(result.data).toBeNull();
    expect(result.error).toBe("Gateway Timeout");
  });

  it("reports the SECOND failure, not the first", async () => {
    let calls = 0;
    const result = await withRetry("t", async () => {
      calls++;
      return fail(calls === 1 ? "first" : "second");
    });
    expect(result.error).toBe("second");
  });

  it("never conflates a failure with an empty result", async () => {
    // The bug this exists to kill: claimAnalysisJobs used to answer a
    // database timeout with [], so a tick that silently accomplished
    // nothing looked exactly like an idle queue — in the logs, in the
    // worker's response body, and in net._http_response.
    const empty  = await withRetry("t", async () => ok([]));
    const broken = await withRetry("t", async () => fail("Gateway Timeout"));
    expect(empty.error).toBeNull();
    expect(broken.error).not.toBeNull();
  });

  it("accepts a thenable, since PostgREST builders are not real Promises", async () => {
    const builder = { then: (r: (v: unknown) => unknown) => Promise.resolve(ok("via-thenable")).then(r) };
    const result = await withRetry("t", () => builder as PromiseLike<{ data: string | null; error: null }>);
    expect(result.data).toBe("via-thenable");
  });
});
