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
const sent: { to: string; body: string; kind: string; buttons?: string[] }[] = [];

jest.mock("@/lib/supabase/server", () => ({
  createServerClient: () => db,
}));

jest.mock("@/lib/whatsapp/client", () => ({
  sendTextIfConfigured: async (to: string, body: string) => { sent.push({ to, body, kind: "text" }); },
  sendButtonsIfConfigured: async (to: string, body: string, buttons: { id: string; title: string }[]) => {
    sent.push({ to, body, kind: "buttons", buttons: buttons.map((b) => b.id) });
  },
  sendCtaUrlIfConfigured: async (to: string, body: string) => { sent.push({ to, body, kind: "cta" }); },
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

import { refreshPendingFeedStatus, notifyBatchResolved, notifyResolvedListings, toResolvedNotice, type ResolvedListingNotice, type FeedResolution } from "@/lib/jumia/push-listing";

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
    expect(sent[0].body).toContain("is now live on Jumia");
  });
});

describe("notifyBatchResolved", () => {
  function notice(patch: Partial<ResolvedListingNotice> = {}): ResolvedListingNotice {
    return {
      listingId: "listing-1", title: "Electric Kettle", batchId: "batch-1",
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
      notice({ listingId: "listing-1", title: "Electric Kettle", newStatus: "live" }),
      notice({ listingId: "listing-2", title: "Baby Carrier", newStatus: "failed", errorMsg: "Attribute [variation] with invalid value [Navy Blue]" }),
      notice({ listingId: "listing-3", title: "Blender", newStatus: "live" }),
    ]);

    const texts = sent.filter((m) => m.kind === "text");
    expect(texts).toHaveLength(1);
    expect(texts[0].body).toContain("Since your last update: 2 went live, 1 rejected");
    expect(texts[0].body).toContain('"Electric Kettle" is now live');
    expect(texts[0].body).toContain('"Baby Carrier" was rejected by Jumia: Attribute [variation]');
    expect(texts[0].body).toContain('"Blender" is now live');

    // One combined way back in, not a Fix & resubmit button per rejection —
    // WhatsApp buttons and a cta_url can't share one message.
    const ctas = sent.filter((m) => m.kind === "cta");
    expect(ctas).toHaveLength(1);
    expect(sent.some((m) => m.kind === "buttons")).toBe(false);
  });

  it("sends no CTA when everything in the batch went live", async () => {
    await notifyBatchResolved(PHONE, "batch-1", [
      notice({ listingId: "listing-1", newStatus: "live" }),
      notice({ listingId: "listing-2", newStatus: "live" }),
    ]);

    expect(sent.filter((m) => m.kind === "cta")).toHaveLength(0);
    expect(sent[0].body).toContain("2 more products went live");
  });

  it("does nothing for an empty batch", async () => {
    await notifyBatchResolved(PHONE, "batch-1", []);
    expect(sent).toHaveLength(0);
  });
});

describe("notifyResolvedListings", () => {
  function notice(patch: Partial<ResolvedListingNotice> = {}): ResolvedListingNotice {
    return {
      listingId: "listing-1", title: "Product", batchId: "batch-1",
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
      listingId: "listing-1", title: "Electric Kettle", batchId: "batch-1",
      newStatus: "live", errorMsg: null,
      counts: { liveCount: 1, totalCount: 1, rejectedSkus: [] },
    });
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
