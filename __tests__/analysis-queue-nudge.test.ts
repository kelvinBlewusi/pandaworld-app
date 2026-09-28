/**
 * nudgeWorker: the "start drafting now" ping the WhatsApp webhook sends
 * once a batch is queued.
 *
 * It used to be fired and forgotten. Vercel freezes a function as soon as
 * it has responded, so the ping often never left and 6 of 20 batches
 * waited for the next pg_cron tick instead (up to a minute). Callers now
 * await it, which only helps if the promise really waits for the request.
 */

import { nudgeWorker } from "@/lib/whatsapp/analysis-queue";

const realFetch = global.fetch;

beforeEach(() => {
  process.env.CRON_SECRET = "cron-secret";
});

afterEach(() => {
  global.fetch = realFetch;
});

it("doesn't resolve until the request to the worker has settled", async () => {
  let answer!: (r: Response) => void;
  const fetchMock = jest.fn(() => new Promise<Response>((resolve) => { answer = resolve; }));
  global.fetch = fetchMock as unknown as typeof fetch;

  let finished = false;
  const nudge = nudgeWorker().then(() => { finished = true; });
  await new Promise((r) => setTimeout(r, 0));

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toMatch(/\/api\/worker\/analyze-jobs$/);
  expect(init.headers).toEqual({ Authorization: "Bearer cron-secret" });
  expect(init.signal).toBeInstanceOf(AbortSignal);
  expect(finished).toBe(false);

  answer(new Response("{}"));
  await nudge;
  expect(finished).toBe(true);
});

it("never throws: a busy or unreachable worker is left to pg_cron", async () => {
  global.fetch = jest.fn(async () => { throw new DOMException("timed out", "TimeoutError"); }) as unknown as typeof fetch;
  await expect(nudgeWorker()).resolves.toBeUndefined();
});

it("does nothing without the worker's secret", async () => {
  delete process.env.CRON_SECRET;
  const fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  await nudgeWorker();
  expect(fetchMock).not.toHaveBeenCalled();
});
