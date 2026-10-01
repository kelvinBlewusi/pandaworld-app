/**
 * The send client's retry behaviour.
 *
 * Every caller in lib/whatsapp/intake.ts sends inside a try/catch that
 * logs and moves on, so before the retry existed a throttled message was
 * simply gone — no error reached the seller, no second attempt was made,
 * and the conversation carried on as though it had been delivered. A
 * dropped "Submit product 7" is indistinguishable, from the seller's
 * side, from product 7 never having drafted.
 */

const ENV = {
  WHATSAPP_ACCESS_TOKEN:    "test-token",
  WHATSAPP_PHONE_NUMBER_ID: "123456",
};

import { sendText, sendList, sendImage, LIST_MAX_ROWS } from "@/lib/whatsapp/client";

const realFetch = global.fetch;

function reply(status: number, body: unknown = {}) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as Response;
}

let calls: { body: Record<string, unknown> }[] = [];

function mockFetch(responses: Response[]) {
  let i = 0;
  global.fetch = jest.fn(async (_url: unknown, init: unknown) => {
    calls.push({ body: JSON.parse((init as RequestInit).body as string) });
    return responses[Math.min(i++, responses.length - 1)];
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  Object.assign(process.env, ENV);
  calls = [];
  jest.useFakeTimers({ doNotFake: ["nextTick"] });
});

afterEach(() => {
  jest.useRealTimers();
  global.fetch = realFetch;
});

/** Runs a send to completion, letting the retry's setTimeout fire without
 *  actually waiting out the backoff. */
async function runWithTimers(p: Promise<void>): Promise<void> {
  let done = false;
  const settled = p.then(
    () => { done = true; return "ok" as const; },
    (e) => { done = true; return e as Error; },
  );
  // Each attempt costs several microtask turns (fetch, then res.text())
  // before its backoff timer even exists, so flush generously between
  // runs rather than assuming a fixed number of ticks.
  for (let i = 0; i < 50 && !done; i++) {
    for (let j = 0; j < 10; j++) await Promise.resolve();
    jest.runOnlyPendingTimers();
  }
  const result = await settled;
  if (result !== "ok") throw result;
}

describe("throttled sends", () => {
  // 131056 is the pair rate limit — too many messages to ONE recipient in
  // a short window, which is exactly the shape a 10-product batch has.
  it("retries Meta's pair rate limit and succeeds", async () => {
    mockFetch([reply(400, { error: { code: 131056, message: "pair rate limit hit" } }), reply(200)]);
    await runWithTimers(sendText("233550607231", "hello"));
    expect(calls).toHaveLength(2);
  });

  it("retries a plain HTTP 429", async () => {
    mockFetch([reply(429), reply(200)]);
    await runWithTimers(sendText("233550607231", "hello"));
    expect(calls).toHaveLength(2);
  });

  it("retries a 5xx", async () => {
    mockFetch([reply(503), reply(200)]);
    await runWithTimers(sendText("233550607231", "hello"));
    expect(calls).toHaveLength(2);
  });

  // A malformed message fails the same way every time. Retrying it only
  // burns the invocation's remaining time while the rest of the batch waits.
  it("does NOT retry a 400 that isn't a throttle", async () => {
    mockFetch([reply(400, { error: { code: 131009, message: "Parameter value is not valid" } })]);
    await expect(runWithTimers(sendText("233550607231", "hello"))).rejects.toThrow(/400/);
    expect(calls).toHaveLength(1);
  });

  it("gives up after the retries are spent", async () => {
    mockFetch([reply(429)]);
    await expect(runWithTimers(sendText("233550607231", "hello"))).rejects.toThrow(/429/);
    expect(calls).toHaveLength(3);
  });
});

describe("sendImage", () => {
  it("sends the picture by link, with no caption unless one is given", async () => {
    mockFetch([reply(200), reply(200)]);
    await runWithTimers(sendImage("233550607231", "https://pandaworldai.site/whatsapp/quiet-mode-example.jpg"));
    await runWithTimers(sendImage("233550607231", "https://pandaworldai.site/a.jpg", "Like this"));

    expect(calls[0].body).toMatchObject({ to: "233550607231", type: "image", image: { link: "https://pandaworldai.site/whatsapp/quiet-mode-example.jpg" } });
    expect(calls[0].body.image).not.toHaveProperty("caption");
    expect(calls[1].body.image).toEqual({ link: "https://pandaworldai.site/a.jpg", caption: "Like this" });
  });
});

describe("sendList", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    id: `submit ${i + 1}`,
    title: `Submit product ${i + 1}`,
    description: `Product number ${i + 1}`,
  }));

  it("sends ten rows in one interactive list message", async () => {
    mockFetch([reply(200)]);
    await runWithTimers(sendList("233550607231", "Pick one:", "Pick a product", rows));

    expect(calls).toHaveLength(1);
    const interactive = calls[0].body.interactive as Record<string, unknown>;
    expect(interactive.type).toBe("list");
    const action = interactive.action as { button: string; sections: { rows: unknown[] }[] };
    expect(action.sections[0].rows).toHaveLength(10);
  });

  // Meta's caps are a 400, not a truncation, so they are enforced here
  // rather than discovered in production.
  it("truncates row titles and descriptions to Meta's caps", async () => {
    mockFetch([reply(200)]);
    await runWithTimers(sendList("233550607231", "Pick one:", "A button label that is far too long", [
      { id: "submit 1", title: "A row title well past twenty-four characters", description: "x".repeat(100) },
    ]));

    const action = (calls[0].body.interactive as { action: { button: string; sections: { rows: { title: string; description: string }[] }[] } }).action;
    expect(action.button).toHaveLength(20);
    expect(action.sections[0].rows[0].title).toHaveLength(24);
    expect(action.sections[0].rows[0].description).toHaveLength(72);
  });

  it("refuses more rows than a list can hold", async () => {
    mockFetch([reply(200)]);
    await expect(
      sendList("233550607231", "Pick one:", "Pick", [...rows, { id: "submit 11", title: "Submit product 11" }]),
    ).rejects.toThrow(new RegExp(`1-${LIST_MAX_ROWS} rows`));
  });
});
