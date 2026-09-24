/**
 * End-to-end tests of the WhatsApp state machine's photo-intake seams.
 *
 * These run the REAL handleLinkedMessage against an in-memory database
 * (__tests__/helpers/fake-supabase.ts) and a captured send channel. Every
 * case below is a bug that actually shipped, and not one of them would have
 * been caught by a unit test — they all live in the seam between the
 * webhook, the session row and the listing row.
 */

import { FakeDb } from "./helpers/fake-supabase";

const db = new FakeDb();
const sent: { to: string; body: string; kind: string; rows?: string[] }[] = [];

jest.mock("@/lib/supabase/server", () => ({
  createServerClient: () => db,
}));

jest.mock("@/lib/whatsapp/client", () => ({
  sendTextIfConfigured:    async (to: string, body: string) => { sent.push({ to, body, kind: "text" }); },
  sendButtonsIfConfigured: async (to: string, body: string, buttons: { id: string }[]) => {
    sent.push({ to, body, kind: "buttons", rows: buttons.map((b) => b.id) });
  },
  sendCtaUrlIfConfigured:  async (to: string, body: string) => { sent.push({ to, body, kind: "cta" }); },
  sendListIfConfigured:    async (to: string, body: string, _btn: string, rows: { id: string }[]) => {
    sent.push({ to, body, kind: "list", rows: rows.map((r) => r.id) });
  },
  LIST_MAX_ROWS: 10,
  markReadWithTypingIfConfigured: async () => {},
}));

// createListingForUser calls revalidatePath, which throws outside a Next
// request context ("Invariant: static generation store missing"). That is a
// harness concern, not product behaviour — in the webhook it runs inside a
// real request. Stubbed so the slot-claim logic under test is reached.
jest.mock("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag:  () => {},
}));

jest.mock("@/lib/whatsapp/media", () => ({
  ingestWhatsAppImage: async (mediaId: string) => `https://cdn.test/${mediaId}.jpg`,
}));

// The queue is exercised by its own tests; here we only care THAT a batch
// is enqueued, never that it runs.
const enqueued: { listingId: string; seq: number | null }[] = [];
jest.mock("@/lib/whatsapp/analysis-queue", () => ({
  enqueueAnalysisJobs: async (p: { listings: { listingId: string; seq: number | null }[] }) => {
    enqueued.push(...p.listings);
    return p.listings.length;
  },
  nudgeWorker:   () => {},
  isBatchSettled: async () => false,
}));

// Fix & resubmit's rerun path — controllable per test, never the real
// (Gemini-calling) pipeline.
type AutoAnalyzeMockResult = { ok: true } | { ok: false; message: string };
let autoAnalyzeResult: AutoAnalyzeMockResult = { ok: true };
const autoAnalyzeCalls: { listingId: string; userPromptOverride: string | null }[] = [];
jest.mock("@/lib/actions/auto-analyze", () => ({
  runAutoAnalyze: async (_userId: string, listingId: string, userPromptOverride: string | null) => {
    autoAnalyzeCalls.push({ listingId, userPromptOverride });
    return autoAnalyzeResult.ok
      ? {
          ok: true, title: "Rerun Title", brand: "Rerun Brand",
          category: { code: 1, name: "x", path: "x", confidence: 0.9 },
          alternates: [], needsUserConfirmation: false, timings: {},
          description: {}, candidates_considered: 0, attributes_in_schema: 0,
          attributes_filled: 0, variations_detected: 0,
        }
        : { ok: false, code: "describe_failed", message: autoAnalyzeResult.message };
  },
}));

// pushListingToJumia is mocked; missingFieldLabels (used by intake.ts's own
// missingFieldsFor gate) stays real — it's pure, and Fix & resubmit's
// "seller still needs to supply X" test depends on its actual logic.
type PushMockResult =
  | { ok: true; adjustments?: string[] }
  | { ok: false; message: string; code?: "validation"; needsReconnect?: boolean };
let pushResult: PushMockResult = { ok: true };
let pushCallCount = 0;
// Per-listing override for handleSubmit's "submit all" fan-out, where a
// single batch pushes several listings at once and different ones need to
// resolve differently (some ok, some a validation failure) — every OTHER
// test in this file drives one listing at a time and keeps using the
// single global pushResult above unchanged.
const pushResultFor = new Map<string, PushMockResult>();
jest.mock("@/lib/jumia/push-listing", () => ({
  ...jest.requireActual("@/lib/jumia/push-listing"),
  pushListingToJumia: async (_userId: string, listingId: string) => {
    pushCallCount++;
    return pushResultFor.get(listingId) ?? pushResult;
  },
}));

// assessListingPushReadiness (lib/whatsapp/readiness.ts) is the ONE seam
// this suite doesn't exercise for real — its own dry-run reaches Jumia
// (getValidJumiaCredentials, resolveBrand, schema fetch), which none of
// these fixtures seed a jumia_connections row for. Mocked down to just the
// pure, already-real missingFieldLabels check these tests actually care
// about (message volume / chunking / "needs price" phrasing) — the
// assessor's own Jumia-dependent behaviour (decimal mismatches, variant
// enums, fashion-Generic brand) has its own unit tests in
// __tests__/whatsapp-readiness.test.ts.
// Settable per test — the set of listing ids assessListingPushReadiness
// should report as blocked on a disconnected Jumia account, mirroring
// readiness.ts's own not_connected branch (needsReconnect: true).
const needsReconnectFor = new Set<string>();
jest.mock("@/lib/whatsapp/readiness", () => ({
  assessListingPushReadiness: async (_userId: string, listingId: string) => {
    if (needsReconnectFor.has(listingId)) {
      return { ready: false, reasons: ["Jumia needs to be (re)connected before this can be checked"], needsReconnect: true };
    }
    const { missingFieldLabels } = jest.requireActual("@/lib/jumia/push-listing");
    const row = db.tables.listings.find((l) => l.id === listingId);
    if (!row) return { ready: false, reasons: ["listing not found"] };
    const missing = missingFieldLabels(row);
    return missing.length > 0
      ? { ready: false, reasons: missing.map((m: string) => `needs ${m}`) }
      : { ready: true, reasons: [] };
  },
}));

import { handleLinkedMessage } from "@/lib/whatsapp/intake";

const USER  = "user_1";
const PHONE = "233550607231";

function seedSession(patch: Record<string, unknown> = {}) {
  db.tables.whatsapp_sessions = [{
    phone_number: PHONE,
    user_id:      USER,
    state:        "awaiting_photos",
    listing_id:   null,
    batch_id:     "batch-1",
    batch_size:   1,
    batch_seq:    1,
    pending_notes: null,
    last_image_at: null,
    last_message_id: null,
    ...patch,
  }];
}

function session() { return db.tables.whatsapp_sessions[0]; }
function listings() { return db.tables.listings; }

beforeEach(() => {
  db.tables.listings = [];
  db.tables.analysis_jobs = [];
  db.tables.jumia_connect_tokens = [];
  db.rpcCalls.length = 0;
  sent.length = 0;
  enqueued.length = 0;
  needsReconnectFor.clear();
  pushResultFor.clear();
  pushResult = { ok: true };
  pushCallCount = 0;
  seedSession();
});

const photo = (mediaId: string) => ({ imageMediaId: mediaId });

describe("an album arriving as several webhook deliveries", () => {
  // Confirmed live: two "4 Burner Gas ..." listings created 115ms apart,
  // one holding the seller's note and the other an orphan with photos.
  it("lands every photo on ONE listing, not one listing per photo", async () => {
    await handleLinkedMessage(USER, PHONE, "m1", photo("a"));
    await handleLinkedMessage(USER, PHONE, "m2", photo("b"));
    await handleLinkedMessage(USER, PHONE, "m3", photo("c"));

    expect(listings()).toHaveLength(1);
    expect(listings()[0].images).toEqual([
      "https://cdn.test/a.jpg",
      "https://cdn.test/b.jpg",
      "https://cdn.test/c.jpg",
    ]);
  });

  // The read-modify-write version of this lost two photos out of three:
  // every delivery read `images` before any of them wrote, and the last
  // write won. The append has to happen inside the database.
  it("appends through the atomic RPC rather than writing back a list it read", async () => {
    await handleLinkedMessage(USER, PHONE, "m1", photo("a"));
    await handleLinkedMessage(USER, PHONE, "m2", photo("b"));

    const appends = db.rpcCalls.filter((c) => c.name === "append_listing_image");
    expect(appends).toHaveLength(2);
  });

  // Six photos produced six near-identical confirmations, each with its
  // own Done button, in about four seconds.
  it("confirms the burst once, not once per photo", async () => {
    await handleLinkedMessage(USER, PHONE, "m1", photo("a"));
    await handleLinkedMessage(USER, PHONE, "m2", photo("b"));
    await handleLinkedMessage(USER, PHONE, "m3", photo("c"));

    const gotIt = sent.filter((m) => m.body.includes("got it"));
    expect(gotIt).toHaveLength(1);
  });

  // The count was the whole point of the confirmation — it is what tells a
  // seller nothing was dropped. Silencing the repeats must not lose it, so
  // it moves to "done", where it is finally accurate.
  it("reports the real photo total once, on done", async () => {
    await handleLinkedMessage(USER, PHONE, "m1", photo("a"));
    await handleLinkedMessage(USER, PHONE, "m2", photo("b"));
    await handleLinkedMessage(USER, PHONE, "m3", photo("c"));

    // Age the row past the settle window. Tapping done the instant a photo
    // lands is now held on purpose — see "tapping done while the album is
    // still arriving" below — and this test is about the COUNT, not the
    // hold, so it puts the seller in the state of having paused first.
    listings()[0].updated_at = new Date(Date.now() - 60_000).toISOString();

    await handleLinkedMessage(USER, PHONE, "m4", { text: "done" });

    expect(sent.some((m) => m.body.includes("3 photos"))).toBe(true);
  });
});

describe("a note that overtakes its own photo", () => {
  // WhatsApp does not order separate deliveries and a line of text is a far
  // smaller payload than an image, so this is the common case, not the edge
  // case. It used to be dropped outright: a product drafted with no price,
  // no variants and no sale window, under a note that gave all three.
  it("parks the note and applies it once the photo creates the listing", async () => {
    await handleLinkedMessage(USER, PHONE, "m1", { text: "Price is 500" });

    expect(listings()).toHaveLength(0);
    expect(session().pending_notes).toContain("Price is 500");

    await handleLinkedMessage(USER, PHONE, "m2", photo("a"));

    expect(listings()).toHaveLength(1);
    expect(session().pending_notes).toBeNull();
    expect(String(listings()[0].user_prompt ?? "")).toContain("Price is 500");
  });
});

describe("Meta's own unsupported container", () => {
  // Logged twice in one seller's album on 2026-09-15, each telling them
  // "send a photo instead" while their photos were landing fine.
  it("says nothing while photos are in flight", async () => {
    await handleLinkedMessage(USER, PHONE, "m1", photo("a"));
    sent.length = 0;

    await handleLinkedMessage(USER, PHONE, "m2", {
      unsupported:   "unsupported",
      platformError: "131051 Unsupported message type",
    });

    expect(sent).toHaveLength(0);
  });

  // The deny-by-default net stays up for everything the seller actually
  // chose to send. Silence there was the original bug.
  it("still answers a real media type the seller sent", async () => {
    await handleLinkedMessage(USER, PHONE, "m1", { unsupported: "video" });
    expect(sent.some((m) => m.body.includes("can't watch videos"))).toBe(true);
  });
});

describe("webhook retries", () => {
  // Meta retries aggressively. Re-running an append would duplicate a
  // photo; re-running an analyze would charge the seller twice.
  it("ignores a redelivery of the same message id", async () => {
    await handleLinkedMessage(USER, PHONE, "same-id", photo("a"));
    const before = [...(listings()[0].images as string[])];

    await handleLinkedMessage(USER, PHONE, "same-id", photo("a"));

    expect(listings()[0].images).toEqual(before);
  });
});

describe("tapping done while the album is still arriving", () => {
  // The reported failure: 7 photos of one pair of headphones, 5 landed on
  // it and 2 landed on the NEXT product, which had been sent no photos at
  // all. Nothing was lost — every photo reached the database — but two of
  // them described the wrong product, which is worse than losing them:
  // the listing looks complete and is wrong.
  it("holds the advance instead of letting stragglers start the next product", async () => {
    seedSession({ batch_size: 2, batch_seq: 1 });

    await handleLinkedMessage(USER, PHONE, "m1", photo("a"));
    await handleLinkedMessage(USER, PHONE, "m2", photo("b"));
    sent.length = 0;

    // "done" arrives while the row was stamped moments ago.
    await handleLinkedMessage(USER, PHONE, "m3", { text: "done" });

    expect(sent.some((m) => m.body.includes("Still receiving your photos"))).toBe(true);
    // Still on product 1 — no advance, so a straggler cannot be
    // misattributed to product 2.
    expect(session().batch_seq).toBe(1);
    expect(session().listing_id).not.toBeNull();
  });

  it("advances once the photos have settled", async () => {
    seedSession({ batch_size: 2, batch_seq: 1 });
    await handleLinkedMessage(USER, PHONE, "m1", photo("a"));

    // Age the row past the settle window, as a real pause would.
    const listing = listings()[0];
    listing.updated_at = new Date(Date.now() - 60_000).toISOString();
    sent.length = 0;

    await handleLinkedMessage(USER, PHONE, "m2", { text: "done" });

    expect(sent.some((m) => m.body.includes("Product 1 saved"))).toBe(true);
    expect(session().batch_seq).toBe(2);
    expect(session().listing_id).toBeNull();
  });

  // The full "send photos, tell me the price..." instructions already went
  // out once at the very start of the batch (handleAwaitingCount) — a
  // 10-product batch used to repeat that whole paragraph nine more times,
  // one per product transition, with nothing new in it. Audited from a
  // real chat export on 2026-09-16.
  it("gives a short transition after the first product, not the full instructions again", async () => {
    seedSession({ batch_size: 3, batch_seq: 1 });
    await handleLinkedMessage(USER, PHONE, "m1", photo("a"));
    const listing = listings()[0];
    listing.updated_at = new Date(Date.now() - 60_000).toISOString();
    sent.length = 0;

    await handleLinkedMessage(USER, PHONE, "m2", { text: "done" });

    const transition = sent.find((m) => m.body.includes("Product 1 saved"))!;
    expect(transition.body).toContain("Next: product 2 of 3");
    // Not the old repeated paragraph.
    expect(transition.body).not.toMatch(/tell me the price plus any other notes/);
  });

  // The hold must not swallow what the seller typed alongside "done" —
  // they will not retype a price.
  it("still saves notes sent with the done that got held", async () => {
    seedSession({ batch_size: 2, batch_seq: 1 });
    await handleLinkedMessage(USER, PHONE, "m1", photo("a"));
    sent.length = 0;

    await handleLinkedMessage(USER, PHONE, "m2", { text: "250\nDone" });

    expect(sent.some((m) => m.body.includes("Still receiving your photos"))).toBe(true);
    expect(String(listings()[0].user_prompt ?? "")).toContain("250");
  });
});

describe("asking for a missing price in chat", () => {
  // The reported shape: a real 10-product session where 5 products were
  // drafted perfectly and never reached Jumia, every one of them for the
  // same reason — no price — and the only way to supply one was to leave
  // WhatsApp for the review page.
  const FULL = {
    description: "A long enough description to clear the fifty-character minimum check.",
    category_code: "1234",
    brand: "Panasonic",
    images: ["https://cdn.test/a.jpg"],
    status: "draft",
  };

  function seedBatch(rows: { seq: number; title: string; price?: number }[]) {
    db.tables.listings = rows.map((r) => ({
      id: `listing-${r.seq}`,
      user_id: USER,
      whatsapp_batch_id: "batch-1",
      whatsapp_seq: r.seq,
      title: r.title,
      selling_price: r.price ?? null,
      ...FULL,
    }));
  }

  function confirming(patch: Record<string, unknown> = {}) {
    seedSession({ state: "awaiting_confirmation", batch_size: 2, batch_seq: null, ...patch });
  }

  it("asks about the first product with no price once the batch closes", async () => {
    seedBatch([
      { seq: 1, title: "Panasonic Electric Kettle 1.7L" },
      { seq: 2, title: "Sony Wireless Over-Ear Headphones", price: 210 },
    ]);
    confirming();
    sent.length = 0;

    const { finalizeBatch } = await import("@/lib/whatsapp/intake");
    await finalizeBatch("batch-1", PHONE, 2);

    const ask = sent.find((m) => m.body.includes("What price are you selling it at?"));
    expect(ask).toBeDefined();
    expect(ask!.body).toContain("Product 1 — Panasonic Electric Kettle 1.7L");
    expect(session().awaiting_price_for).toBe("listing-1");
  });

  it("says nothing when every drafted product already has a price", async () => {
    seedBatch([
      { seq: 1, title: "Panasonic Electric Kettle 1.7L", price: 150 },
      { seq: 2, title: "Sony Wireless Over-Ear Headphones", price: 210 },
    ]);
    confirming();
    sent.length = 0;

    const { finalizeBatch } = await import("@/lib/whatsapp/intake");
    await finalizeBatch("batch-1", PHONE, 2);

    expect(sent.some((m) => m.body.includes("What price"))).toBe(false);
    expect(session().awaiting_price_for ?? null).toBeNull();
  });

  it("banks a bare number as that product's price and moves to the next one", async () => {
    seedBatch([
      { seq: 1, title: "Panasonic Electric Kettle 1.7L" },
      { seq: 2, title: "Sony Wireless Over-Ear Headphones" },
    ]);
    confirming({ awaiting_price_for: "listing-1" });
    sent.length = 0;

    await handleLinkedMessage(USER, PHONE, "m1", { text: "150" });

    expect(listings()[0].selling_price).toBe(150);
    const reply = sent.find((m) => m.body.includes("Price set to GHS 150"));
    expect(reply).toBeDefined();
    // Confirmation and the next question share one send — message volume
    // right after drafting is already the busiest point in the flow.
    expect(reply!.body).toContain("Product 2 — Sony Wireless Over-Ear Headphones");
    expect(session().awaiting_price_for).toBe("listing-2");
  });

  it("closes the loop with the submit buttons after the last price", async () => {
    seedBatch([{ seq: 1, title: "Panasonic Electric Kettle 1.7L" }]);
    confirming({ batch_size: 1, awaiting_price_for: "listing-1" });
    sent.length = 0;

    await handleLinkedMessage(USER, PHONE, "m1", { text: "GHS 150" });

    expect(listings()[0].selling_price).toBe(150);
    expect(sent.some((m) => m.body.includes("That's every price filled in"))).toBe(true);
    expect(session().awaiting_price_for).toBeNull();
  });

  // Without this, "submit all" typed in answer to the price question would
  // be banked as a price of nothing, or worse, swallowed entirely.
  it("drops the question the moment the seller says anything else", async () => {
    seedBatch([{ seq: 1, title: "Panasonic Electric Kettle 1.7L" }]);
    confirming({ batch_size: 1, awaiting_price_for: "listing-1" });
    sent.length = 0;

    await handleLinkedMessage(USER, PHONE, "m1", { text: "what is this" });

    expect(listings()[0].selling_price).toBeNull();
    expect(session().awaiting_price_for).toBeNull();
  });

  // Skipping must walk FORWARD. Re-offering the product just declined is
  // the one way this loop could trap a seller.
  it("skips to the next product rather than re-asking the skipped one", async () => {
    seedBatch([
      { seq: 1, title: "Panasonic Electric Kettle 1.7L" },
      { seq: 2, title: "Sony Wireless Over-Ear Headphones" },
    ]);
    confirming({ awaiting_price_for: "listing-1" });
    sent.length = 0;

    await handleLinkedMessage(USER, PHONE, "m1", { text: "skip price" });

    expect(session().awaiting_price_for).toBe("listing-2");
    const ask = sent.find((m) => m.body.includes("What price"));
    expect(ask!.body).toContain("Product 2");
  });

  it("stops asking when the last product is skipped", async () => {
    seedBatch([{ seq: 1, title: "Panasonic Electric Kettle 1.7L" }]);
    confirming({ batch_size: 1, awaiting_price_for: "listing-1" });
    sent.length = 0;

    await handleLinkedMessage(USER, PHONE, "m1", { text: "skip price" });

    expect(session().awaiting_price_for).toBeNull();
    expect(sent.some((m) => m.body.includes("What price"))).toBe(false);
    expect(sent.some((m) => m.body.includes("review page"))).toBe(true);
  });

  // A product that never drafted has no title; a price would not make it
  // submittable, and asking for one implies it would.
  it("never asks about a product that failed to draft", async () => {
    db.tables.listings = [
      { id: "listing-1", user_id: USER, whatsapp_batch_id: "batch-1", whatsapp_seq: 1, title: null, selling_price: null, ...FULL },
      { id: "listing-2", user_id: USER, whatsapp_batch_id: "batch-1", whatsapp_seq: 2, title: "Sony Wireless Over-Ear Headphones", selling_price: null, ...FULL },
    ];
    confirming();
    sent.length = 0;

    const { finalizeBatch } = await import("@/lib/whatsapp/intake");
    await finalizeBatch("batch-1", PHONE, 2);

    expect(session().awaiting_price_for).toBe("listing-2");
  });
});

describe("a single-product batch whose analysis hard-failed", () => {
  // Real production shape: a Vercel function-timeout kill mid-analysis is
  // silent at the platform level — no catch block runs, so
  // runQueuedAnalysis never reaches its own replyError call. The job gets
  // retried, and once claim_analysis_jobs finally retires it to 'failed'
  // after exhausting attempts, the seller had heard NOTHING since
  // "drafting them now" — confirmed live, two single-product batches sat
  // untouched for hours.
  it("tells the seller when the job was retired to 'failed' with no title ever set", async () => {
    db.tables.listings = [
      { id: "listing-1", user_id: USER, whatsapp_batch_id: "batch-1", whatsapp_seq: 1, title: null, selling_price: null },
    ];
    db.tables.analysis_jobs = [
      { id: "job-1", listing_id: "listing-1", batch_id: "batch-1", user_id: USER, phone_number: PHONE, seq: 1, batch_size: 1, status: "failed", attempts: 3, error: "Gave up after 3 attempts" },
    ];
    seedSession({ state: "awaiting_confirmation", batch_size: 1, batch_seq: null });
    sent.length = 0;

    const { finalizeBatch } = await import("@/lib/whatsapp/intake");
    await finalizeBatch("batch-1", PHONE, 1);

    const failure = sent.find((m) => m.body.includes("couldn't be drafted after several tries"));
    expect(failure).toBeDefined();
  });

  // The other half: a job that reached runQueuedAnalysis's own graceful
  // failure path is marked 'done' (not 'failed'), specifically so
  // finalizeBatch does not send a SECOND message on top of the one
  // runQueuedAnalysis already sent. No analysis_jobs row at all is the
  // same case — the job might have been cleaned up, or never queued via
  // this path in the test at all.
  it("stays silent when the no-title listing's job is not 'failed' — already covered elsewhere", async () => {
    db.tables.listings = [
      { id: "listing-1", user_id: USER, whatsapp_batch_id: "batch-1", whatsapp_seq: 1, title: null, selling_price: null },
    ];
    db.tables.analysis_jobs = [
      { id: "job-1", listing_id: "listing-1", batch_id: "batch-1", user_id: USER, phone_number: PHONE, seq: 1, batch_size: 1, status: "done", attempts: 1, error: null },
    ];
    seedSession({ state: "awaiting_confirmation", batch_size: 1, batch_seq: null });
    sent.length = 0;

    const { finalizeBatch } = await import("@/lib/whatsapp/intake");
    await finalizeBatch("batch-1", PHONE, 1);

    expect(sent).toHaveLength(0);
  });
});

describe("noteWarningsFor — variant-claim vs drafted-label matching (finalizeBatch single-product)", () => {
  // Real incident, sandals (parentSku PA-MUDIF5R5, category 1013693): the
  // seller wrote "Sizes 40 41 42 43", the category's own numeric-size
  // schema drafted "EU 40" / "EU 41" / "EU 42" / "EU 43" — a listing Jumia
  // would have accepted exactly as submitted was Held anyway, asking the
  // seller to open Edit for nothing that needed fixing.
  const FULL = {
    description: "A long enough description to clear the fifty-character minimum check.",
    category_code: "1234",
    brand: "Panasonic",
    images: ["https://cdn.test/a.jpg"],
    status: "draft",
    selling_price: 150,
  };

  function seedDraftedWithClaim(userPrompt: string, variationLabels: string[]) {
    db.tables.listings = [
      { id: "listing-1", user_id: USER, whatsapp_batch_id: "batch-1", whatsapp_seq: 1, title: "Leather Slide Sandals - Buckle Strap, Brown", user_prompt: userPrompt, ...FULL },
    ];
    db.tables.variants = variationLabels.map((v, i) => ({ id: `v${i + 1}`, listing_id: "listing-1", variation: v }));
  }

  it("does not Hold when the seller's bare numeric sizes are a whole word inside the drafted regional labels", async () => {
    seedDraftedWithClaim("Sizes 40 41 42 43", ["EU 40", "EU 41", "EU 42", "EU 43"]);
    seedSession({ state: "awaiting_confirmation", batch_size: 1, batch_seq: null });
    sent.length = 0;

    const { finalizeBatch } = await import("@/lib/whatsapp/intake");
    await finalizeBatch("batch-1", PHONE, 1);

    const draftMsg = sent.find((m) => m.kind === "cta");
    expect(draftMsg?.body).toContain("Ready to submit");
    expect(draftMsg?.body).not.toContain("doesn't match what you typed exactly");
  });

  // 2026-09-23 seller decision: a wording mismatch (2026-09-22 tee canary
  // shape — "Xtra Large" vs drafted "XL", no literal word in common) is a
  // SOFT warning, not an automatic Hold. Once the dry-run (here, the
  // mocked assessListingPushReadiness — every required field is present)
  // already says the push would succeed, second-guessing the wording is a
  // false Hold, so this now goes Ready same as the sandals case.
  it("goes Ready on a wording mismatch once the push itself would succeed — 'Xtra Large' vs 'XL'", async () => {
    seedDraftedWithClaim("Sizes Medium Large Xtra Large", ["M", "L", "XL"]);
    seedSession({ state: "awaiting_confirmation", batch_size: 1, batch_seq: null });
    sent.length = 0;

    const { finalizeBatch } = await import("@/lib/whatsapp/intake");
    await finalizeBatch("batch-1", PHONE, 1);

    const draftMsg = sent.find((m) => m.kind === "cta");
    expect(draftMsg?.body).toContain("Ready to submit");
    expect(draftMsg?.body).not.toContain("doesn't match what you typed exactly");
  });

  // The wording-mismatch note is still surfaced as useful context — just
  // no longer the thing that Holds — when the listing is Held anyway for
  // an unrelated reason the dry-run itself catches (here, no price).
  it("still surfaces the wording-mismatch note as context when Held for an unrelated reason", async () => {
    seedDraftedWithClaim("Sizes Medium Large Xtra Large", ["M", "L", "XL"]);
    db.tables.listings[0].selling_price = null;
    seedSession({ state: "awaiting_confirmation", batch_size: 1, batch_seq: null });
    sent.length = 0;

    const { finalizeBatch } = await import("@/lib/whatsapp/intake");
    await finalizeBatch("batch-1", PHONE, 1);

    const draftMsg = sent.find((m) => m.kind === "cta");
    expect(draftMsg?.body).not.toContain("Ready to submit");
    expect(draftMsg?.body).toContain("doesn't match what you typed exactly");
  });

  // A claim that lost every option entirely (zero variant rows) stays a
  // hard block regardless of push-readiness — that's lost data, not a
  // wording quibble, so it is never waved through just because the rest
  // of the payload would push fine.
  it("still Holds when a stated claim resolved to zero variants, even though the push itself would succeed", async () => {
    seedDraftedWithClaim("Sizes Medium Large Xtra Large", []);
    seedSession({ state: "awaiting_confirmation", batch_size: 1, batch_seq: null });
    sent.length = 0;

    const { finalizeBatch } = await import("@/lib/whatsapp/intake");
    await finalizeBatch("batch-1", PHONE, 1);

    const draftMsg = sent.find((m) => m.kind === "cta");
    expect(draftMsg?.body).not.toContain("Ready to submit");
    expect(draftMsg?.body).toContain("so none were added");
  });
});

describe("a multi-product batch with one hard-failed product", () => {
  // Same production shape as the single-product case above, extended to a
  // batch of several — a throw mid-Gemini (see lib/ai/parse-ai-response.ts's
  // hardening in this same change) and a Vercel function-
  // timeout kill are both silent at the point of failure and both retire
  // to analysis_jobs.status='failed' the same way, without
  // runQueuedAnalysis ever reaching its own replyError call. Confirmed
  // live, 2026-09-21 staging canary: a 3-product batch went quiet on 2 of
  // 3 products with nothing sent for either.
  const FULL = {
    description: "A long enough description to clear the fifty-character minimum check.",
    category_code: "1234",
    brand: "Panasonic",
    images: ["https://cdn.test/a.jpg"],
    status: "draft",
    selling_price: 150,
  };

  it("sends a per-seq Fix/Retry bubble for the hard-failed product, alongside the other two drafting normally", async () => {
    db.tables.listings = [
      { id: "listing-1", user_id: USER, whatsapp_batch_id: "batch-1", whatsapp_seq: 1, title: "Drafted product number 1", ...FULL },
      { id: "listing-2", user_id: USER, whatsapp_batch_id: "batch-1", whatsapp_seq: 2, title: null, selling_price: null },
      { id: "listing-3", user_id: USER, whatsapp_batch_id: "batch-1", whatsapp_seq: 3, title: "Drafted product number 3", ...FULL },
    ];
    db.tables.analysis_jobs = [
      { id: "job-2", listing_id: "listing-2", batch_id: "batch-1", user_id: USER, phone_number: PHONE, seq: 2, batch_size: 3, status: "failed", attempts: 3, error: "Gave up after 3 attempts" },
    ];
    seedSession({ state: "awaiting_confirmation", batch_size: 3, batch_seq: null });
    sent.length = 0;

    const { finalizeBatch } = await import("@/lib/whatsapp/intake");
    await finalizeBatch("batch-1", PHONE, 3);

    const bubble = sent.find((m) => m.kind === "cta" && m.body.includes("Product 2 couldn't be drafted after several tries"));
    expect(bubble).toBeDefined();

    // The other two still get their normal Ready/Held status line, and it
    // says nothing about product 2 — that's the per-seq bubble's job.
    const statusMessage = sent.find((m) => m.kind === "text" && m.body.includes("Product 1"));
    expect(statusMessage?.body).toContain("Product 1: ✅ Ready");
    expect(statusMessage?.body).toContain("Product 3: ✅ Ready");
    expect(statusMessage?.body).not.toContain("Product 2");
  });

  it("does not send a per-seq bubble for a title-less product whose job never reached 'failed'", async () => {
    db.tables.listings = [
      { id: "listing-1", user_id: USER, whatsapp_batch_id: "batch-1", whatsapp_seq: 1, title: "Drafted product number 1", ...FULL },
      { id: "listing-2", user_id: USER, whatsapp_batch_id: "batch-1", whatsapp_seq: 2, title: null, selling_price: null },
    ];
    // No analysis_jobs row at all for listing-2 — e.g. still mid-retry
    // elsewhere, or cleaned up. Nothing here confirms a silent death, so
    // no per-seq bubble — only the existing combined "couldn't be
    // drafted" summary further down still names it.
    seedSession({ state: "awaiting_confirmation", batch_size: 2, batch_seq: null });
    sent.length = 0;

    const { finalizeBatch } = await import("@/lib/whatsapp/intake");
    await finalizeBatch("batch-1", PHONE, 2);

    expect(sent.some((m) => m.body.includes("couldn't be drafted after several tries"))).toBe(false);
  });
});

describe("finalizeBatch — Held-for-reconnect status messages carry a reconnect link", () => {
  // Real production report, 2026-09-24: a batch came back with several
  // products Held on "Jumia needs to be (re)connected before this can be
  // checked" and no way to act on it from the message — the seller had to
  // already know to type "connect". One token fixes every Held-for-
  // reconnect product in the batch at once, so it's generated once and
  // appended to the status message rather than repeated per line.
  const FULL = {
    description: "A long enough description to clear the fifty-character minimum check.",
    category_code: "1234",
    brand: "Panasonic",
    images: ["https://cdn.test/a.jpg"],
    status: "draft",
    selling_price: 150,
  };

  function seedBatch(rows: { seq: number; title: string }[]) {
    db.tables.listings = rows.map((r) => ({
      id: `listing-${r.seq}`,
      user_id: USER,
      whatsapp_batch_id: "batch-1",
      whatsapp_seq: r.seq,
      title: r.title,
      ...FULL,
    }));
  }

  it("appends one reconnect link to the multi-product status message when any product needs it", async () => {
    seedBatch([
      { seq: 1, title: "Panasonic Electric Kettle 1.7L" },
      { seq: 2, title: "Sony Wireless Over-Ear Headphones" },
      { seq: 3, title: "Safety Helmet — Adjustable Strap" },
    ]);
    needsReconnectFor.add("listing-1");
    needsReconnectFor.add("listing-3");
    seedSession({ state: "awaiting_confirmation", batch_size: 3, batch_seq: null });
    sent.length = 0;

    const { finalizeBatch } = await import("@/lib/whatsapp/intake");
    await finalizeBatch("batch-1", PHONE, 3);

    const status = sent.find((m) => m.kind === "text" && m.body.includes("Product 1"));
    expect(status).toBeDefined();
    expect(status!.body).toContain("Product 1: ⚠️ Held — Jumia needs to be (re)connected");
    expect(status!.body).toContain("Product 3: ⚠️ Held — Jumia needs to be (re)connected");
    // Exactly one link, not one per Held-for-reconnect line.
    const linkCount = (status!.body.match(/\/api\/jumia\/connect\?wa_token=/g) ?? []).length;
    expect(linkCount).toBe(1);
    expect(db.tables.jumia_connect_tokens).toHaveLength(1);
    expect(db.tables.jumia_connect_tokens[0].user_id).toBe(USER);
  });

  it("adds no reconnect link when nothing in the batch needs one", async () => {
    seedBatch([
      { seq: 1, title: "Panasonic Electric Kettle 1.7L" },
      { seq: 2, title: "Sony Wireless Over-Ear Headphones" },
    ]);
    seedSession({ state: "awaiting_confirmation", batch_size: 2, batch_seq: null });
    sent.length = 0;

    const { finalizeBatch } = await import("@/lib/whatsapp/intake");
    await finalizeBatch("batch-1", PHONE, 2);

    const status = sent.find((m) => m.kind === "text" && m.body.includes("Product 1"));
    expect(status!.body).not.toContain("/api/jumia/connect");
    expect(db.tables.jumia_connect_tokens ?? []).toHaveLength(0);
  });

  it("offers a Reconnect Jumia link instead of Edit product for a single-product batch that needs reconnecting", async () => {
    seedBatch([{ seq: 1, title: "Panasonic Electric Kettle 1.7L" }]);
    needsReconnectFor.add("listing-1");
    seedSession({ state: "awaiting_confirmation", batch_size: 1, batch_seq: null });
    sent.length = 0;

    const { finalizeBatch } = await import("@/lib/whatsapp/intake");
    await finalizeBatch("batch-1", PHONE, 1);

    const draftMsg = sent.find((m) => m.kind === "cta");
    expect(draftMsg?.body).toContain("Jumia needs to be (re)connected");
    expect(db.tables.jumia_connect_tokens).toHaveLength(1);
  });

  it("still offers Edit product for a single-product batch Held for an ordinary reason", async () => {
    seedBatch([{ seq: 1, title: "Panasonic Electric Kettle 1.7L" }]);
    db.tables.listings[0].selling_price = null; // missing price — an ordinary Held, not a reconnect
    seedSession({ state: "awaiting_confirmation", batch_size: 1, batch_seq: null });
    sent.length = 0;

    const { finalizeBatch } = await import("@/lib/whatsapp/intake");
    await finalizeBatch("batch-1", PHONE, 1);

    const draftMsg = sent.find((m) => m.kind === "cta");
    expect(draftMsg?.body ?? "").not.toContain("re)connected");
    expect(db.tables.jumia_connect_tokens ?? []).toHaveLength(0);
  });
});

describe("message volume on a large batch", () => {
  // The live failure: a 10-product batch sent roughly 25 messages to one
  // recipient in about 30 seconds. Meta throttles per business/consumer
  // pair, and the tail was dropped — submit buttons arrived for products
  // 1–6 and the closing message never arrived at all. Four chunked button
  // messages became one list.
  const FULL = {
    description: "A long enough description to clear the fifty-character minimum check.",
    category_code: "1234",
    brand: "Panasonic",
    images: ["https://cdn.test/a.jpg"],
    status: "draft",
    selling_price: 150,
  };

  function seedDrafted(n: number) {
    db.tables.listings = Array.from({ length: n }, (_, i) => ({
      id: `listing-${i + 1}`,
      user_id: USER,
      whatsapp_batch_id: "batch-1",
      whatsapp_seq: i + 1,
      title: `Drafted product number ${i + 1}`,
      ...FULL,
    }));
  }

  it("offers ten products as ONE list instead of four button messages", async () => {
    seedDrafted(10);
    seedSession({ state: "awaiting_confirmation", batch_size: 10, batch_seq: null });
    sent.length = 0;

    const { finalizeBatch } = await import("@/lib/whatsapp/intake");
    await finalizeBatch("batch-1", PHONE, 10);

    const lists = sent.filter((m) => m.kind === "list");
    expect(lists).toHaveLength(1);
    expect(lists[0].rows).toHaveLength(10);
    // The row id IS the command phrase, so a tap reaches parseSubmitCommand
    // exactly as typing it would.
    expect(lists[0].rows).toContain("submit 7");
    // And the closing message still goes out — it was the one lost live.
    expect(sent.some((m) => m.body.includes("Done drafting your 10 products"))).toBe(true);
  });

  // Three or fewer render inline with no sheet to open, and there is no
  // volume to save at that size.
  it("keeps inline buttons for a small batch", async () => {
    seedDrafted(3);
    seedSession({ state: "awaiting_confirmation", batch_size: 3, batch_seq: null });
    sent.length = 0;

    const { finalizeBatch } = await import("@/lib/whatsapp/intake");
    await finalizeBatch("batch-1", PHONE, 3);

    expect(sent.some((m) => m.kind === "list")).toBe(false);
    expect(sent.some((m) => m.kind === "buttons" && m.body.includes("Submit a specific product"))).toBe(true);
  });

  // A product that never drafted has no title and no submit row — but it
  // must still be named in the closing message, because its number is what
  // the seller needs in order to retry it.
  it("leaves failed products out of the list and names them in the summary", async () => {
    seedDrafted(5);
    db.tables.listings[2].title = null;
    seedSession({ state: "awaiting_confirmation", batch_size: 5, batch_seq: null });
    sent.length = 0;

    const { finalizeBatch } = await import("@/lib/whatsapp/intake");
    await finalizeBatch("batch-1", PHONE, 5);

    const list = sent.find((m) => m.kind === "list")!;
    expect(list.rows).toEqual(["submit 1", "submit 2", "submit 4", "submit 5"]);
    expect(sent.some((m) => m.body.includes("retry 3"))).toBe(true);
  });

  // The other half of the ~108-message evidence: runQueuedAnalysis used to
  // send its own "✅ Product N drafted" message the moment EACH product
  // finished, so a 20-product batch fired up to 20 of these on top of
  // everything else. That per-product bubble is gone; the status is
  // reported once, by finalizeBatch, after the whole batch settles.
  it("does not send a live 'drafted' message per product while a multi-product batch is still analyzing", async () => {
    db.tables.listings = [{ id: "listing-1", user_id: USER, whatsapp_batch_id: "batch-1", whatsapp_seq: 1, title: null, ...FULL }];
    sent.length = 0;

    const { runQueuedAnalysis } = await import("@/lib/whatsapp/intake");
    await runQueuedAnalysis({
      id: "job-1", listing_id: "listing-1", batch_id: "batch-1", user_id: USER,
      phone_number: PHONE, seq: 1, batch_size: 2, status: "running", attempts: 1,
    });

    expect(sent.some((m) => m.body.includes("drafted"))).toBe(false);
  });

  // finalizeBatch's own replacement for that per-product bubble: ONE
  // message naming every drafted product's status — Ready, or Held with
  // why — instead of one live message per product as each one finished.
  it("reports every drafted product's Ready/Held status in one consolidated message", async () => {
    seedDrafted(3);
    db.tables.listings[1].selling_price = null; // product 2 is missing its price
    seedSession({ state: "awaiting_confirmation", batch_size: 3, batch_seq: null });
    sent.length = 0;

    const { finalizeBatch } = await import("@/lib/whatsapp/intake");
    await finalizeBatch("batch-1", PHONE, 3);

    const statusMessages = sent.filter((m) => m.kind === "text" && m.body.includes("Product 1"));
    expect(statusMessages).toHaveLength(1);
    const body = statusMessages[0].body;
    expect(body).toContain("Product 1: ✅ Ready — Drafted product number 1.");
    expect(body).toContain("Product 2: ⚠️ Held — needs price.");
    expect(body).toContain("Product 3: ✅ Ready — Drafted product number 3.");
  });
});

describe("quiet batch mode", () => {
  function seedCountStep() {
    seedSession({ state: "awaiting_count", batch_id: null, batch_size: null, batch_seq: null, listing_id: null });
    db.tables.jumia_connections = [{ user_id: USER, status: "active", access_token: "real-token" }];
  }

  it("offers a mode choice only when the batch has more than one product", async () => {
    seedCountStep();
    sent.length = 0;

    await handleLinkedMessage(USER, PHONE, "m1", { text: "3" });

    const choice = sent.find((m) => m.body.includes("You can send all 3 in two ways"));
    expect(choice).toBeDefined();
    expect(choice!.kind).toBe("buttons");
    expect(session().batch_quiet ?? false).toBe(false); // unset until they actually pick one
  });

  it("skips the mode choice for a single product — there's no 'in between' to skip", async () => {
    seedCountStep();
    sent.length = 0;

    await handleLinkedMessage(USER, PHONE, "m1", { text: "1" });

    expect(sent.some((m) => m.body.includes("How do you want to send them"))).toBe(false);
    expect(sent.some((m) => m.body.includes("Let's go"))).toBe(true);
  });

  it("sets batchQuiet and sends the rule message when quiet mode is picked", async () => {
    seedSession({ batch_size: 3, batch_seq: 1 });
    sent.length = 0;

    await handleLinkedMessage(USER, PHONE, "m1", { text: "batch_mode:quiet" });

    expect(session().batch_quiet).toBe(true);
    const rule = sent.find((m) => m.body.includes("send product 1's photos"));
    expect(rule).toBeDefined();
    expect(rule!.body).toContain("*1*");
  });

  it("picking 'guide me each step' leaves the existing interactive flow untouched", async () => {
    seedSession({ batch_size: 3, batch_seq: 1 });
    sent.length = 0;

    await handleLinkedMessage(USER, PHONE, "m1", { text: "batch_mode:interactive" });

    expect(session().batch_quiet).toBe(false);
    expect(sent.some((m) => m.body.includes("Let's go — product 1 of 3"))).toBe(true);
  });

  it("stays fully silent between products, closed by each product's own number", async () => {
    seedSession({ batch_size: 3, batch_seq: 1, batch_quiet: true });
    sent.length = 0;

    // Product 1: photo, then a note combined with the closing number —
    // same "Price 40\nDone" shape the interactive flow supports, just
    // with the number instead of the word.
    await handleLinkedMessage(USER, PHONE, "m1", photo("p1a"));
    // Age BEFORE the closing marker — the settle check runs during the
    // marker's own call, not after it returns.
    listings()[0].updated_at = new Date(Date.now() - 60_000).toISOString();
    await handleLinkedMessage(USER, PHONE, "m2", { text: "Price 100\n1" });
    expect(sent).toHaveLength(0);
    expect(session().batch_seq).toBe(2);
    expect(session().listing_id).toBeNull();
    expect(String(listings()[0].user_prompt)).toContain("Price 100");

    // Product 2.
    await handleLinkedMessage(USER, PHONE, "m3", photo("p2a"));
    listings()[1].updated_at = new Date(Date.now() - 60_000).toISOString();
    await handleLinkedMessage(USER, PHONE, "m4", { text: "2" });
    expect(sent).toHaveLength(0);
    expect(session().batch_seq).toBe(3);

    // Product 3 — the LAST one.
    await handleLinkedMessage(USER, PHONE, "m5", photo("p3a"));
    listings()[2].updated_at = new Date(Date.now() - 60_000).toISOString();
    await handleLinkedMessage(USER, PHONE, "m6", { text: "3" });

    // Quiet mode's one reply — the SAME "got everything, drafting now"
    // message the interactive flow already sends once all N products'
    // photos are in, via the shared startBatchAnalysis. Nothing product-
    // specific went out at any of the three closes above.
    expect(sent.some((m) => m.body.includes("Got everything for all 3 products"))).toBe(true);
    expect(session().state).toBe("analyzing");
    expect(enqueued.map((e) => e.seq).sort()).toEqual([1, 2, 3]);
  });

  it("treats a number that doesn't match the current product as a note, not an advance", async () => {
    seedSession({ batch_size: 3, batch_seq: 1, batch_quiet: true });
    await handleLinkedMessage(USER, PHONE, "m1", photo("p1a"));
    sent.length = 0;

    await handleLinkedMessage(USER, PHONE, "m2", { text: "5" });

    expect(sent).toHaveLength(0);
    expect(session().batch_seq).toBe(1);
    expect(session().listing_id).not.toBeNull();
    expect(String(listings()[0].user_prompt)).toContain("5");
  });

  it("also closes on 'done', not just the number", async () => {
    seedSession({ batch_size: 2, batch_seq: 1, batch_quiet: true });
    await handleLinkedMessage(USER, PHONE, "m1", photo("p1a"));
    listings()[0].updated_at = new Date(Date.now() - 60_000).toISOString();
    sent.length = 0;

    await handleLinkedMessage(USER, PHONE, "m2", { text: "done" });

    expect(sent).toHaveLength(0);
    expect(session().batch_seq).toBe(2);
  });

  it("never advances a product with no photo yet — the marker just waits", async () => {
    seedSession({ batch_size: 2, batch_seq: 1, batch_quiet: true });
    sent.length = 0;

    await handleLinkedMessage(USER, PHONE, "m1", { text: "1" });

    expect(sent).toHaveLength(0);
    expect(session().batch_seq).toBe(1);
    expect(listings()).toHaveLength(0);
  });

  it("holds a close marker out until a fresh photo settles, exactly like the interactive flow's guard", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      seedSession({ batch_size: 1, batch_seq: 1, batch_quiet: true });
      await handleLinkedMessage(USER, PHONE, "m1", photo("p1a"));
      // Photo just landed — updated_at is "now", well inside the settle
      // window. Fire the close marker without aging it first.
      sent.length = 0;

      const closing = handleLinkedMessage(USER, PHONE, "m2", { text: "1" });
      let settled = false;
      closing.then(() => { settled = true; });

      await Promise.resolve();
      expect(settled).toBe(false); // still waiting out the window

      jest.advanceTimersByTime(6_000);
      await Promise.resolve();
      await Promise.resolve();
      await closing;

      expect(settled).toBe(true);
      expect(sent.some((m) => m.body.includes("Got everything"))).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("handleSubmit — products that fail to push get ONE compiled follow-up, not one per product", () => {
  // Real screenshot the seller sent, 2026-09-24: two "wasn't sent to
  // Jumia" bubbles, each with its own single "Edit product N" button —
  // read as two unrelated problems. The fix compiles them into one
  // message with a tappable action per product, sized to how many failed.
  const FULL = {
    description: "A long enough description to clear the fifty-character minimum check.",
    category_code: "1234",
    brand: "Panasonic",
    images: ["https://cdn.test/a.jpg"],
    status: "draft",
    selling_price: 150,
  };

  function seedBatch(n: number) {
    db.tables.listings = Array.from({ length: n }, (_, i) => ({
      id: `listing-${i + 1}`,
      user_id: USER,
      whatsapp_batch_id: "batch-1",
      whatsapp_seq: i + 1,
      title: `Drafted product number ${i + 1}`,
      ...FULL,
    }));
  }

  it("compiles 2 push failures into ONE buttons message with an Edit product tap for each", async () => {
    seedBatch(4);
    pushResultFor.set("listing-2", { ok: false, code: "validation", message: "This category requires Weight (kg). Jumia rejects the whole listing without it, so nothing was submitted — add it and submit again." });
    pushResultFor.set("listing-4", { ok: false, code: "validation", message: "This category requires Weight (kg)." });
    seedSession({ state: "awaiting_confirmation", batch_size: 4, batch_seq: null });
    sent.length = 0;

    await handleLinkedMessage(USER, PHONE, "m1", { text: "submit all" });

    // No more one-per-product cta bubbles for the failures.
    expect(sent.filter((m) => m.kind === "cta" && m.body.includes("wasn't sent to Jumia"))).toHaveLength(0);

    const followUp = sent.find((m) => m.kind === "buttons" && m.body.includes("weren't sent to Jumia"));
    expect(followUp).toBeDefined();
    expect(followUp!.body).toContain("Product 2:");
    expect(followUp!.body).toContain("Product 4:");
    expect(followUp!.rows).toEqual(["edit:listing-2", "edit:listing-4"]);
  });

  it("uses a list, not buttons, when more than 3 products fail to push", async () => {
    seedBatch(5);
    for (const id of ["listing-1", "listing-2", "listing-3", "listing-4"]) {
      pushResultFor.set(id, { ok: false, code: "validation", message: "This category requires Weight (kg)." });
    }
    seedSession({ state: "awaiting_confirmation", batch_size: 5, batch_seq: null });
    sent.length = 0;

    await handleLinkedMessage(USER, PHONE, "m1", { text: "submit all" });

    expect(sent.some((m) => m.kind === "buttons" && m.body.includes("weren't sent"))).toBe(false);
    const followUp = sent.find((m) => m.kind === "list");
    expect(followUp).toBeDefined();
    expect(followUp!.rows).toEqual(["edit:listing-1", "edit:listing-2", "edit:listing-3", "edit:listing-4"]);
  });

  it("sends nothing further when every product pushes successfully", async () => {
    seedBatch(2);
    seedSession({ state: "awaiting_confirmation", batch_size: 2, batch_seq: null });
    sent.length = 0;

    await handleLinkedMessage(USER, PHONE, "m1", { text: "submit all" });

    expect(sent.some((m) => m.body.includes("wasn't sent") || m.body.includes("weren't sent"))).toBe(false);
    expect(sent.some((m) => (m.rows ?? []).some((r) => r.startsWith("edit:")))).toBe(false);
  });

  it("compiles a single push failure into one buttons message too, not a bare cta_url link", async () => {
    seedBatch(1);
    pushResultFor.set("listing-1", { ok: false, code: "validation", message: "This category requires Weight (kg)." });
    seedSession({ state: "awaiting_confirmation", batch_size: 1, batch_seq: null });
    sent.length = 0;

    await handleLinkedMessage(USER, PHONE, "m1", { text: "submit all" });

    expect(sent.some((m) => m.kind === "cta" && m.body.includes("wasn't sent"))).toBe(false);
    const followUp = sent.find((m) => m.kind === "buttons" && m.body.includes("wasn't sent to Jumia"));
    expect(followUp).toBeDefined();
    expect(followUp!.body).toContain("Weight (kg)");
    expect(followUp!.rows).toEqual(["edit:listing-1"]);
  });
});

describe("Fix & resubmit", () => {
  const REJECTED_ID = "11111111-1111-1111-1111-111111111111";

  function seedRejectedListing(overrides: Record<string, unknown> = {}) {
    db.tables.listings = [{
      id: REJECTED_ID,
      user_id: USER,
      whatsapp_seq: 1,
      title: "Electric Kettle - Stainless Steel, 1.8L Capacity",
      description: "A long enough description to clear the fifty-character minimum check easily.",
      category_code: "1234",
      category_path: "Home > Kitchen > Kettles",
      brand: "Generic",
      images: ["https://cdn.test/a.jpg"],
      selling_price: 150,
      status: "failed",
      user_prompt: "It's stainless steel, 1.8 litres.",
      jumia_error: "You can't list products in this category. Please choose a different (more specific) category and try again.",
      ...overrides,
    }];
  }

  beforeEach(() => {
    autoAnalyzeCalls.length = 0;
    autoAnalyzeResult = { ok: true };
    pushResult = { ok: true };
    pushCallCount = 0;
  });

  // The exact live case: category rejected as too broad. This used to be
  // "seller"-only because refillAttributesForCategory could never change
  // the category — a full rerun can.
  it("reruns the full draft for a category rejection instead of just handing it back", async () => {
    seedRejectedListing();
    sent.length = 0;

    await handleLinkedMessage(USER, PHONE, "m1", { text: `fix:${REJECTED_ID}` });

    expect(autoAnalyzeCalls).toHaveLength(1);
    expect(autoAnalyzeCalls[0].listingId).toBe(REJECTED_ID);
    // Told which category NOT to repeat...
    expect(autoAnalyzeCalls[0].userPromptOverride).toContain("Home > Kitchen > Kettles");
    // ...and the seller's own original note survives into the rerun.
    expect(autoAnalyzeCalls[0].userPromptOverride).toContain("1.8 litres");
    expect(sent.some((m) => m.body.includes("Fixing and resubmitting"))).toBe(true);
    expect(sent.some((m) => m.body.includes("resubmitted"))).toBe(true);
    expect(pushCallCount).toBe(1);
  });

  // Real production symptom (2026-09-17/18 chat log): the SAME "Fix &
  // resubmit" tap produced interleaved "Fixing and resubmitting..."
  // messages and redundant AI reruns for one product — consistent with
  // WhatsApp redelivering the button tap because handleFixAndResubmit
  // (an AI rerun + a Jumia push) ran past Meta's own webhook ack timeout.
  // The old dedupe only wrote session.lastMessageId back AFTER the whole
  // handler finished, so a redelivery arriving before that write read the
  // same stale value and ran the whole thing again. It's now claimed
  // atomically up front (see claim_message_id) — a second delivery of the
  // identical wamid must never reach runAutoAnalyze or pushListingToJumia
  // at all.
  it("never reruns/re-pushes for a redelivered copy of the same fix: tap", async () => {
    seedRejectedListing();
    sent.length = 0;

    await handleLinkedMessage(USER, PHONE, "dup-wamid", { text: `fix:${REJECTED_ID}` });
    await handleLinkedMessage(USER, PHONE, "dup-wamid", { text: `fix:${REJECTED_ID}` });

    expect(autoAnalyzeCalls).toHaveLength(1);
    expect(pushCallCount).toBe(1);
  });

  // notifyBatchResolved (lib/jumia/push-listing.ts) now puts every item —
  // live or rejected — behind the same fix:<listingId> id in its "Pick a
  // product" list, so a seller can tap an already-live row from that same
  // list. Without this guard, extractRejectionText(null) => "" =>
  // classifyJumiaRejection("") => kind: "unknown" => isAutoFixable ===
  // true, which would happily redraft-and-repush a product Jumia already
  // approved.
  it("does nothing but confirm when there's no rejection to fix — e.g. a tap on an already-live row", async () => {
    seedRejectedListing({ status: "live", jumia_error: null });
    sent.length = 0;

    await handleLinkedMessage(USER, PHONE, "m1", { text: `fix:${REJECTED_ID}` });

    expect(autoAnalyzeCalls).toHaveLength(0);
    expect(pushCallCount).toBe(0);
    expect(sent.some((m) => m.body.includes("already live"))).toBe(true);
  });

  // Never fixed by a redraft — no amount of rerunning invents a price.
  it("still refuses to auto-fix a price/stock rejection", async () => {
    seedRejectedListing({ jumia_error: "The Global Price is mandatory in order to create a Product." });
    sent.length = 0;

    await handleLinkedMessage(USER, PHONE, "m1", { text: `fix:${REJECTED_ID}` });

    expect(autoAnalyzeCalls).toHaveLength(0);
    expect(pushCallCount).toBe(0);
    expect(sent.some((m) => m.body.includes("needs you"))).toBe(true);
  });

  // Never fixed by a redraft — a rerun can't re-upload a file.
  it("still refuses to auto-fix an image-format rejection", async () => {
    seedRejectedListing({ jumia_error: "Product Image [a.gif] extension [gif] is not allowed." });
    sent.length = 0;

    await handleLinkedMessage(USER, PHONE, "m1", { text: `fix:${REJECTED_ID}` });

    expect(autoAnalyzeCalls).toHaveLength(0);
    expect(pushCallCount).toBe(0);
  });

  it("reports a failed rerun rather than pushing a stale draft", async () => {
    seedRejectedListing();
    autoAnalyzeResult = { ok: false, message: "no confident category" };
    sent.length = 0;

    await handleLinkedMessage(USER, PHONE, "m1", { text: `fix:${REJECTED_ID}` });

    expect(sent.some((m) => m.body.includes("couldn't redraft it"))).toBe(true);
    expect(pushCallCount).toBe(0);
  });

  // The rerun succeeded but Jumia still isn't happy — say so plainly
  // rather than looping the same automatic fix forever.
  it("reports a second rejection instead of retrying silently", async () => {
    seedRejectedListing();
    pushResult = { ok: false, message: "You can't list products in this category. Please choose a different (more specific) category and try again." };
    sent.length = 0;

    await handleLinkedMessage(USER, PHONE, "m1", { text: `fix:${REJECTED_ID}` });

    expect(autoAnalyzeCalls).toHaveLength(1);
    expect(sent.some((m) => m.body.includes("still isn't happy"))).toBe(true);
  });

  // A price the seller still hasn't supplied blocks the whole flow before
  // any AI call, regardless of what Jumia's own error text says.
  it("checks for missing seller-owned fields before spending an AI call", async () => {
    seedRejectedListing({ selling_price: null });
    sent.length = 0;

    await handleLinkedMessage(USER, PHONE, "m1", { text: `fix:${REJECTED_ID}` });

    expect(autoAnalyzeCalls).toHaveLength(0);
    expect(sent.some((m) => m.body.includes("still needs"))).toBe(true);
  });
});
