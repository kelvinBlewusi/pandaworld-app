/**
 * The analysis worker's time budget (app/api/worker/analyze-jobs/route.ts).
 * Live, 2026-10-04: a slow draft left a batch's summary going out at second
 * 58 of the run's 60, and the variation question after it never went.
 */

let clock = 0;
let draftMs = 0;
const finalized: string[] = [];
let nudges = 0;

jest.mock("@/lib/whatsapp/analysis-queue", () => ({
  claimAnalysisJobs:             async () => ({ jobs: [{ id: "job-1", listing_id: "listing-1", batch_id: "batch-1", phone_number: "233550607231", attempts: 0 }], error: null }),
  markJobDone:                   async () => true,
  markJobFailed:                 async () => {},
  findUnfinalizedSettledBatches: async () => [{ batch_id: "batch-1", phone_number: "233550607231", batch_size: 2 }],
  claimBatchFinalization:        async () => true,
  msUntilNextJobSettles:         async () => 0,
  nudgeWorker:                   async () => { nudges++; },
}));

jest.mock("@/lib/whatsapp/intake", () => ({
  runQueuedAnalysis: async () => { clock += draftMs; },
  finalizeBatch:     async (batchId: string) => { finalized.push(batchId); },
}));

jest.mock("@/lib/observability/errors", () => ({ logAppError: () => {} }));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/worker/analyze-jobs/route";

const request = () => new NextRequest("https://pandaworldai.site/api/worker/analyze-jobs", {
  method: "POST",
  headers: { authorization: "Bearer test-secret" },
});

beforeAll(() => { process.env.CRON_SECRET = "test-secret"; });
beforeEach(() => {
  clock = 1_000_000;
  finalized.length = 0;
  nudges = 0;
  jest.spyOn(Date, "now").mockImplementation(() => clock);
});
afterEach(() => jest.restoreAllMocks());

it("closes a settled batch in the same run when drafting left time for it", async () => {
  draftMs = 20_000;

  const res = await POST(request());

  expect(finalized).toEqual(["batch-1"]);
  expect((await res.json()).batchesClosed).toBe(1);
});

it("leaves the batch to a fresh run when drafting used most of the time", async () => {
  draftMs = 42_000;

  const res = await POST(request());

  expect(finalized).toEqual([]);
  expect((await res.json()).batchesClosed).toBe(0);
  // The fresh run: claims nothing, so closes it with the whole budget.
  expect(nudges).toBe(1);
});
