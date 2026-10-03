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
const sent: { to: string; body: string; kind: string; rows?: string[]; link?: string }[] = [];
// Set to make the next image send fail, as Meta refusing it would.
let failImageSends = false;

jest.mock("@/lib/supabase/server", () => ({
  createServerClient: () => db,
}));

// Meta's caps on a message's text, refused the way the Graph API refuses
// them (a 400, nothing sent): 4096 for plain text, 1024 for any
// interactive body. A 20-product summary of 1,731 in a list was refused
// live (2026-10-02), so every test here holds the bot to them.
function metaAccepts(body: string, max: number): void {
  if (body.length < 1 || body.length > max) {
    throw new Error(`WhatsApp send failed (400): Body text length invalid. Min length: 1, Max length: ${max} (got ${body.length})`);
  }
}
// Settable per test: the next list send fails as Meta would refuse it.
let failNextList = false;

jest.mock("@/lib/whatsapp/client", () => ({
  sendTextIfConfigured:    async (to: string, body: string) => { metaAccepts(body, 4096); sent.push({ to, body, kind: "text" }); },
  sendButtonsIfConfigured: async (to: string, body: string, buttons: { id: string }[]) => {
    metaAccepts(body, 1024);
    sent.push({ to, body, kind: "buttons", rows: buttons.map((b) => b.id) });
  },
  sendCtaUrlIfConfigured:  async (to: string, body: string) => { metaAccepts(body, 1024); sent.push({ to, body, kind: "cta" }); },
  sendImageIfConfigured:   async (to: string, link: string, caption?: string) => {
    if (failImageSends) throw new Error("WhatsApp send failed (400): media download error");
    sent.push({ to, body: caption ?? "", kind: "image", link });
  },
  sendListIfConfigured:    async (to: string, body: string, _btn: string, rows: { id: string }[]) => {
    if (failNextList) {
      failNextList = false;
      throw new Error("WhatsApp send failed (400): (#131009) Parameter value is not valid");
    }
    metaAccepts(body, 1024);
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
const nudges: number[] = [];
jest.mock("@/lib/whatsapp/analysis-queue", () => ({
  enqueueAnalysisJobs: async (p: { listings: { listingId: string; seq: number | null }[] }) => {
    enqueued.push(...p.listings);
    return p.listings.length;
  },
  nudgeWorker:   (workers?: number) => { nudges.push(workers ?? 1); },
  workersFor:    jest.requireActual("@/lib/whatsapp/analysis-queue").workersFor,
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
  | { ok: false; message: string; code?: "validation" | "already_submitted"; needsReconnect?: boolean };
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
// Settable per test — fields a listing's category requires, reported as
// missing (readiness.ts's missingFields) until the listing has a value.
type TestAttr = { name: string; label: string; type: string; allowed_values: string[]; required: boolean; is_variant: boolean };
const requiredFieldsFor = new Map<string, TestAttr[]>();
const WEIGHT: TestAttr = { name: "product_weight", label: "Weight (kg)", type: "string", allowed_values: [], required: true, is_variant: false };
// Settable per test — Held reasons to report verbatim for a listing.
const heldReasonsFor = new Map<string, string[]>();
// Pack features (lib/billing/features.ts): on by default, as while billing
// is off; the QC-gate tests turn it off.
let qcFeature = true;
jest.mock("@/lib/billing/features", () => ({
  hasFeature:         async () => qcFeature,
  featureMinPackName: () => "Standard",
}));

jest.mock("@/lib/whatsapp/readiness", () => ({
  assessListingPushReadiness: async (_userId: string, listingId: string) => {
    if (heldReasonsFor.has(listingId)) {
      return { ready: false, reasons: heldReasonsFor.get(listingId) };
    }
    if (needsReconnectFor.has(listingId)) {
      return { ready: false, reasons: ["Jumia needs to be (re)connected before this can be checked"], needsReconnect: true };
    }
    const { missingFieldLabels } = jest.requireActual("@/lib/jumia/push-listing");
    const row = db.tables.listings.find((l) => l.id === listingId);
    if (!row) return { ready: false, reasons: ["listing not found"] };
    const missing = missingFieldLabels(row);
    if (missing.length > 0) return { ready: false, reasons: missing.map((m: string) => `needs ${m}`) };
    const { columnFor } = jest.requireActual("@/lib/jumia/attribute-mapping");
    const missingFields = (requiredFieldsFor.get(listingId) ?? []).filter((a) => {
      const col = columnFor(a.name);
      const value = col ? row[col] : (row.dynamic_attributes as Record<string, unknown> | undefined)?.[a.name];
      return value == null || String(value).trim() === "";
    });
    return missingFields.length > 0
      ? { ready: false, reasons: [`this category also needs ${missingFields.map((a) => a.label).join(", ")}`], missingFields }
      : { ready: true, reasons: [] };
  },
}));

// The category question's pieces that reach past the database: the
// category catalogue (a process-cached 27k-row read in production) and the
// Gemini-backed attribute refill. Both stand-ins record what they were
// asked for, so a test can assert which category was actually applied.
const CATEGORY_ROWS = [
  { code: 1000176, path: "Phones & Tablets > Accessories > Portable Power Banks" },
  { code: 1017621, path: "Electronics > Accessories > External Battery Packs" },
  { code: 1000279, path: "Phones & Tablets > Mobile Accessories > Portable Power Banks & Battery Packs" },
  { code: 3000001, path: "Phones & Tablets > Mobile Accessories > Chargers" },
  { code: 3000002, path: "Electronics > Accessories > Chargers" },
  { code: 1029505, path: "Phones & Tablets > Tablets > Educational Tablets" },
  { code: 1002640, path: "Phones & Tablets > Tablet Accessories > Bags, Cases & Sleeves > Cases" },
  { code: 1002623, path: "Phones & Tablets > Tablet Accessories > Bags, Cases & Sleeves > Bags" },
].map((c) => ({
  ...c,
  name: c.path.split(" > ").pop()!,
  parent_code: null, level: 3, is_leaf: true, attribute_set_sid: `sid-${c.code}`, attribute_set_name: null,
}));
// What the AI fills for a held draft's missing fields (autoFillMissingFields).
let autoFillValues: Record<string, string> = {};
const autoFillCalls: (string[] | undefined)[] = [];
jest.mock("@/lib/actions/ai", () => ({
  ...jest.requireActual("@/lib/actions/ai"),
  extractAttributesForCategory: async (_images: string[], _code: number, _ctx: string | null, opts?: { only?: string[] }) => {
    autoFillCalls.push(opts?.only);
    return { dynamic_attributes: autoFillValues, field_sources: {}, field_confidence: {} };
  },
}));

jest.mock("@/lib/jumia/categories", () => ({
  ...jest.requireActual("@/lib/jumia/categories"),
  getCategoryAttributes: async (code: number) => {
    const fields = Array.from(requiredFieldsFor.values()).flat();
    return fields.length > 0 && code === 1015907 ? fields : [];
  },
  getListableCategories: async () => CATEGORY_ROWS,
  getCategoryByCode:     async (code: number) => CATEGORY_ROWS.find((c) => c.code === code) ?? null,
}));

const refillCalls: { listingId: string; code: number }[] = [];
jest.mock("@/lib/jumia/refill-attributes", () => ({
  refillAttributesForCategory: async (_userId: string, listingId: string, code: number) => {
    refillCalls.push({ listingId, code });
    // Mirrors the real refill's writes: the new category, marked as the
    // seller's choice (its own unit test covers that rule).
    const field_sources = { "dynamic_attributes.color": "ai", category_code: "user" };
    const row = db.tables.listings.find((l) => l.id === listingId);
    if (row) Object.assign(row, { category_code: String(code), field_sources });
    return {
      ok: true, category: { code, name: "x", path: "x" }, attributesSchema: 2, aiFilled: 1,
      dynamic_attributes: {}, field_sources, field_confidence: {},
    };
  },
}));

// Connecting Jumia from the chat: the Self Authorization exchange and the
// Web Application credential check both reach Jumia, so both are stood in
// for here and record what they were asked.
type SelfAuthMockResult =
  | { ok: true; storeName: string }
  | { ok: false; reason: "web_app" | "bad_token"; error: string };
let selfAuthResult: SelfAuthMockResult = { ok: true, storeName: "Kelvin's Store" };
const selfAuthCalls: { clientId: string; token: string; country: string }[] = [];
jest.mock("@/lib/jumia/self-auth", () => ({
  ...jest.requireActual("@/lib/jumia/self-auth"),
  connectSelfAuthorization: async (_userId: string, clientId: string, token: string, country: string) => {
    selfAuthCalls.push({ clientId, token, country });
    return selfAuthResult;
  },
}));
let webCredentialsValid = true;
const webCredentialChecks: string[] = [];
jest.mock("@/lib/jumia/credentials", () => ({
  ...jest.requireActual("@/lib/jumia/credentials"),
  testJumiaCredentials: async (appId: string) => {
    webCredentialChecks.push(appId);
    return webCredentialsValid ? { ok: true, message: "ok" } : { ok: false, error: "Invalid App ID or Secret Key." };
  },
  saveJumiaCredentialsForUser: async () => ({ ok: true }),
}));

import { handleLinkedMessage } from "@/lib/whatsapp/intake";
import { classifyJumiaRejection, rejectionFingerprint } from "@/lib/jumia/rejection-remedy";

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
  requiredFieldsFor.clear();
  autoFillValues = {};
  autoFillCalls.length = 0;
  heldReasonsFor.clear();
  pushResultFor.clear();
  pushResult = { ok: true };
  pushCallCount = 0;
  failNextList = false;
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
  // own Done button, in about four seconds. Cut to one per burst, then to
  // none (2026-10-01): Meta charges per message the bot sends, and "done"
  // reports the photo count anyway.
  it("sends nothing per photo", async () => {
    await handleLinkedMessage(USER, PHONE, "m1", photo("a"));
    await handleLinkedMessage(USER, PHONE, "m2", photo("b"));
    await handleLinkedMessage(USER, PHONE, "m3", photo("c"));

    expect(sent).toHaveLength(0);
    expect(listings()[0].images).toHaveLength(3);
  });

  // Live, 2026-09-27: seven photos, the first captioned "150", drew
  // "📸 Product 1: got it." and then "📸 Product 1: got it, notes saved." a
  // second later — the captioned photo replied outside the burst claim.
  it.each([
    ["the captioned photo lands first", [{ imageMediaId: "a", text: "150" }, photo("b"), photo("c")]],
    ["a plain photo lands first", [photo("a"), { imageMediaId: "b", text: "150" }, photo("c")]],
  ])("saves an album's price caption without a reply when %s", async (_label, deliveries) => {
    for (let i = 0; i < deliveries.length; i++) await handleLinkedMessage(USER, PHONE, `m${i}`, deliveries[i]);

    expect(sent).toHaveLength(0);
    expect(listings()[0].user_prompt).toContain("150");
  });

  it("says the notes were saved on done, whichever photo confirmed the album", async () => {
    await handleLinkedMessage(USER, PHONE, "m1", photo("a"));
    await handleLinkedMessage(USER, PHONE, "m2", { imageMediaId: "b", text: "150" });
    listings()[0].updated_at = new Date(Date.now() - 60_000).toISOString();

    await handleLinkedMessage(USER, PHONE, "m3", { text: "done" });

    expect(sent.some((m) => m.body.includes("(2 photos, notes saved)"))).toBe(true);
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

// Live, 2026-10-01: "Product 1: ⚠️ Held — this category also needs Weight
// (kg)", and the only way on was the editor.
describe("a field the category requires, filled or asked for in chat", () => {
  const SHOWER = {
    id: "listing-1", user_id: USER, whatsapp_batch_id: "batch-1", whatsapp_seq: 1,
    title: "Olive & Milk Shower Cream", selling_price: 240, status: "draft",
    description: "A long enough description to clear the fifty-character minimum check.",
    category_code: "1015907", brand: "Palmolive", images: ["https://cdn.test/a.jpg"],
    dynamic_attributes: {}, field_sources: {}, field_confidence: {}, weight_kg: null,
  };

  function heldForWeight(patch: Record<string, unknown> = {}) {
    db.tables.listings = [{ ...SHOWER, ...patch }];
    requiredFieldsFor.set("listing-1", [WEIGHT]);
    seedSession({ state: "awaiting_confirmation", batch_size: 1, batch_seq: null });
    sent.length = 0;
  }

  it("fills a weight itself when the AI can estimate it, and never asks", async () => {
    heldForWeight();
    autoFillValues = { product_weight: "0.3" };

    const { finalizeBatch } = await import("@/lib/whatsapp/intake");
    await finalizeBatch("batch-1", PHONE, 1);

    expect(autoFillCalls).toEqual([["product_weight"]]);
    expect(listings()[0].weight_kg).toBe(0.3);
    expect(listings()[0].field_sources).toMatchObject({ weight_kg: "ai" });
    expect(sent.some((m) => m.body.includes("Ready to submit"))).toBe(true);
    expect(sent.some((m) => m.body.includes("Jumia needs its"))).toBe(false);
  });

  it("asks for it when it can't be filled, and saves the seller's answer", async () => {
    heldForWeight();

    const { finalizeBatch } = await import("@/lib/whatsapp/intake");
    await finalizeBatch("batch-1", PHONE, 1);

    const ask = sent.find((m) => m.body.includes("Jumia needs its *Weight (kg)*"));
    expect(ask).toBeDefined();
    expect(ask!.rows).toEqual(["skip value"]);
    expect(sent.some((m) => m.body.includes("Answer the question below"))).toBe(true);
    expect(session().awaiting_value_for).toEqual({ listingId: "listing-1", field: "product_weight" });

    sent.length = 0;
    await handleLinkedMessage(USER, PHONE, "m1", { text: "500g" });

    expect(listings()[0].weight_kg).toBe(0.5);
    expect(listings()[0].field_sources).toMatchObject({ weight_kg: "user" });
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toBe("✅ Weight (kg) set to 0.5 kg for Olive & Milk Shower Cream — ready to submit.");
    expect(sent[0].rows).toEqual(["submit all"]);
    expect(session().awaiting_value_for).toBeNull();
  });

  it("keeps the question open with a hint when the reply isn't a weight", async () => {
    heldForWeight();
    seedSession({ state: "awaiting_confirmation", batch_size: 1, batch_seq: null, awaiting_value_for: { listingId: "listing-1", field: "product_weight" } });

    await handleLinkedMessage(USER, PHONE, "m1", { text: "heavy" });

    expect(sent[0].body).toContain("Reply with the weight in kg");
    expect(listings()[0].weight_kg).toBeNull();
    expect(session().awaiting_value_for).toEqual({ listingId: "listing-1", field: "product_weight" });
  });

  it("offers a field's allowed values to tap, and saves the one tapped", async () => {
    const GENDER: TestAttr = { name: "gender", label: "Gender", type: "enum", allowed_values: ["Female", "Male", "Unisex"], required: true, is_variant: false };
    db.tables.listings = [{ ...SHOWER, weight_kg: 0.3 }];
    requiredFieldsFor.set("listing-1", [GENDER]);
    seedSession({ state: "awaiting_confirmation", batch_size: 1, batch_seq: null });
    sent.length = 0;

    const { finalizeBatch } = await import("@/lib/whatsapp/intake");
    await finalizeBatch("batch-1", PHONE, 1);

    const ask = sent.find((m) => m.body.includes("Jumia needs its *Gender*"))!;
    expect(ask.kind).toBe("list");
    expect(ask.rows).toEqual(["value:0", "value:1", "value:2", "skip value"]);

    sent.length = 0;
    await handleLinkedMessage(USER, PHONE, "m1", { text: "value:2" });

    expect(listings()[0].dynamic_attributes).toMatchObject({ gender: "Unisex" });
    expect(sent[0].body).toContain("Gender set to Unisex");
  });

  it("moves on when the seller skips", async () => {
    heldForWeight();
    seedSession({ state: "awaiting_confirmation", batch_size: 1, batch_seq: null, awaiting_value_for: { listingId: "listing-1", field: "product_weight" } });

    await handleLinkedMessage(USER, PHONE, "m1", { text: "skip value" });

    expect(session().awaiting_value_for).toBeNull();
    expect(sent.some((m) => m.body.includes("fill it in on the review page"))).toBe(true);
  });

  it("asks after the price, once every price is in", async () => {
    heldForWeight({ selling_price: null });
    seedSession({ state: "awaiting_confirmation", batch_size: 1, batch_seq: null, awaiting_price_for: "listing-1" });

    await handleLinkedMessage(USER, PHONE, "m1", { text: "240" });

    const reply = sent.find((m) => m.body.includes("Price set to GHS 240"))!;
    expect(reply.body).toContain("Jumia needs its *Weight (kg)*");
    expect(session().awaiting_value_for).toEqual({ listingId: "listing-1", field: "product_weight" });
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

    const draftMsg = sent.find((m) => m.body.includes("Product drafted"));
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

    const draftMsg = sent.find((m) => m.body.includes("Product drafted"));
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

    const draftMsg = sent.find((m) => m.body.includes("Product drafted"));
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

    const draftMsg = sent.find((m) => m.body.includes("Product drafted"));
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

    // The other two still get their normal Ready/Held status line, and
    // there's none for product 2 — that's the per-seq bubble's job. (The
    // closing line in the same message names it for a retry.)
    const statusMessage = sent.find((m) => m.body.includes("Product 1:"));
    expect(statusMessage?.body).toContain("Product 1: ✅ Ready");
    expect(statusMessage?.body).toContain("Product 3: ✅ Ready");
    expect(statusMessage?.body).not.toContain("Product 2:");
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

    const status = sent.find((m) => m.body.includes("Product 1:"));
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

    const status = sent.find((m) => m.body.includes("Product 1:"));
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

    const draftMsg = sent.find((m) => m.body.includes("Product drafted"));
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

    const draftMsg = sent.find((m) => m.body.includes("Product drafted"));
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

  // The status lines, the closing line and the submit actions are ONE
  // message (they were three until 2026-10-01, when Meta started charging
  // per message the bot sends). Two ready products fit inline buttons.
  it("sends a small batch's status, closing line and submit buttons as one message", async () => {
    seedDrafted(2);
    seedSession({ state: "awaiting_confirmation", batch_size: 2, batch_seq: null });
    sent.length = 0;

    const { finalizeBatch } = await import("@/lib/whatsapp/intake");
    await finalizeBatch("batch-1", PHONE, 2);

    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe("buttons");
    expect(sent[0].rows).toEqual(["submit all", "submit 1", "submit 2"]);
    expect(sent[0].body).toContain("Product 1: ✅ Ready");
    expect(sent[0].body).toContain("Done drafting your 2 products");
  });

  it("uses one list from three ready products", async () => {
    seedDrafted(3);
    seedSession({ state: "awaiting_confirmation", batch_size: 3, batch_seq: null });
    sent.length = 0;

    const { finalizeBatch } = await import("@/lib/whatsapp/intake");
    await finalizeBatch("batch-1", PHONE, 3);

    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe("list");
    expect(sent[0].rows).toEqual(["submit all", "submit 1", "submit 2", "submit 3", "restart"]);
    expect(sent[0].body).toContain("Product 3: ✅ Ready");
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
    expect(list.rows).toEqual(["submit all", "submit 1", "submit 2", "submit 4", "submit 5", "restart"]);
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

    const statusMessages = sent.filter((m) => m.body.includes("Product 1:"));
    expect(statusMessages).toHaveLength(1);
    const body = statusMessages[0].body;
    expect(body).toContain("Product 1: ✅ Ready — Drafted product number 1.");
    expect(body).toContain("Product 2: ⚠️ Held — needs price.");
    expect(body).toContain("Product 3: ✅ Ready — Drafted product number 3.");
  });

  // Live, 2026-10-02: a 20-product batch's summary (1,731 characters) went
  // in one list, Meta refused it, and the batch ended in silence: no
  // summary, no Submit, no price questions.
  function seedTwentyLong() {
    seedDrafted(20);
    for (const l of db.tables.listings) l.title = `${l.title} - Long Descriptive Name, Extra Words, Adjustable`;
    db.tables.listings[5].selling_price = null;
    seedSession({ state: "awaiting_confirmation", batch_size: 20, batch_seq: null });
    sent.length = 0;
  }

  it("sends a 20-product summary as text, then the list with just the closing line", async () => {
    seedTwentyLong();

    const { finalizeBatch } = await import("@/lib/whatsapp/intake");
    await finalizeBatch("batch-1", PHONE, 20);

    const status = sent.find((m) => m.kind === "text" && m.body.includes("Product 1: ✅ Ready"))!;
    expect(status.body).toContain("Product 20: ✅ Ready");
    const list = sent.find((m) => m.kind === "list")!;
    expect(list.body).toMatch(/^🎉 Done drafting your 20 products! Reply \*submit all\*/);
    expect(list.body).not.toContain("Product 1:");
    expect(list.rows).toHaveLength(10);
    expect(sent.indexOf(status)).toBeLessThan(sent.indexOf(list));
    expect(sent.some((m) => m.body.includes("What price are you selling it at?"))).toBe(true);
  });

  it("still tells the seller the batch is done when Meta refuses the list", async () => {
    seedTwentyLong();
    failNextList = true;

    const { finalizeBatch } = await import("@/lib/whatsapp/intake");
    await finalizeBatch("batch-1", PHONE, 20);

    expect(sent.filter((m) => m.body.includes("Product 1: ✅ Ready"))).toHaveLength(1);
    expect(sent.some((m) => m.kind === "text" && m.body.includes("Reply *submit all* when ready"))).toBe(true);
    expect(sent.some((m) => m.body.includes("What price are you selling it at?"))).toBe(true);
  });

  it("answers status on a 20-product batch", async () => {
    seedTwentyLong();

    await handleLinkedMessage(USER, PHONE, "m1", { text: "status" });

    expect(sent.some((m) => m.body.includes("20. Drafted product number 20"))).toBe(true);
  });

  it("ends a Held line with one full stop even when the reason already has one", async () => {
    seedDrafted(2);
    heldReasonsFor.set("listing-1", ['This looks like "Meat" — Jumia blocks that product type in GH, so nothing was sent.']);
    seedSession({ state: "awaiting_confirmation", batch_size: 2, batch_seq: null });
    sent.length = 0;

    const { finalizeBatch } = await import("@/lib/whatsapp/intake");
    await finalizeBatch("batch-1", PHONE, 2);

    const body = sent.find((m) => m.body.includes("Product 1:"))!.body;
    expect(body).toContain("in GH, so nothing was sent.\n");
    expect(body).not.toContain("..");
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

  it("sets batchQuiet and sends the rule as the caption of a worked example, in one message", async () => {
    seedSession({ batch_size: 3, batch_seq: 1 });
    sent.length = 0;

    await handleLinkedMessage(USER, PHONE, "m1", { text: "batch_mode:quiet" });

    expect(session().batch_quiet).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe("image");
    expect(sent[0].link).toMatch(/\/whatsapp\/quiet-mode-example\.jpg\?v=\d+$/);
    expect(sent[0].body).toBe("Got it — send product 1's photos, then reply *1* once you're done with it, like in the example above.");
  });

  it("still sends the rule as text when the example image is refused", async () => {
    seedSession({ batch_size: 3, batch_seq: 1 });
    sent.length = 0;
    failImageSends = true;
    try {
      await handleLinkedMessage(USER, PHONE, "m1", { text: "batch_mode:quiet" });
    } finally {
      failImageSends = false;
    }

    expect(sent.map((m) => [m.kind, m.body])).toEqual([
      ["text", "Got it — send product 1's photos, then reply *1* once you're done with it."],
    ]);
  });

  it("sends no example image for 'guide me each step'", async () => {
    seedSession({ batch_size: 3, batch_seq: 1 });
    sent.length = 0;

    await handleLinkedMessage(USER, PHONE, "m1", { text: "batch_mode:interactive" });

    expect(sent.some((m) => m.kind === "image")).toBe(false);
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
    const drafting = sent.find((m) => m.body.includes("Got everything for all 3 products"));
    expect(drafting).toBeDefined();
    // "Bigger batch" is for 10-20 products, not 3.
    expect(drafting!.body).not.toContain("bigger batch");
    expect(session().state).toBe("analyzing");
    expect(enqueued.map((e) => e.seq).sort()).toEqual([1, 2, 3]);
    // Two workers (two products each), so product 3 doesn't wait for the
    // next cron tick.
    expect(nudges.at(-1)).toBe(2);
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

  // Silence here let the next product's photos land on this one.
  it("never advances a product with no photo, and says so", async () => {
    seedSession({ batch_size: 2, batch_seq: 1, batch_quiet: true });
    sent.length = 0;

    await handleLinkedMessage(USER, PHONE, "m1", { text: "Price 40\n1" });

    expect(sent.map((m) => m.body)).toEqual(["I haven't received any photos for product 1 yet. Send them, then reply *1*."]);
    expect(session().batch_seq).toBe(1);
    expect(listings()).toHaveLength(0);
    // The note waits for the photo; the marker isn't kept as a note.
    expect(session().pending_notes).toBe("Price 40");
  });

  // Live, 2026-10-01: product 1's photo and "1" a second apart. The "1"
  // was handled before the photo had made the listing, so it was filed as
  // a note, product 1 never closed, and products 2 to 4 landed on it.
  it("closes a product whose photo is still being handled when its number arrives", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      seedSession({ batch_size: 2, batch_seq: 1, batch_quiet: true });
      // The webhook logs every message on arrival, before handling it.
      db.tables.whatsapp_message_log = [{ phone_number: PHONE, direction: "inbound", message_type: "image", created_at: new Date().toISOString() }];
      sent.length = 0;

      const closing = handleLinkedMessage(USER, PHONE, "m2", { text: "1" });
      await jest.advanceTimersByTimeAsync(0);
      expect(listings()).toHaveLength(0); // the "1" is waiting for the photo

      await handleLinkedMessage(USER, PHONE, "m1", { imageMediaId: "p1a", text: "Brand is Palmolive\nPrice 240" });
      await jest.advanceTimersByTimeAsync(8_000);
      await closing;

      expect(sent).toHaveLength(0);
      expect(session().batch_seq).toBe(2);
      expect(session().listing_id).toBeNull();
      expect(session().pending_notes).toBeNull();
      expect(String(listings()[0].user_prompt)).toBe("Brand is Palmolive\nPrice 240");

      await handleLinkedMessage(USER, PHONE, "m3", photo("p2a"));
      expect(listings()).toHaveLength(2);
      expect(listings()[0].images).toEqual(["https://cdn.test/p1a.jpg"]);
      expect(listings()[1].images).toEqual(["https://cdn.test/p2a.jpg"]);
    } finally {
      jest.useRealTimers();
      db.tables.whatsapp_message_log = [];
    }
  });

  // The same session read "2" as a price of 2, and later "4" as 4.
  it("says it's still on the open product when a later product's number arrives, and never takes it as a price", async () => {
    seedSession({ batch_size: 4, batch_seq: 1, batch_quiet: true });
    await handleLinkedMessage(USER, PHONE, "m1", { imageMediaId: "p1a", text: "Price 240" });
    await handleLinkedMessage(USER, PHONE, "m2", photo("p2a"));
    sent.length = 0;

    await handleLinkedMessage(USER, PHONE, "m3", { text: "2" });

    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain("I'm still on product 1 of 4, which has 2 photos so far. Reply *1* to finish it, then send product 2's photos and *2*.");
    expect(sent[0].rows).toEqual(["restart"]);
    expect(session().batch_seq).toBe(1);
    expect(listings()[0].selling_price).toBe(240);
    expect(String(listings()[0].user_prompt)).toBe("Price 240");
  });

  it("ignores an earlier product's number, which is already closed", async () => {
    seedSession({ batch_size: 3, batch_seq: 2, batch_quiet: true });
    await handleLinkedMessage(USER, PHONE, "m1", { imageMediaId: "p2a", text: "Price 89" });
    sent.length = 0;

    await handleLinkedMessage(USER, PHONE, "m2", { text: "1" });

    expect(sent).toHaveLength(0);
    expect(session().batch_seq).toBe(2);
    expect(listings()[0].selling_price).toBe(89);
  });

  // "Price GHC 89, Category is wigs" was lost with a photo over the cap.
  it("keeps the caption of a photo sent over the photo limit", async () => {
    seedSession({ batch_size: 2, batch_seq: 1, batch_quiet: true });
    for (let i = 0; i < 8; i++) await handleLinkedMessage(USER, PHONE, `m${i}`, photo(`p${i}`));
    sent.length = 0;

    await handleLinkedMessage(USER, PHONE, "m9", { imageMediaId: "p9", text: "Price GHC 89\nCategory is wigs" });

    expect(sent).toHaveLength(0);
    expect(listings()[0].images).toHaveLength(8);
    expect(String(listings()[0].user_prompt)).toContain("Category is wigs");
  });

  // A note that overtook its photo is parked; the photo's delivery only
  // applies what it saw parked when it started, so one parked a moment
  // later was cleared unread by the close.
  it("applies a note still parked when the product closes, instead of clearing it", async () => {
    seedSession({ batch_size: 2, batch_seq: 1, batch_quiet: true });
    await handleLinkedMessage(USER, PHONE, "m1", photo("p1a"));
    session().pending_notes = "Brand is Palmolive";
    listings()[0].updated_at = new Date(Date.now() - 60_000).toISOString();

    await handleLinkedMessage(USER, PHONE, "m2", { text: "1" });

    expect(session().batch_seq).toBe(2);
    expect(session().pending_notes).toBeNull();
    expect(String(listings()[0].user_prompt)).toContain("Brand is Palmolive");
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
    // Named, so "Edit product 2" says which product that is.
    expect(followUp!.body).toContain("Product 2 (Drafted product number 2): This category requires Weight (kg).");
    expect(followUp!.body).toContain("Product 4 (Drafted product number 4):");
    expect(followUp!.rows).toEqual(["edit:listing-2", "edit:listing-4"]);
  });

  it("lists 20 products that failed to push, their reasons as text first", async () => {
    seedBatch(20);
    for (let i = 1; i <= 20; i++) {
      pushResultFor.set(`listing-${i}`, { ok: false, code: "validation", message: "This category requires Weight (kg). Jumia rejects the whole listing without it." });
    }
    seedSession({ state: "awaiting_confirmation", batch_size: 20, batch_seq: null });
    sent.length = 0;

    await handleLinkedMessage(USER, PHONE, "m1", { text: "submit all" });

    expect(sent.some((m) => m.kind === "text" && m.body.startsWith("20 products weren't sent to Jumia:"))).toBe(true);
    const lists = sent.filter((m) => m.kind === "list");
    expect(lists[0].body).toBe("Tap a product to fix it:");
    expect(lists.flatMap((l) => l.rows)).toHaveLength(20);
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

  // A category rejection whose redraft fails asks the seller instead —
  // see "asking the seller for a category" below.
  it("reports a failed rerun rather than pushing a stale draft", async () => {
    seedRejectedListing({ jumia_error: "The title contains the brand name, seller name or company name." });
    autoAnalyzeResult = { ok: false, message: "describe failed" };
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

// Real case, 2026-09-27: a power bank was refused in "Portable Power Banks",
// the automatic redraft moved it to "External Battery Packs", and Jumia
// refused that too. The seller could see in Vendor Center which category
// works; the bot could only send them to the editor. Now it asks.
describe("asking the seller for a category after Jumia refuses ours twice", () => {
  const LISTING_ID = "22222222-2222-2222-2222-222222222222";
  const CANT_LIST = "You can't list products in this category. Please choose a different (more specific) category and try again.";
  const CANT_LIST_FINGERPRINT = rejectionFingerprint(classifyJumiaRejection(CANT_LIST).kind, CANT_LIST);

  function seedTwiceRefused(overrides: Record<string, unknown> = {}) {
    db.tables.listings = [{
      id: LISTING_ID,
      user_id: USER,
      whatsapp_seq: 1,
      title: "Portable Power Bank 20000mAh Fast Charging",
      description: "A long enough description to clear the fifty-character minimum check easily.",
      category_code: "1017621",
      category_path: "Electronics > Accessories > External Battery Packs",
      category_alternates: [{ code: 1000176 }, { code: 1000279 }],
      brand: "Generic",
      images: ["https://cdn.test/a.jpg"],
      selling_price: 150,
      status: "failed",
      user_prompt: "20000mAh",
      jumia_error: CANT_LIST,
      // The first automatic fix already ran for this exact rejection.
      jumia_rerun_fingerprint: CANT_LIST_FINGERPRINT,
      jumia_rerun_count: 1,
      field_sources: {},
      ...overrides,
    }];
  }

  function listing() { return db.tables.listings[0]; }
  const listSent = () => sent.filter((m) => m.kind === "list");

  beforeEach(() => {
    autoAnalyzeCalls.length = 0;
    refillCalls.length = 0;
    db.tables.jumia_connections = [{ user_id: USER, country: "GH" }];
    // Both categories this product has been refused in, as the feed-outcome
    // log would have recorded them.
    db.tables.jumia_unlistable_categories = [
      { country: "GH", category_code: 1000176 },
      { country: "GH", category_code: 1017621 },
    ];
    seedSession({ state: "awaiting_confirmation", awaiting_category_for: null });
    seedTwiceRefused();
  });

  it("asks which category Vendor Center accepts instead of sending the seller to the editor", async () => {
    await handleLinkedMessage(USER, PHONE, "m1", { text: `fix:${LISTING_ID}` });

    const question = listSent().find((m) => m.body.includes("Which category does Vendor Center allow"));
    expect(question).toBeDefined();
    expect(question!.body).toContain("Jumia has refused 2 categories");
    expect(question!.rows).toContain(`recat:${LISTING_ID}:1000279`);
    // Never offers a category Jumia has already refused in Ghana.
    expect(question!.rows).not.toContain(`recat:${LISTING_ID}:1000176`);
    expect(question!.rows).not.toContain(`recat:${LISTING_ID}:1017621`);
    expect(sent.some((m) => m.body.includes("already tried fixing"))).toBe(false);
    expect(session().awaiting_category_for).toBe(LISTING_ID);
    expect(autoAnalyzeCalls).toHaveLength(0);
    expect(pushCallCount).toBe(0);
  });

  it("switches to a category picked from the list and resubmits straight away", async () => {
    await handleLinkedMessage(USER, PHONE, "m1", { text: `fix:${LISTING_ID}` });
    sent.length = 0;

    await handleLinkedMessage(USER, PHONE, "m2", { text: `recat:${LISTING_ID}:1000279` });

    expect(refillCalls).toEqual([{ listingId: LISTING_ID, code: 1000279 }]);
    expect(pushCallCount).toBe(1);
    expect(sent.some((m) => m.body.includes('Switching to "Portable Power Banks & Battery Packs"'))).toBe(true);
    expect(sent.some((m) => m.body.includes("resubmitted"))).toBe(true);
    expect(session().awaiting_category_for).toBeNull();
  });

  it("applies a typed category name that matches exactly one category", async () => {
    session().awaiting_category_for = LISTING_ID;

    await handleLinkedMessage(USER, PHONE, "m1", { text: "portable power banks and battery packs" });

    expect(refillCalls).toEqual([{ listingId: LISTING_ID, code: 1000279 }]);
    expect(pushCallCount).toBe(1);
  });

  it("shows the options back when several categories share the typed name", async () => {
    session().awaiting_category_for = LISTING_ID;

    await handleLinkedMessage(USER, PHONE, "m1", { text: "Chargers" });

    const choice = listSent().find((m) => m.body.includes("more than one"));
    expect(choice!.rows!.sort()).toEqual([`recat:${LISTING_ID}:3000001`, `recat:${LISTING_ID}:3000002`]);
    expect(refillCalls).toHaveLength(0);
    expect(session().awaiting_category_for).toBe(LISTING_ID);
  });

  it("won't use a typed category Jumia has already refused in the seller's country", async () => {
    session().awaiting_category_for = LISTING_ID;

    await handleLinkedMessage(USER, PHONE, "m1", { text: "Portable Power Banks" });

    expect(sent.some((m) => m.body.includes('already refused "Portable Power Banks"'))).toBe(true);
    expect(refillCalls).toHaveLength(0);
    expect(pushCallCount).toBe(0);
  });

  it("won't use a refused category tapped from an older list either", async () => {
    await handleLinkedMessage(USER, PHONE, "m1", { text: `recat:${LISTING_ID}:1000176` });

    expect(sent.some((m) => m.body.includes("already refused that category"))).toBe(true);
    expect(refillCalls).toHaveLength(0);
  });

  // Our editor has no Vendor Center-style category picker, so it's no help
  // here: the last resort is a category Jumia already uses for a similar
  // product, which the seller can copy off its page.
  it("tells a seller who doesn't know how to find the category on Jumia, and keeps the question open", async () => {
    session().awaiting_category_for = LISTING_ID;

    await handleLinkedMessage(USER, PHONE, "m1", { text: "I don't know" });

    expect(sent.some((m) => m.body.includes("Search jumia.com.gh for a product like this one"))).toBe(true);
    expect(sent.some((m) => m.kind === "cta")).toBe(false);
    expect(session().awaiting_category_for).toBe(LISTING_ID);
    expect(refillCalls).toHaveLength(0);
  });

  it("reads a breadcrumb pasted off a Jumia product page, product name and all", async () => {
    session().awaiting_category_for = LISTING_ID;

    await handleLinkedMessage(USER, PHONE, "m1", {
      text: "Home > Phones & Tablets > Mobile Accessories > Portable Power Banks & Battery Packs > Oraimo 20000mAh Power Bank",
    });

    expect(refillCalls).toEqual([{ listingId: LISTING_ID, code: 1000279 }]);
    expect(pushCallCount).toBe(1);
  });

  it("offers the categories under a parent the seller names", async () => {
    session().awaiting_category_for = LISTING_ID;

    await handleLinkedMessage(USER, PHONE, "m1", { text: "Mobile Accessories" });

    const choice = listSent().find((m) => m.body.includes('under "Mobile Accessories"'));
    expect(choice!.rows!.sort()).toEqual([`recat:${LISTING_ID}:1000279`, `recat:${LISTING_ID}:3000001`]);
    expect(refillCalls).toHaveLength(0);
  });

  it("explains that a product link doesn't carry its category", async () => {
    session().awaiting_category_for = LISTING_ID;

    await handleLinkedMessage(USER, PHONE, "m1", { text: "https://www.jumia.com.gh/oraimo-20000mah-power-bank-123456.html" });

    expect(sent.some((m) => m.body.includes("link to a product"))).toBe(true);
    expect(session().awaiting_category_for).toBe(LISTING_ID);
    expect(refillCalls).toHaveLength(0);
  });

  it("points at a similar product's category when nothing matches", async () => {
    session().awaiting_category_for = LISTING_ID;

    await handleLinkedMessage(USER, PHONE, "m1", { text: "zzqx" });

    expect(sent.some((m) => m.body.includes("couldn't find that category") && m.body.includes("Search jumia.com.gh"))).toBe(true);
    expect(session().awaiting_category_for).toBe(LISTING_ID);
  });

  it("drops the question on a reply that isn't an answer, and handles it normally", async () => {
    session().awaiting_category_for = LISTING_ID;

    await handleLinkedMessage(USER, PHONE, "m1", { text: "thanks" });

    expect(session().awaiting_category_for).toBeNull();
    expect(refillCalls).toHaveLength(0);
    expect(sent.some((m) => m.body.includes("couldn't find a Jumia category"))).toBe(false);
  });

  it("doesn't read a product note as an answer while the seller is sending a new product", async () => {
    seedSession({ state: "awaiting_photos", awaiting_category_for: LISTING_ID });

    await handleLinkedMessage(USER, PHONE, "m1", { text: "Chargers" });

    expect(refillCalls).toHaveLength(0);
    expect(sent.some((m) => m.body.includes("more than one"))).toBe(false);
  });

  // A redraft would keep the seller's category and resubmit it unchanged,
  // so there's nothing to try automatically: ask again at once.
  it("asks again straight away, with the find-it-on-Jumia tip, when Jumia refuses the seller's own pick", async () => {
    seedTwiceRefused({ field_sources: { category_code: "user" }, jumia_rerun_fingerprint: null, jumia_rerun_count: 0 });

    await handleLinkedMessage(USER, PHONE, "m1", { text: `fix:${LISTING_ID}` });

    const ask = listSent().find((m) => m.body.includes('Jumia refused "External Battery Packs", the category you picked'));
    expect(ask!.body).toContain("Search jumia.com.gh");
    expect(autoAnalyzeCalls).toHaveLength(0);
    expect(pushCallCount).toBe(0);
    expect(sent.some((m) => m.kind === "cta")).toBe(false);
    expect(session().awaiting_category_for).toBe(LISTING_ID);
  });

  it("asks the seller when the first redraft can't find another category at all", async () => {
    seedTwiceRefused({ jumia_rerun_fingerprint: null, jumia_rerun_count: 0 });
    autoAnalyzeResult = { ok: false, message: "no confident category" };

    await handleLinkedMessage(USER, PHONE, "m1", { text: `fix:${LISTING_ID}` });

    expect(listSent().some((m) => m.body.includes("couldn't find another one it accepts"))).toBe(true);
    expect(sent.some((m) => m.body.includes("couldn't redraft it"))).toBe(false);
    expect(pushCallCount).toBe(0);
    expect(session().awaiting_category_for).toBe(LISTING_ID);
  });

  // A stale code has to be re-picked even if the seller chose it, so the
  // redraft is allowed to replace it.
  it("lets the redraft re-pick a seller's category that Jumia no longer recognises", async () => {
    seedTwiceRefused({
      jumia_error: "Category not found by code 1017621",
      jumia_rerun_fingerprint: null,
      jumia_rerun_count: 0,
      field_sources: { category_code: "user", title: "user" },
    });

    await handleLinkedMessage(USER, PHONE, "m1", { text: `fix:${LISTING_ID}` });

    expect(autoAnalyzeCalls).toHaveLength(1);
    expect(listing().field_sources).toEqual({ title: "user" });
  });

  it("keeps the generic hand-off for a repeated rejection that isn't about the category", async () => {
    const TITLE_ERR = "The title contains the brand name, seller name or company name.";
    seedTwiceRefused({
      jumia_error: TITLE_ERR,
      jumia_rerun_fingerprint: rejectionFingerprint(classifyJumiaRejection(TITLE_ERR).kind, TITLE_ERR),
    });

    await handleLinkedMessage(USER, PHONE, "m1", { text: `fix:${LISTING_ID}` });

    expect(sent.some((m) => m.body.includes("already tried fixing"))).toBe(true);
    expect(listSent()).toHaveLength(0);
  });

  // Jumia's quality check rejected a "live" listing and named the category
  // it wants (lib/jumia/qc-followup.ts). Fix & resubmit switches to it.
  describe("a quality-check rejection that names a category", () => {
    const qcRejected = (jumia_error: string) =>
      seedTwiceRefused({ jumia_error, jumia_qc_status: "rejected", jumia_rerun_fingerprint: null, jumia_rerun_count: 0 });

    it("switches to the category Jumia suggested and resubmits", async () => {
      qcRejected('Wrong Category (quality check). Jumia suggests "Phones & Tablets > Mobile Accessories > Portable Power Banks & Battery Packs".');

      await handleLinkedMessage(USER, PHONE, "m1", { text: `fix:${LISTING_ID}` });

      expect(refillCalls).toEqual([{ listingId: LISTING_ID, code: 1000279 }]);
      expect(pushCallCount).toBe(1);
      expect(autoAnalyzeCalls).toHaveLength(0);
      expect(sent.some((m) => m.body.includes('Switching to "Portable Power Banks & Battery Packs"'))).toBe(true);
    });

    it("reads Jumia's own wording too", async () => {
      qcRejected("Wrong Category: Category mismatch: AI suggests Electronics / Accessories / Chargers (shares 3 path segments but leaf differs)");

      await handleLinkedMessage(USER, PHONE, "m1", { text: `fix:${LISTING_ID}` });

      expect(refillCalls).toEqual([{ listingId: LISTING_ID, code: 3000002 }]);
    });

    it("lets the seller pick when Jumia names a parent with several categories under it", async () => {
      qcRejected('Wrong Category (quality check). Jumia suggests "Phones & Tablets > Mobile Accessories".');

      await handleLinkedMessage(USER, PHONE, "m1", { text: `fix:${LISTING_ID}` });

      const pick = listSent().find((m) => m.body.includes("quality check says it belongs in"));
      expect(pick!.rows!.sort()).toEqual([`recat:${LISTING_ID}:1000279`, `recat:${LISTING_ID}:3000001`]);
      expect(session().awaiting_category_for).toBe(LISTING_ID);
      expect(refillCalls).toHaveLength(0);
      expect(pushCallCount).toBe(0);
    });
  });
});

describe("connecting Jumia from the chat", () => {
  const CLIENT_ID = "7eeed0a3-ed50-4abc-a74a-16cd5aef0dcb";
  const TOKEN = "Zq7Rk2Vn8Tw3Xb5Yc9Pd1Lf4Hg6Jm0Ns-Qa_Uv2Ew8Ko";

  beforeEach(() => {
    seedSession({ state: "awaiting_jumia_credentials", batch_id: null, batch_size: null, batch_seq: null, pending_app_id: null });
    selfAuthResult = { ok: true, storeName: "Kelvin's Store" };
    selfAuthCalls.length = 0;
    webCredentialsValid = true;
    webCredentialChecks.length = 0;
  });

  it("connects a Self Authorization app straight away and moves on to listing", async () => {
    await handleLinkedMessage(USER, PHONE, "m1", { text: `${CLIENT_ID}\n${TOKEN}` });

    // Ghana, from the +233 number.
    expect(selfAuthCalls).toEqual([{ clientId: CLIENT_ID, token: TOKEN, country: "GH" }]);
    expect(webCredentialChecks).toHaveLength(0);
    expect(session().state).toBe("awaiting_count");
    // One message, the count buttons on it, as after a restart.
    expect(sent.at(-1)).toEqual(expect.objectContaining({ kind: "buttons", rows: ["1", "2", "3"] }));
    expect(sent.at(-1)?.body).toContain("Jumia connected — Kelvin's Store");
  });

  it("takes the Client ID and the token one message at a time, in either order", async () => {
    await handleLinkedMessage(USER, PHONE, "m1", { text: TOKEN });
    expect(sent.at(-1)?.body).toContain("now paste the Client ID");
    await handleLinkedMessage(USER, PHONE, "m2", { text: CLIENT_ID });

    expect(selfAuthCalls).toEqual([{ clientId: CLIENT_ID, token: TOKEN, country: "GH" }]);
    expect(session().state).toBe("awaiting_count");
  });

  it("falls back to the Web Application login when Jumia says that's what the app is", async () => {
    selfAuthResult = { ok: false, reason: "web_app", error: "Web Application" };
    await handleLinkedMessage(USER, PHONE, "m1", { text: `${CLIENT_ID} ${TOKEN}` });

    expect(webCredentialChecks).toEqual([CLIENT_ID]);
    expect(session().state).toBe("awaiting_jumia_oauth");
  });

  it("asks for a fresh token when Jumia refuses this one, without trying the Web Application route", async () => {
    selfAuthResult = { ok: false, reason: "bad_token", error: "That token has expired or was already used." };
    await handleLinkedMessage(USER, PHONE, "m1", { text: `${CLIENT_ID} ${TOKEN}` });

    expect(webCredentialChecks).toHaveLength(0);
    expect(session().state).toBe("awaiting_jumia_credentials");
    expect(sent.at(-1)?.body).toContain("expired or was already used");
  });
});

// Jumia's quality check rejected a listing after the upload went through
// (lib/jumia/qc-followup.ts). Fix & resubmit does what lib/jumia/
// qc-remedy.ts decides, and asks the seller for what only they know.
describe("fixing a quality-check rejection", () => {
  const QC_ID = "33333333-3333-3333-3333-333333333333";
  let msg = 0;
  const say = (text: string) => handleLinkedMessage(USER, PHONE, `qc-${++msg}`, { text });
  const photo = (id: string) => handleLinkedMessage(USER, PHONE, `qc-${++msg}`, { imageMediaId: id });
  const qcRow = () => db.tables.listings[0];
  const question = () => session().awaiting_qc_answer as Record<string, unknown> | null | undefined;
  const lastBody = () => sent.at(-1)?.body ?? "";

  function seedQcRejected(reason: string | null, comment: string | null) {
    db.tables.listings = [{
      id: QC_ID,
      user_id: USER,
      whatsapp_seq: 3,
      title: "Collagen With Burn Dietary Supplement",
      description: "<p>A long enough description to clear the fifty-character minimum check easily.</p>",
      category_code: "5000001",
      category_path: "Health & Beauty > Vitamins & Dietary Supplements",
      brand: "Generic",
      images: ["https://cdn.test/old.jpg"],
      selling_price: 126,
      sale_price: null,
      status: "failed",
      jumia_qc_status: "rejected",
      jumia_qc_reason: reason,
      jumia_qc_comment: comment,
      jumia_error: "rejected in quality check",
      field_sources: {},
      dynamic_attributes: {},
    }];
  }

  beforeEach(() => {
    pushCallCount = 0;
    pushResult = { ok: true };
    autoAnalyzeCalls.length = 0;
    autoAnalyzeResult = { ok: true };
    db.tables.jumia_connections = [{ user_id: USER, country: "GH" }];
    db.tables.jumia_unlistable_categories = [];
    db.tables.jumia_category_attributes = [
      { category_code: 5000001, name: "fda", label: "FDA" },
      { category_code: 5000001, name: "fda", label: "FDA" },
      { category_code: 5000001, name: "product_weight", label: "Weight (kg)" },
    ];
    seedSession({ state: "awaiting_confirmation", awaiting_category_for: null, awaiting_qc_answer: null });
  });

  it("asks for the FDA number and puts the answer in the category's FDA field", async () => {
    seedQcRejected(null, "Kindly Provide Product's Health/Food Regulation Registration Number. (Mandatory FDA registration number is missing.)");

    await say(`fix:${QC_ID}`);

    expect(lastBody()).toContain("What is the product's FDA registration number?");
    expect(question()).toEqual({ listingId: QC_ID, kind: "value", field: "fda", fieldLabel: "FDA" });
    expect(pushCallCount).toBe(0);
    expect(autoAnalyzeCalls).toHaveLength(0);

    await say("FDA/DS.24-5678");

    expect(qcRow().dynamic_attributes).toEqual({ fda: "FDA/DS.24-5678" });
    expect((qcRow().field_sources as Record<string, string>)["dynamic_attributes.fda"]).toBe("user");
    expect(pushCallCount).toBe(1);
    expect(question()).toBeNull();
    expect(sent.some((m) => m.body.includes('added FDA "FDA/DS.24-5678"'))).toBe(true);
  });

  it("asks for Vendor Center's reason when Jumia gave none, then acts on what the seller pastes", async () => {
    seedQcRejected("Other Reason", "Rejected");

    await say(`fix:${QC_ID}`);
    expect(lastBody()).toContain("paste them here");
    expect(question()).toEqual({ listingId: QC_ID, kind: "details" });

    await say("Wrong Brand: The product image shows NIVEA, please create it with the correct brand");
    expect(qcRow().jumia_qc_comment).toContain("shows NIVEA");
    expect(question()).toEqual({ listingId: QC_ID, kind: "brand" });
    expect(lastBody()).toContain("What brand is on the product?");

    await say("Nivea");
    expect(qcRow()).toMatchObject({ brand: "Nivea", field_sources: { brand: "user" } });
    expect(pushCallCount).toBe(1);
  });

  it("collects new photos and resubmits with them on done", async () => {
    seedQcRejected("Poor Image Quality", "Images are blurry");

    await say(`fix:${QC_ID}`);
    expect(lastBody()).toContain("Send new photos of the product");

    await photo("new-1");
    await photo("new-2");
    // One acknowledgement for the burst, not one per photo.
    expect(sent.filter((m) => m.body.includes("Send any more photos"))).toHaveLength(1);
    expect(qcRow().images).toEqual(["https://cdn.test/old.jpg"]);

    await say("done");
    expect(qcRow().images).toEqual(["https://cdn.test/new-1.jpg", "https://cdn.test/new-2.jpg"]);
    expect(qcRow().qc_new_images).toBeNull();
    expect(pushCallCount).toBe(1);
    expect(question()).toBeNull();
  });

  it("asks for a price and sets it", async () => {
    seedQcRejected("Product Pricing", "Price is not realistic");

    await say(`fix:${QC_ID}`);
    await say("GHS 150");

    expect(qcRow().selling_price).toBe(150);
    expect(pushCallCount).toBe(1);
  });

  it("explains what can't be fixed, and resubmits nothing", async () => {
    seedQcRejected("Brand Banned", null);

    await say(`fix:${QC_ID}`);

    expect(lastBody()).toContain("Jumia doesn't let your shop sell this brand");
    expect(pushCallCount).toBe(0);
    expect(autoAnalyzeCalls).toHaveLength(0);
    expect(question()).toBeFalsy();
  });

  it("redrafts what a redraft can fix", async () => {
    seedQcRejected("Wrong Title", null);

    await say(`fix:${QC_ID}`);

    expect(autoAnalyzeCalls).toHaveLength(1);
    expect(pushCallCount).toBe(1);
  });

  it("leaves a batch edit to the batch rather than reading it as the answer", async () => {
    seedQcRejected("Product Pricing", null);
    await say(`fix:${QC_ID}`);

    await say("2 change price to 150");

    expect(qcRow().selling_price).toBe(126);
    expect(question()).toBeNull();
    expect(pushCallCount).toBe(0);
  });

  it("needs the Standard pack or bigger for the guided fix", async () => {
    seedQcRejected(null, "Kindly provide the product's FDA registration number");
    qcFeature = false;
    try {
      await say(`fix:${QC_ID}`);
    } finally {
      qcFeature = true;
    }

    expect(lastBody()).toContain("Guided QC fixes come with the Standard pack and up");
    expect(question()).toBeFalsy();
    expect(pushCallCount).toBe(0);
    expect(autoAnalyzeCalls).toHaveLength(0);
  });

  it("drops the question when the seller moves on", async () => {
    seedQcRejected(null, "Kindly provide the product's FDA registration number");
    await say(`fix:${QC_ID}`);

    await say("thanks");

    expect(question()).toBeNull();
    expect(qcRow().dynamic_attributes).toEqual({});
    expect(pushCallCount).toBe(0);
  });
});

// The drafting-time "🤔 not sure of product N's category" message. Its
// buttons only offer the AI's alternates; a seller whose category isn't
// among them types it (2026-10-01: "Product one category is “Educational
// Tablets”" got the generic help back), often before the rest of the batch
// has finished drafting.
describe("typing the category for a draft the bot wasn't sure of", () => {
  const TABLET = "33333333-3333-3333-3333-333333333331";
  const LOTION = "33333333-3333-3333-3333-333333333332";
  const DRINK  = "33333333-3333-3333-3333-333333333333";

  function seedBatch(state: "analyzing" | "awaiting_confirmation") {
    seedSession({ state, batch_id: "batch-9", batch_size: 3, batch_seq: 3 });
    db.tables.listings = [
      { id: TABLET, user_id: USER, whatsapp_batch_id: "batch-9", whatsapp_seq: 1, status: "draft", category_unsure: true,
        title: "Kids Tablet PC - 4GB RAM, 64GB Storage", category_code: "1002640", selling_price: 120, field_sources: {} },
      { id: LOTION, user_id: USER, whatsapp_batch_id: "batch-9", whatsapp_seq: 2, status: "draft", category_unsure: false,
        title: "Body Lotion Nourishing Cocoa", category_code: "1006357", selling_price: 130, field_sources: {} },
      { id: DRINK, user_id: USER, whatsapp_batch_id: "batch-9", whatsapp_seq: 3, status: "draft", category_unsure: false,
        title: "Soft Drink - 330ml, Pack of 6", category_code: "1002615", selling_price: 120, field_sources: {} },
    ];
  }

  beforeEach(() => {
    refillCalls.length = 0;
    db.tables.jumia_connections = [{ user_id: USER, country: "GH" }];
    db.tables.jumia_unlistable_categories = [];
  });

  it("switches the draft when the seller names its category, without submitting it", async () => {
    seedBatch("awaiting_confirmation");
    await handleLinkedMessage(USER, PHONE, "m1", { text: "Product one category is “Educational Tablets”" });

    expect(refillCalls).toEqual([{ listingId: TABLET, code: 1029505 }]);
    expect(pushCallCount).toBe(0);
    expect(db.tables.listings[0].category_unsure).toBe(false);
    expect(sent.some((m) => m.body.startsWith("✅ Product 1 switched"))).toBe(true);
    expect(sent.some((m) => m.body.startsWith("Reply *submit all*"))).toBe(false);
  });

  it("takes a bare category name while the rest of the batch is still drafting", async () => {
    seedBatch("analyzing");
    await handleLinkedMessage(USER, PHONE, "m1", { text: "Educational Tablets" });

    expect(refillCalls).toEqual([{ listingId: TABLET, code: 1029505 }]);
    expect(sent.some((m) => m.body.includes("Still drafting"))).toBe(false);
  });

  it("applies a tapped alternate while the rest of the batch is still drafting", async () => {
    seedBatch("analyzing");
    await handleLinkedMessage(USER, PHONE, "m1", { text: `category:${TABLET}:1002623` });

    expect(refillCalls).toEqual([{ listingId: TABLET, code: 1002623 }]);
    expect(sent.some((m) => m.body.includes("Still drafting"))).toBe(false);
  });

  it("uses the product number the seller gives", async () => {
    seedBatch("awaiting_confirmation");
    await handleLinkedMessage(USER, PHONE, "m1", { text: "2 category: Educational Tablets" });
    expect(refillCalls).toEqual([{ listingId: LOTION, code: 1029505 }]);
  });

  it("waits for a product that's still being drafted", async () => {
    seedBatch("analyzing");
    db.tables.analysis_jobs = [{ id: "job-3", listing_id: DRINK, status: "running" }];
    await handleLinkedMessage(USER, PHONE, "m1", { text: "3 category: Educational Tablets" });

    expect(refillCalls).toHaveLength(0);
    expect(sent.some((m) => m.body.includes("Product 3 is still being drafted"))).toBe(true);
  });

  it("says so when the named category isn't on Jumia", async () => {
    seedBatch("awaiting_confirmation");
    await handleLinkedMessage(USER, PHONE, "m1", { text: "1 category: Flying Carpets" });

    expect(refillCalls).toHaveLength(0);
    expect(sent.some((m) => m.body.includes("I couldn't find \"Flying Carpets\""))).toBe(true);
  });

  it("leaves edits and bare names alone when no draft's category is in question", async () => {
    seedBatch("awaiting_confirmation");
    await handleLinkedMessage(USER, PHONE, "m1", { text: "make the title shorter" });
    expect(refillCalls).toHaveLength(0);

    db.tables.listings[0].category_unsure = false;
    await handleLinkedMessage(USER, PHONE, "m2", { text: "Educational Tablets" });
    expect(refillCalls).toHaveLength(0);
  });
});

// Jumia refusing fields its category doesn't show, as stored before
// 2026-10-01: cut at 500 characters, mid-word. Fix & resubmit used to read
// it as a mixed rejection and redraft (which re-sends the same fields),
// then send the seller to the editor on the second tap.
describe("Fix & resubmit for fields Jumia doesn't show in the category", () => {
  const TABLET_ID = "44444444-4444-4444-4444-444444444444";
  const EDU = 1029505;
  const STORED = ["color_family", "main_material", "manufacturer_txt", "battery_feature", "material_family", "note"]
    .map((n) => `Attribute [${n}] is not visible for category [Educational Tablets].`).join(" ")
    + " Attribute [warranty_duration] is not visi";

  beforeEach(() => {
    autoAnalyzeCalls.length = 0;
    pushResult = { ok: true };
    pushCallCount = 0;
    seedSession({ state: "awaiting_count" });
    db.tables.jumia_excluded_attributes = [];
    db.tables.jumia_category_attributes = ["color_family", "main_material", "manufacturer_txt", "battery_feature", "material_family", "note", "warranty_duration", "ram"]
      .map((name) => ({ category_code: EDU, name }));
    db.tables.listings = [{
      id: TABLET_ID, user_id: USER, whatsapp_seq: 1, status: "failed",
      title: "Kids Tablet PC - 4GB RAM, 64GB Storage", description: "A long enough description to clear the fifty-character minimum check easily.",
      category_code: String(EDU), category_path: "Phones & Tablets > Tablets > Educational Tablets",
      brand: "Generic", images: ["https://cdn.test/a.jpg"], selling_price: 128, field_sources: {},
      jumia_error: STORED, jumia_rerun_fingerprint: null, jumia_rerun_count: 0,
    }];
  });

  it("drops the named fields and resubmits, without a redraft", async () => {
    await handleLinkedMessage(USER, PHONE, "m1", { text: `fix:${TABLET_ID}` });

    expect(autoAnalyzeCalls).toHaveLength(0);
    expect(pushCallCount).toBe(1);
    expect(db.tables.jumia_category_attributes.map((r) => r.name)).toEqual(["ram"]);
    expect(sent.some((m) => m.body.includes("resubmitted"))).toBe(true);
  });

  it("says the listing is already submitted instead of \"Jumia still isn't happy\"", async () => {
    pushResult = { ok: false, code: "already_submitted", message: "This listing is already with Jumia and waiting on their review." };
    await handleLinkedMessage(USER, PHONE, "m1", { text: `fix:${TABLET_ID}` });

    expect(sent.some((m) => m.body.includes("already submitted, so I didn't send it again"))).toBe(true);
    expect(sent.some((m) => m.body.includes("still isn't happy"))).toBe(false);
  });
});
