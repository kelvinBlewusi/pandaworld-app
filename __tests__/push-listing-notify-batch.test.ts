/**
 * Regression coverage for batching the async Jumia feed-resolution
 * notification: before this, refreshPendingFeedStatus sent one WhatsApp
 * message the instant EACH listing resolved, so a 20-product "submit all"
 * whose products resolve at Jumia's own pace could trickle in up to one
 * "🎉 X is live!" / "⚠️ X was rejected" message per product across many of
 * the per-minute cron ticks — found while investigating the same
 * ~108-message/20-product evidence behind the draft-phase collapse (see
 * lib/whatsapp/intake.ts's finalizeBatch).
 *
 * app/api/cron/jumia-feeds/route.ts (the actual storm source — it already
 * loops every pending listing per user, once a minute) now passes
 * skipNotify to refreshPendingFeedStatus and hands every genuine
 * transition to notifyResolvedListings, which groups by
 * whatsapp_batch_id and sends at most one message per batch per run.
 */

import { FakeDb } from "./helpers/fake-supabase";

const db = new FakeDb();
const sent: { to: string; body: string; kind: string; buttons?: string[]; titles?: string[]; descriptions?: string[] }[] = [];

jest.mock("@/lib/supabase/server", () => ({
  createServerClient: () => db,
}));

jest.mock("@/lib/whatsapp/client", () => ({
  sendTextIfConfigured: async (to: string, body: string) => { sent.push({ to, body, kind: "text" }); },
  sendButtonsIfConfigured: async (to: string, body: string, buttons: { id: string; title: string }[]) => {
    sent.push({ to, body, kind: "buttons", buttons: buttons.map((b) => b.id), titles: buttons.map((b) => b.title) });
  },
  sendCtaUrlIfConfigured: async (to: string, body: string) => { sent.push({ to, body, kind: "cta" }); },
  sendImageIfConfigured: async (to: string, body: string) => { sent.push({ to, body, kind: "image" }); },
  sendListIfConfigured: async (to: string, body: string, buttonText: string, rows: { id: string; title: string; description?: string }[]) => {
    sent.push({ to, body, kind: "list", buttons: rows.map((r) => r.id), titles: rows.map((r) => r.title), descriptions: rows.map((r) => r.description ?? "") });
  },
  LIST_MAX_ROWS: 10,
}));

type ConnResult = { connected: boolean; phoneNumber: string | null };
let connResult: ConnResult = { connected: true, phoneNumber: "233550607231" };
jest.mock("@/lib/whatsapp/link", () => ({
  getWhatsAppConnection: async () => connResult,
}));

let feedStatusResult: { status: string; total: number; success: number; failed: number; errors: unknown[]; raw: unknown } | null = null;
let feedProductDetailsResult: { sellerSku: string; productSid: string | null; qcStatus: string | null; errors: string[] }[] | null = null;
jest.mock("@/lib/jumia/api", () => ({
  getFeedStatus:         async () => feedStatusResult,
  getFeedProductDetails: async () => feedProductDetailsResult,
}));

import { refreshPendingFeedStatus, notifyBatchResolved, notifyResolvedListings, toResolvedNotice, QC_APPROVED, type ResolvedListingNotice, type FeedResolution } from "@/lib/jumia/push-listing";

const PHONE = "233550607231";

function seedListing(patch: Record<string, unknown> = {}) {
  db.tables.listings = [{
    id: "listing-1", status: "pending_approval", jumia_ref: "feed-1",
    ...patch,
  }];
}

beforeEach(() => {
  db.tables.listings = [];
  sent.length = 0;
  connResult = { connected: true, phoneNumber: PHONE };
  feedStatusResult = null;
  feedProductDetailsResult = null;
});

describe("refreshPendingFeedStatus — skipNotify", () => {
  it("still persists the transition but sends no WhatsApp message when skipNotify is set", async () => {
    seedListing();
    feedStatusResult = { status: "DONE", total: 1, success: 1, failed: 0, errors: [], raw: null };
    feedProductDetailsResult = [{ sellerSku: "SKU-1", productSid: "sid-1", qcStatus: "approved", errors: [] }];

    const result = await refreshPendingFeedStatus("tok", { id: "listing-1", status: "pending_approval", jumia_ref: "feed-1" }, { skipNotify: true });

    expect(result.status).toBe("live");
    expect(db.tables.listings[0].status).toBe("live");
    expect(sent).toHaveLength(0);
  });

  it("still notifies as before when skipNotify is omitted — every other caller is unaffected", async () => {
    seedListing({ whatsapp_batch_id: "batch-1", title: "Kettle", user_id: "user_1" });
    feedStatusResult = { status: "DONE", total: 1, success: 1, failed: 0, errors: [], raw: null };
    feedProductDetailsResult = [{ sellerSku: "SKU-1", productSid: "sid-1", qcStatus: "approved", errors: [] }];

    await refreshPendingFeedStatus("tok", { id: "listing-1", status: "pending_approval", jumia_ref: "feed-1" });

    expect(sent).toHaveLength(1);
    expect(sent[0].body).toBe('✅ "Kettle": Jumia accepted it — Will alert you if it passes Jumia QC');
  });

  // Live, 2026-10-02: Jumia's feed error held every product error word
  // for word, and the seller read each complaint twice.
  it("keeps a rejection once when Jumia repeats it per product", async () => {
    seedListing();
    const one = (a: string) => `Attribute [${a}] is not visible for category [Refrigerators].`;
    feedStatusResult = { status: "DONE", total: 1, success: 0, failed: 1, errors: [], raw: null };
    feedProductDetailsResult = [{
      sellerSku: "SKU-1", productSid: null, qcStatus: null,
      errors: [`${one("warranty_type")} ${one("product_line")}`, one("warranty_type"), one("product_line")],
    }];

    const result = await refreshPendingFeedStatus("tok", { id: "listing-1", status: "pending_approval", jumia_ref: "feed-1" }, { skipNotify: true });

    expect(result.error).toBe(`${one("warranty_type")} ${one("product_line")}`);
  });

  // An approval in the feed is left for lib/jumia/qc-followup.ts to
  // confirm, so the seller gets its "🎉 passed Jumia QC" message.
  it("leaves a QC approval reported by the feed for the QC follow-up to confirm", async () => {
    seedListing();
    feedStatusResult = { status: "DONE", total: 1, success: 1, failed: 0, errors: [], raw: null };
    feedProductDetailsResult = [{ sellerSku: "SKU-1", productSid: "sid-1", qcStatus: "approved", errors: [] }];

    await refreshPendingFeedStatus("tok", { id: "listing-1", status: "pending_approval", jumia_ref: "feed-1" }, { skipNotify: true });

    expect(db.tables.listings[0].jumia_qc_status).toBeUndefined();
    expect(db.tables.listings[0].jumia_product_sid).toBe("sid-1");
  });
});

describe("notifyBatchResolved", () => {
  function notice(patch: Partial<ResolvedListingNotice> = {}): ResolvedListingNotice {
    return {
      listingId: "listing-1", title: "Electric Kettle", whatsappSeq: null, batchId: "batch-1",
      newStatus: "live", errorMsg: null,
      counts: { liveCount: 1, totalCount: 1, rejectedSkus: [] },
      ...patch,
    };
  }

  it("renders a single resolution exactly like the old one-at-a-time message, with its Fix & resubmit button", async () => {
    await notifyBatchResolved(PHONE, "batch-1", [
      notice({ newStatus: "failed", errorMsg: "Attribute [capacity_liter] with the value [1.7] should be a number without decimals." }),
    ]);

    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe("buttons");
    expect(sent[0].body).toContain("was rejected by Jumia: Attribute [capacity_liter]");
    expect(sent[0].buttons).toEqual(["fix:listing-1"]);
  });

  it("combines several resolutions from the same batch into ONE message, not one per listing", async () => {
    await notifyBatchResolved(PHONE, "batch-1", [
      notice({ listingId: "listing-1", title: "Electric Kettle", whatsappSeq: 1, newStatus: "live" }),
      notice({ listingId: "listing-2", title: "Baby Carrier", whatsappSeq: 2, newStatus: "failed", errorMsg: "Attribute [variation] with invalid value [Navy Blue]" }),
      notice({ listingId: "listing-3", title: "Blender", whatsappSeq: 3, newStatus: "live" }),
    ]);

    const texts = sent.filter((m) => m.kind === "text");
    expect(texts).toHaveLength(1);
    expect(texts[0].body).toContain("Since your last update: 2 accepted, 1 rejected.");
    expect(texts[0].body).toContain('"Electric Kettle": Jumia accepted it — Will alert you if it passes Jumia QC');
    expect(texts[0].body).toContain('"Baby Carrier" was rejected by Jumia: Attribute [variation]');
    expect(texts[0].body).toContain('"Blender": Jumia accepted it');

    // 3 or fewer items: a Fix button per REJECTED item (only the one that
    // needs it), no button for the live ones — nothing to fix there.
    const buttonMsgs = sent.filter((m) => m.kind === "buttons");
    expect(buttonMsgs).toHaveLength(1);
    expect(buttonMsgs[0].buttons).toEqual(["fix:listing-2"]);
    expect(sent.some((m) => m.kind === "cta")).toBe(false);
    expect(sent.some((m) => m.kind === "list")).toBe(false);
  });

  it("sends nothing further when everything in the batch went live — nothing to fix", async () => {
    await notifyBatchResolved(PHONE, "batch-1", [
      notice({ listingId: "listing-1", newStatus: "live" }),
      notice({ listingId: "listing-2", newStatus: "live" }),
    ]);

    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe("text");
    expect(sent[0].body).toContain("Since your last update: Jumia accepted 2 products — Will alert you as they pass Jumia QC");
  });

  // Without QC alerts (below the Standard pack) nothing will report the
  // quality-check verdict, so acceptance doesn't promise one.
  it("doesn't promise a QC alert to a seller whose pack doesn't include them", async () => {
    await notifyBatchResolved(PHONE, "batch-1", [notice()], { qcAlerts: false });
    expect(sent[0].body).toBe(`✅ "Electric Kettle": Jumia accepted it. Jumia's quality check comes next; Vendor Center shows the result`);

    sent.length = 0;
    await notifyBatchResolved(PHONE, "batch-1", [notice({ listingId: "a" }), notice({ listingId: "b" })], { qcAlerts: false });
    expect(sent[0].body).toContain("Since your last update: Jumia accepted 2 products.");
    expect(sent[0].body).not.toContain("Will alert you");
  });

  it("announces a product live once it passes Jumia QC, with nothing to fix", async () => {
    await notifyBatchResolved(PHONE, "batch-1", [notice({ newStatus: QC_APPROVED })]);

    expect(sent).toEqual([expect.objectContaining({ kind: "text", body: '🎉 "Electric Kettle" passed Jumia QC and is now live on Jumia!' })]);
  });

  it("counts QC passes, acceptances and rejections apart in one summary", async () => {
    await notifyBatchResolved(PHONE, "batch-1", [
      notice({ listingId: "listing-1", title: "Kettle", whatsappSeq: 1, newStatus: QC_APPROVED }),
      notice({ listingId: "listing-2", title: "Blender", whatsappSeq: 2, newStatus: QC_APPROVED }),
      notice({ listingId: "listing-3", title: "Toaster", whatsappSeq: 3, newStatus: "failed", errorMsg: "Wrong Category (quality check)." }),
    ]);

    expect(sent[0].body).toContain("Since your last update: 2 passed QC, 1 rejected.");
    expect(sent.filter((m) => m.kind === "buttons")[0].buttons).toEqual(["fix:listing-3"]);

    sent.length = 0;
    await notifyBatchResolved(PHONE, "batch-1", [
      notice({ listingId: "listing-1", newStatus: QC_APPROVED }),
      notice({ listingId: "listing-2", newStatus: QC_APPROVED }),
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain("🎉 Since your last update: 2 products passed Jumia QC and are now live on Jumia!");
  });

  it("uses a tappable LIST, not chunked buttons, when 4+ items are REJECTED in one tick — live ones never get a row", async () => {
    await notifyBatchResolved(PHONE, "batch-1", [
      notice({ listingId: "listing-1", title: "Kettle", whatsappSeq: 1, newStatus: "live" }),
      notice({ listingId: "listing-2", title: "Baby Carrier", whatsappSeq: 2, newStatus: "failed", errorMsg: "Attribute [variation] with invalid value [Navy Blue]" }),
      notice({ listingId: "listing-3", title: "Blender", whatsappSeq: 3, newStatus: "live" }),
      notice({ listingId: "listing-4", title: "Toaster", whatsappSeq: 4, newStatus: "failed", errorMsg: "You can't list products in this category." }),
      notice({ listingId: "listing-5", title: "Helmet", whatsappSeq: 5, newStatus: "failed", errorMsg: "price is required" }),
      notice({ listingId: "listing-6", title: "Backpack", whatsappSeq: 6, newStatus: "failed", errorMsg: "Attribute [color_family] with invalid value [Black,Grey]." }),
    ]);

    expect(sent.some((m) => m.kind === "buttons")).toBe(false);
    expect(sent.some((m) => m.kind === "cta")).toBe(false);

    // Only the four rejected products get a row — the two live ones stay
    // in the summary text and never appear as a tappable "pick a product"
    // option, since there's nothing to fix on them.
    const lists = sent.filter((m) => m.kind === "list");
    expect(lists).toHaveLength(1);
    expect(lists[0].buttons).toEqual(["fix:listing-2", "fix:listing-4", "fix:listing-5", "fix:listing-6"]);
    // Each row names its product; why it was rejected is in the numbered
    // summary above.
    expect(lists[0].descriptions).toEqual(["Baby Carrier", "Toaster", "Helmet", "Backpack"]);
    expect(sent[0].body).toContain('Product 2: ⚠️ "Baby Carrier" was rejected by Jumia: Attribute [variation]');
  });

  // Live, 2026-10-02: "Fix product 3" on a button, with nothing saying
  // which product 3 was.
  it("names each product its Fix button is for, and numbers the summary to match", async () => {
    await notifyBatchResolved(PHONE, "batch-1", [
      notice({ listingId: "listing-1", title: "Floral Petal Statement Earrings", whatsappSeq: 1, newStatus: QC_APPROVED }),
      notice({ listingId: "listing-3", title: "Plain T-Shirt - Crew Neck", whatsappSeq: 3, newStatus: "failed", errorMsg: "Wrong Category (quality check)." }),
      notice({ listingId: "listing-7", title: "Leather Safety Shoes", whatsappSeq: 7, newStatus: "failed", errorMsg: "Poor image quality (quality check)." }),
    ]);

    expect(sent[0].body).toContain('Product 3: ⚠️ "Plain T-Shirt - Crew Neck" was rejected by Jumia');
    expect(sent[0].body).toContain('Product 1: 🎉 "Floral Petal Statement Earrings" passed Jumia QC');
    const fix = sent.find((m) => m.kind === "buttons")!;
    expect(fix.body).toBe("Fix what didn't go through:\nProduct 3 — Plain T-Shirt - Crew Neck\nProduct 7 — Leather Safety Shoes");
    expect(fix.buttons).toEqual(["fix:listing-3", "fix:listing-7"]);
  });

  it("splits a summary too long for one message instead of losing it", async () => {
    const long = "x".repeat(400);
    await notifyBatchResolved(PHONE, "batch-1", Array.from({ length: 20 }, (_, i) =>
      notice({ listingId: `listing-${i + 1}`, title: `Product name ${i + 1}`, whatsappSeq: i + 1, newStatus: "failed", errorMsg: long })));

    const texts = sent.filter((m) => m.kind === "text");
    expect(texts.length).toBeGreaterThan(1);
    expect(texts.every((t) => t.body.length <= 4096)).toBe(true);
    expect(texts.map((t) => t.body).join("\n")).toContain("Product 20:");
  });

  it("still uses reply-buttons (not a list) when 4+ items resolve but 3 or fewer are rejected", async () => {
    await notifyBatchResolved(PHONE, "batch-1", [
      notice({ listingId: "listing-1", title: "Kettle", whatsappSeq: 1, newStatus: "live" }),
      notice({ listingId: "listing-2", title: "Baby Carrier", whatsappSeq: 2, newStatus: "failed", errorMsg: "Attribute [variation] with invalid value [Navy Blue]" }),
      notice({ listingId: "listing-3", title: "Blender", whatsappSeq: 3, newStatus: "live" }),
      notice({ listingId: "listing-4", title: "Toaster", whatsappSeq: 4, newStatus: "live" }),
    ]);

    expect(sent.some((m) => m.kind === "list")).toBe(false);
    const buttonMsgs = sent.filter((m) => m.kind === "buttons");
    expect(buttonMsgs).toHaveLength(1);
    expect(buttonMsgs[0].buttons).toEqual(["fix:listing-2"]);
  });

  it("chunks the list into groups of LIST_MAX_ROWS when more than 10 REJECTED items resolve — live items never occupy a row slot", async () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      notice({ listingId: `listing-${i + 1}`, title: `Product ${i + 1}`, whatsappSeq: i + 1, newStatus: i % 2 === 0 ? "live" : "failed", errorMsg: i % 2 === 0 ? null : "some rejection" }),
    );
    await notifyBatchResolved(PHONE, "batch-1", items);

    // 10 of the 20 are rejected — exactly one LIST_MAX_ROWS-sized list,
    // not two, and not a mix of live rows padding it out.
    const lists = sent.filter((m) => m.kind === "list");
    expect(lists).toHaveLength(1);
    expect(lists[0].buttons).toHaveLength(10);
    expect(lists[0].buttons?.every((id) => ["listing-2", "listing-4", "listing-6", "listing-8", "listing-10", "listing-12", "listing-14", "listing-16", "listing-18", "listing-20"].some((n) => id === `fix:${n}`))).toBe(true);
  });

  it("chunks past LIST_MAX_ROWS when more than 10 items are rejected", async () => {
    const items = Array.from({ length: 15 }, (_, i) =>
      notice({ listingId: `listing-${i + 1}`, title: `Product ${i + 1}`, whatsappSeq: i + 1, newStatus: "failed", errorMsg: "some rejection" }),
    );
    await notifyBatchResolved(PHONE, "batch-1", items);

    const lists = sent.filter((m) => m.kind === "list");
    expect(lists).toHaveLength(2);
    expect(lists[0].buttons).toHaveLength(10);
    expect(lists[1].buttons).toHaveLength(5);
  });

  it("does nothing for an empty batch", async () => {
    await notifyBatchResolved(PHONE, "batch-1", []);
    expect(sent).toHaveLength(0);
  });
});

describe("notifyResolvedListings", () => {
  function notice(patch: Partial<ResolvedListingNotice> = {}): ResolvedListingNotice {
    return {
      listingId: "listing-1", title: "Product", whatsappSeq: null, batchId: "batch-1",
      newStatus: "live", errorMsg: null,
      counts: { liveCount: 1, totalCount: 1, rejectedSkus: [] },
      ...patch,
    };
  }

  it("groups resolutions by whatsapp_batch_id and sends one message per batch", async () => {
    await notifyResolvedListings("user_1", [
      notice({ listingId: "l1", batchId: "batch-A", title: "A1" }),
      notice({ listingId: "l2", batchId: "batch-A", title: "A2" }),
      notice({ listingId: "l3", batchId: "batch-B", title: "B1" }),
    ]);

    expect(sent).toHaveLength(2);
    const combined = sent.find((m) => m.body.includes("A1") && m.body.includes("A2"));
    expect(combined).toBeDefined();
    const single = sent.find((m) => m.body.includes("B1"));
    expect(single).toBeDefined();
  });

  it("sends nothing when the seller has no WhatsApp connection", async () => {
    connResult = { connected: false, phoneNumber: null };
    await notifyResolvedListings("user_1", [notice()]);
    expect(sent).toHaveLength(0);
  });

  it("does nothing when nothing resolved this run", async () => {
    await notifyResolvedListings("user_1", []);
    expect(sent).toHaveLength(0);
  });
});

describe("toResolvedNotice — what the cron route collects per listing", () => {
  const listing = { id: "listing-1", title: "Electric Kettle", whatsapp_batch_id: "batch-1" };
  const liveResult: FeedResolution = { status: "live", error: null, liveCount: 1, totalCount: 1, rejectedSkus: [] };

  it("builds a notice when the status actually changed and a batch id is present", () => {
    const notice = toResolvedNotice(listing, "pending_approval", liveResult);
    expect(notice).toEqual({
      listingId: "listing-1", title: "Electric Kettle", whatsappSeq: null, batchId: "batch-1",
      newStatus: "live", errorMsg: null,
      counts: { liveCount: 1, totalCount: 1, rejectedSkus: [] },
    });
  });

  it("carries whatsapp_seq through when the listing has one", () => {
    const withSeq = { ...listing, whatsapp_seq: 2 };
    const notice = toResolvedNotice(withSeq, "pending_approval", liveResult);
    expect(notice?.whatsappSeq).toBe(2);
  });

  it("returns null when the status did not change this pass — nothing to notify about", () => {
    const stillPending: FeedResolution = { status: "pending_approval", error: null, liveCount: 0, totalCount: 0, rejectedSkus: [] };
    expect(toResolvedNotice(listing, "pending_approval", stillPending)).toBeNull();
  });

  // A web-app-only listing has no whatsapp_batch_id — notifyListingResolved's
  // own early-return always skipped these; toResolvedNotice must too, or a
  // web seller's listing would (at best) be silently dropped by
  // notifyResolvedListings, or (at worst) crash it on a null batchId.
  it("returns null for a listing with no whatsapp_batch_id, even though it resolved", () => {
    const webListing = { id: "listing-2", title: "Web Product", whatsapp_batch_id: null };
    expect(toResolvedNotice(webListing, "pending_approval", liveResult)).toBeNull();
  });
});
