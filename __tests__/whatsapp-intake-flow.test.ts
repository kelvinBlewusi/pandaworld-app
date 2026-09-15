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
const sent: { to: string; body: string; kind: string }[] = [];

jest.mock("@/lib/supabase/server", () => ({
  createServerClient: () => db,
}));

jest.mock("@/lib/whatsapp/client", () => ({
  sendTextIfConfigured:    async (to: string, body: string) => { sent.push({ to, body, kind: "text" }); },
  sendButtonsIfConfigured: async (to: string, body: string) => { sent.push({ to, body, kind: "buttons" }); },
  sendCtaUrlIfConfigured:  async (to: string, body: string) => { sent.push({ to, body, kind: "cta" }); },
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
  db.rpcCalls.length = 0;
  sent.length = 0;
  enqueued.length = 0;
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
