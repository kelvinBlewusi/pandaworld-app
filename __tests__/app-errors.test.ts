/**
 * app_errors — a permanent, queryable error trail alongside the
 * console.error calls already scattered through the codebase, added
 * 2026-09-24 after Vercel's own runtime log queries repeatedly timed out
 * or hit a billing limit while investigating a real seller report. See
 * lib/observability/errors.ts's own doc comment.
 */

import { FakeDb } from "./helpers/fake-supabase";

const db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({
  createServerClient: () => db,
}));

import { logAppError } from "@/lib/observability/errors";

const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  db.tables.app_errors = [];
});

describe("logAppError", () => {
  it("records an Error's message, stack, and context", async () => {
    const err = new Error("Gemini call threw");
    logAppError("worker-analyze-jobs", err, { jobId: "job-1", listingId: "listing-1" });
    await flush();

    expect(db.tables.app_errors).toHaveLength(1);
    expect(db.tables.app_errors[0]).toMatchObject({
      source:  "worker-analyze-jobs",
      message: "Gemini call threw",
      context: { jobId: "job-1", listingId: "listing-1" },
    });
    expect(db.tables.app_errors[0].stack).toContain("Gemini call threw");
  });

  // Not every caught value is an Error — a rejected fetch or a throw from
  // third-party code can just as easily be a string or something else.
  it("stringifies a non-Error thrown value instead of crashing", async () => {
    logAppError("whatsapp-webhook", "plain string failure", { phoneNumber: "233550607231" });
    await flush();

    expect(db.tables.app_errors).toHaveLength(1);
    expect(db.tables.app_errors[0].message).toBe("plain string failure");
    expect(db.tables.app_errors[0].stack).toBeNull();
  });

  it("defaults context to an empty object when none is given", async () => {
    logAppError("whatsapp-webhook", new Error("no context given"));
    await flush();

    expect(db.tables.app_errors[0].context).toEqual({});
  });
});
