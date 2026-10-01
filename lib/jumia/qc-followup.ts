/**
 * Following a listing past "live" until Jumia's quality check decides.
 *
 * A feed that finishes without errors means Jumia CREATED the product.
 * Quality control (QC) reviews it afterwards and can still reject it. On
 * 2026-09-30 a Malta Guinness listing and a body lotion were announced
 * "🎉 live" in WhatsApp, then rejected in Vendor Center ("Wrong Category:
 * Category mismatch: AI suggests Grocery / Beverages / Bottled Beverages,
 * Water & Drink Mixes / Soft Drinks (shares 3 path segments but leaf
 * differs)"), and nothing told the seller.
 *
 * The feeds cron (app/api/cron/jumia-feeds) passes the listings due a
 * check (qc_followup_candidates(), supabase/migrations/2026-10-01_jumia-
 * qc-followup.sql) to followUpQc, which reads each one's QC from
 * GET /catalog/products. Approved: recorded, along with the product sid
 * that price and stock updates need. Rejected: the listing goes back to
 * failed with Jumia's reason, stops counting as a live example, any charge
 * is refunded, and the seller gets the usual rejection message with a
 * Fix & resubmit button. A "Wrong Category" rejection names the category
 * Jumia wants, which Fix & resubmit switches to (jumiaSuggestedCategoryPath).
 */

import { createServerClient } from "@/lib/supabase/server";
import { getProductQc, type ProductQc } from "@/lib/jumia/api";
import { logFeedOutcome } from "@/lib/jumia/feed-outcomes";
import { forgetLiveListing } from "@/lib/jumia/live-listings";
import { refundLiveListing } from "@/lib/billing/extension-credits";
import { toResolvedNotice, type ResolvedListingNotice } from "@/lib/jumia/push-listing";

export interface QcCandidate {
  id:                string;
  jumia_ref:         string;
  title:             string | null;
  whatsapp_batch_id: string | null;
  whatsapp_seq:      number | null;
  sku:               string | null;
  category_code:     string | null;
}

export type QcVerdict =
  | { kind: "pending" }
  | { kind: "approved"; productSid: string | null }
  | { kind: "rejected"; reason: string | null; comment: string | null };

/**
 * One listing's verdict from its SKUs' QC results. Waits while any SKU is
 * still in review or wasn't found yet. Rejected only when every SKU is; a
 * listing with some variants approved is still live.
 */
export function qcVerdict(skuCount: number, results: (ProductQc | null)[]): QcVerdict {
  const known = results.filter((r): r is ProductQc => !!r?.status);
  if (skuCount === 0 || known.length < skuCount) return { kind: "pending" };
  if (known.some((r) => r.status !== "APPROVED" && r.status !== "REJECTED")) return { kind: "pending" };
  const approved = known.find((r) => r.status === "APPROVED");
  if (approved) return { kind: "approved", productSid: approved.productSid ?? known.find((r) => r.productSid)?.productSid ?? null };
  return { kind: "rejected", reason: known[0].reason, comment: known[0].comment };
}

/**
 * The category Jumia's QC suggests, as a "A > B > C" path: from its own
 * comment ("Category mismatch: AI suggests Grocery / Beverages / Soft
 * Drinks (shares 3 path segments but leaf differs)") or from the text
 * describeQcRejection stored. Null when it names none.
 */
export function jumiaSuggestedCategoryPath(text: string | null | undefined): string | null {
  if (!text) return null;
  const ours = text.match(/Jumia suggests "([^"]+)"/);
  if (ours) return ours[1].trim();
  const theirs = text.match(/AI suggests\s+(.+?)\s*(?:\(|$)/i);
  if (!theirs) return null;
  const path = theirs[1].split(/\s+\/\s+/).map((s) => s.trim()).filter(Boolean).join(" > ");
  return path || null;
}

/**
 * What the seller is told, and what Fix & resubmit later reads
 * (jumia_error). Jumia's "Other Reason" / "Rejected" says nothing, so it
 * isn't repeated back.
 */
export function describeQcRejection(reason: string | null, comment: string | null): string {
  const r = reason && !/^other reasons?$/i.test(reason) ? reason : null;
  const c = comment && !/^rejected\.?$/i.test(comment) ? comment : null;
  const suggested = jumiaSuggestedCategoryPath(c);
  if (suggested) return `${r ?? "Wrong category"} (quality check). Jumia suggests "${suggested}".`;
  if (r && c) return `${r} (quality check): ${c}`;
  if (r) return `${r} (quality check).`;
  if (c) return `quality check: ${c}`;
  return "its quality check gave no reason. Vendor Center may say more.";
}

/**
 * Check QC for one seller's candidates and act on each verdict. Returns
 * the rejections to notify about, for the caller to send together with
 * the feed resolutions from the same run. Never throws.
 */
export async function followUpQc(
  accessToken: string,
  country:     string | null,
  candidates:  QcCandidate[],
): Promise<ResolvedListingNotice[]> {
  if (candidates.length === 0) return [];
  const db = createServerClient();
  const notices: ResolvedListingNotice[] = [];

  // The SKUs that went live in each listing's latest feed: the product's
  // variants, each with its own QC.
  const { data: outcomeRows } = await db
    .from("jumia_feed_outcomes")
    .select("listing_id, feed_id, seller_sku")
    .in("listing_id", candidates.map((c) => c.id))
    .eq("outcome", "live");

  for (const c of candidates) {
    try {
      const skus = Array.from(new Set(
        ((outcomeRows ?? []) as { listing_id: string; feed_id: string | null; seller_sku: string | null }[])
          .filter((r) => r.listing_id === c.id && r.feed_id === c.jumia_ref && r.seller_sku)
          .map((r) => r.seller_sku as string),
      ));
      if (skus.length === 0 && c.sku) skus.push(c.sku);

      const results = await Promise.all(skus.map((sku) => getProductQc(accessToken, sku, country)));
      const verdict = qcVerdict(skus.length, results);
      const checkedAt = new Date().toISOString();

      if (verdict.kind === "pending") {
        await db.from("listings").update({ jumia_qc_checked_at: checkedAt }).eq("id", c.id);
        continue;
      }

      if (verdict.kind === "approved") {
        await db.from("listings").update({
          jumia_qc_status:     "approved",
          jumia_qc_checked_at: checkedAt,
          ...(verdict.productSid ? { jumia_product_sid: verdict.productSid } : {}),
        }).eq("id", c.id);
        continue;
      }

      const errorMsg = describeQcRejection(verdict.reason, verdict.comment);
      // Only from live: a seller who already resubmitted moved it on.
      const { data: moved } = await db.from("listings").update({
        status:              "failed",
        jumia_qc_status:     "rejected",
        jumia_qc_checked_at: checkedAt,
        jumia_error:         errorMsg,
        credits_due:         null,
      }).eq("id", c.id).eq("status", "live").select("id");
      if (!moved || moved.length === 0) continue;

      console.info(`[qc] ${c.id} rejected in QC: ${errorMsg}`);
      await forgetLiveListing(c.id);
      await refundLiveListing(c.id);
      await logFeedOutcome({
        listingId:    c.id,
        feedId:       c.jumia_ref,
        sellerSku:    skus[0] ?? null,
        country,
        categoryCode: c.category_code,
        outcome:      "rejected",
        rawError:     [verdict.reason, verdict.comment].filter(Boolean).join(": ") || "Rejected in quality check",
      });

      const notice = toResolvedNotice(c, "live", {
        status: "failed", error: errorMsg, liveCount: 0, totalCount: skus.length, rejectedSkus: skus,
      });
      if (notice) notices.push(notice);
    } catch (e) {
      console.warn(`[qc] check failed for ${c.id}: ${(e as Error).message}`);
      // Paced like a check that found nothing, so a failing listing isn't
      // retried every minute.
      await db.from("listings").update({ jumia_qc_checked_at: new Date().toISOString() }).eq("id", c.id);
    }
  }
  return notices;
}
