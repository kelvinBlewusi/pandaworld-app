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
  sendButtonsIfConfigured: async (to: string, body: string) => { sent.push({ to, body, kind: "buttons" }); },
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
});
