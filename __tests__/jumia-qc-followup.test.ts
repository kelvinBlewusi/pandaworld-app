/**
 * Following a listing past "live" until Jumia's quality check decides
 * (lib/jumia/qc-followup.ts, getProductQc in lib/jumia/api.ts).
 *
 * Real case, 2026-09-30: a Malta Guinness listing and a body lotion were
 * announced live in WhatsApp, then rejected by QC in Vendor Center, and
 * nothing told the seller.
 */

import { FakeDb } from "./helpers/fake-supabase";

const db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({ createServerClient: () => db }));

const logged: { listingId: string; outcome: string; rawError?: string | null }[] = [];
jest.mock("@/lib/jumia/feed-outcomes", () => ({
  logFeedOutcome: async (o: { listingId: string; outcome: string; rawError?: string | null }) => { logged.push(o); },
}));
const forgotten: string[] = [];
jest.mock("@/lib/jumia/live-listings", () => ({
  forgetLiveListing: async (id: string) => { forgotten.push(id); },
}));
const refunded: string[] = [];
jest.mock("@/lib/billing/extension-credits", () => ({
  refundLiveListing: async (id: string) => { refunded.push(id); return { refunded: 0 }; },
}));

import { getProductQc } from "@/lib/jumia/api";
import {
  describeQcRejection,
  followUpQc,
  jumiaSuggestedCategoryPath,
  qcVerdict,
  type QcCandidate,
} from "@/lib/jumia/qc-followup";

const MALTA_REASON  = "Wrong Category";
const MALTA_COMMENT = "Category mismatch: AI suggests Grocery / Beverages / Bottled Beverages, Water & Drink Mixes / Soft Drinks (shares 3 path segments but leaf differs)";
const SOFT_DRINKS   = "Grocery > Beverages > Bottled Beverages, Water & Drink Mixes > Soft Drinks";

/** A GET /catalog/products response in the documented shape. */
function productsResponse(sku: string, qc: Record<string, unknown>, opts: { sid?: string; otherCountryFirst?: boolean } = {}) {
  const gh = { code: "jumia-gh", name: "Jumia Ghana", status: "ACTIVE", qc };
  const ng = { code: "jumia-ng", name: "Jumia Nigeria", status: "ACTIVE", qc: { status: "APPROVED" } };
  return {
    products: [{
      id: opts.sid ?? "d335de79-79c4-4403-b6eb-0ea6a0efe43e",
      name: "Malta Guinness Soft Drink",
      variations: [
        { id: "v-other", sellerSku: "SOMETHING-ELSE", businessClients: [] },
        { id: "v-1", sellerSku: sku, businessClients: opts.otherCountryFirst ? [ng, gh] : [gh] },
      ],
    }],
    nextToken: null,
    isLastPage: true,
  };
}

let qcBySku: Record<string, Record<string, unknown> | null> = {};
const fetched: string[] = [];
beforeEach(() => {
  qcBySku = {};
  fetched.length = 0;
  logged.length = 0;
  forgotten.length = 0;
  refunded.length = 0;
  global.fetch = jest.fn(async (url: string) => {
    fetched.push(url);
    const sku = decodeURIComponent(new URL(url).searchParams.get("sellerSku") ?? "");
    const qc = qcBySku[sku];
    return {
      ok: true,
      json: async () => (qc ? productsResponse(sku, qc) : { products: [], nextToken: null, isLastPage: true }),
    };
  }) as unknown as typeof fetch;
});

describe("getProductQc", () => {
  it("reads the seller's country's QC block for the matching SKU", async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => productsResponse("PA-MUO503EV-P6X330",
        { status: "REJECTED", rejectionReason: MALTA_REASON, rejectionComment: MALTA_COMMENT },
        { otherCountryFirst: true }),
    })) as unknown as typeof fetch;

    expect(await getProductQc("token", "PA-MUO503EV-P6X330", "GH")).toEqual({
      sellerSku:  "PA-MUO503EV-P6X330",
      productSid: "d335de79-79c4-4403-b6eb-0ea6a0efe43e",
      status:     "REJECTED",
      reason:     MALTA_REASON,
      comment:    MALTA_COMMENT,
    });
  });

  it("is null when Jumia has no such product, or the call fails", async () => {
    expect(await getProductQc("token", "NOPE", "GH")).toBeNull();
    global.fetch = jest.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await getProductQc("token", "PA-1", "GH")).toBeNull();
  });
});

describe("qcVerdict", () => {
  const r = (status: string | null, extra: Record<string, unknown> = {}) =>
    ({ sellerSku: "s", productSid: null, status, reason: null, comment: null, ...extra });

  it("waits while any SKU is in review or not found yet", () => {
    expect(qcVerdict(1, [r("PENDING")])).toEqual({ kind: "pending" });
    expect(qcVerdict(1, [r("NOT_READY_TO_QC")])).toEqual({ kind: "pending" });
    expect(qcVerdict(2, [r("REJECTED"), null])).toEqual({ kind: "pending" });
    expect(qcVerdict(0, [])).toEqual({ kind: "pending" });
  });

  it("is rejected only when every SKU is", () => {
    expect(qcVerdict(1, [r("REJECTED", { reason: MALTA_REASON, comment: MALTA_COMMENT })]))
      .toEqual({ kind: "rejected", reason: MALTA_REASON, comment: MALTA_COMMENT });
    expect(qcVerdict(2, [r("REJECTED"), r("APPROVED", { productSid: "sid-2" })]))
      .toEqual({ kind: "approved", productSid: "sid-2" });
  });
});

describe("Jumia's reasons, for the seller", () => {
  it("names the category Jumia suggests", () => {
    expect(jumiaSuggestedCategoryPath(MALTA_COMMENT)).toBe(SOFT_DRINKS);
    const text = describeQcRejection(MALTA_REASON, MALTA_COMMENT);
    expect(text).toBe(`Wrong Category (quality check). Jumia suggests "${SOFT_DRINKS}".`);
    // And Fix & resubmit can read it back from what was stored.
    expect(jumiaSuggestedCategoryPath(text)).toBe(SOFT_DRINKS);
  });

  it("doesn't repeat Jumia's empty 'Other Reason' / 'Rejected' back", () => {
    expect(describeQcRejection("Other Reason", "Rejected")).toBe("its quality check gave no reason. Vendor Center may say more.");
    expect(describeQcRejection("Poor Image Quality", "Images are blurry")).toBe("Poor Image Quality (quality check): Images are blurry");
    expect(jumiaSuggestedCategoryPath("Poor Image Quality (quality check): Images are blurry")).toBeNull();
  });
});

describe("followUpQc", () => {
  const MALTA: QcCandidate = {
    id: "listing-malta", jumia_ref: "feed-2", title: "Malta Guinness Soft Drink - 330ml Bottles, Pack of 6",
    whatsapp_batch_id: "batch-1", whatsapp_seq: 2, sku: "PA-MUO503EV", category_code: "1002615",
  };

  beforeEach(() => {
    db.tables.listings = [{ id: MALTA.id, status: "live", jumia_qc_status: null, credits_due: null }];
    db.tables.jumia_feed_outcomes = [
      // An earlier feed's SKU: not this listing's product any more.
      { listing_id: MALTA.id, feed_id: "feed-1", seller_sku: "PA-OLD", outcome: "live" },
      { listing_id: MALTA.id, feed_id: "feed-2", seller_sku: "PA-MUO503EV-P6X330", outcome: "live" },
    ];
  });
  const listing = () => db.tables.listings[0];

  it("turns a QC rejection into a rejected listing the seller hears about", async () => {
    qcBySku["PA-MUO503EV-P6X330"] = { status: "REJECTED", rejectionReason: MALTA_REASON, rejectionComment: MALTA_COMMENT };

    const notices = await followUpQc("token", "GH", [MALTA]);

    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toContain("sellerSku=PA-MUO503EV-P6X330");
    expect(listing()).toMatchObject({
      status: "failed",
      jumia_qc_status: "rejected",
      jumia_error: `Wrong Category (quality check). Jumia suggests "${SOFT_DRINKS}".`,
    });
    expect(listing().jumia_qc_checked_at).toEqual(expect.any(String));
    expect(notices).toEqual([expect.objectContaining({
      listingId: MALTA.id, batchId: "batch-1", whatsappSeq: 2, newStatus: "failed",
      errorMsg: `Wrong Category (quality check). Jumia suggests "${SOFT_DRINKS}".`,
    })]);
    // Not a live example to learn categories from, not charged, and logged.
    expect(forgotten).toEqual([MALTA.id]);
    expect(refunded).toEqual([MALTA.id]);
    expect(logged).toEqual([expect.objectContaining({ listingId: MALTA.id, outcome: "rejected", rawError: `${MALTA_REASON}: ${MALTA_COMMENT}` })]);
  });

  it("records approval and the product sid that updates need, without a message", async () => {
    qcBySku["PA-MUO503EV-P6X330"] = { status: "APPROVED" };

    const notices = await followUpQc("token", "GH", [MALTA]);

    expect(notices).toEqual([]);
    expect(listing()).toMatchObject({ status: "live", jumia_qc_status: "approved", jumia_product_sid: "d335de79-79c4-4403-b6eb-0ea6a0efe43e" });
  });

  it("only notes the check while QC is still running", async () => {
    qcBySku["PA-MUO503EV-P6X330"] = { status: "PENDING" };

    expect(await followUpQc("token", "GH", [MALTA])).toEqual([]);
    expect(listing()).toMatchObject({ status: "live", jumia_qc_status: null });
    expect(listing().jumia_qc_checked_at).toEqual(expect.any(String));
  });

  it("leaves a listing the seller already resubmitted alone", async () => {
    qcBySku["PA-MUO503EV-P6X330"] = { status: "REJECTED", rejectionReason: MALTA_REASON, rejectionComment: MALTA_COMMENT };
    listing().status = "pending_approval";

    expect(await followUpQc("token", "GH", [MALTA])).toEqual([]);
    expect(listing().status).toBe("pending_approval");
    expect(refunded).toEqual([]);
  });

  it("falls back to the listing's own SKU when no live outcome was logged", async () => {
    db.tables.jumia_feed_outcomes = [];
    qcBySku["PA-MUO503EV"] = { status: "APPROVED" };

    await followUpQc("token", "GH", [MALTA]);

    expect(fetched[0]).toContain("sellerSku=PA-MUO503EV");
    expect(listing().jumia_qc_status).toBe("approved");
  });
});
