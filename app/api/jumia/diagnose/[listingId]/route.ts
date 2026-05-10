import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import {
  getValidJumiaCredentials,
  getFeedStatus,
  getFeedProductDetails,
} from "@/lib/jumia/api";

// ─── GET /api/jumia/diagnose/[listingId] ──────────────────────────────────────
//
// Pulls live feed details from Jumia for one listing and returns everything
// the user (and we) need to figure out why a "Pending" listing isn't showing
// up in Vendor Center.
//
// Returns:
//   - Local listing snapshot (status, jumia_ref, jumia_error)
//   - Connection snapshot (shop_id, store_name, country, qc_status)
//   - Live GET /feeds/{feedId} response
//   - Live product-level details (productSid, qc.status, errors)
//   - Auto-applied status update if the feed has finalized

export async function GET(
  _req: NextRequest,
  { params }: { params: { listingId: string } }
) {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  const db = createServerClient();

  const { data: listing } = await db
    .from("listings")
    .select("id, sku, title, status, jumia_ref, jumia_error, jumia_synced_at, jumia_product_sid, jumia_qc_status")
    .eq("id", params.listingId)
    .eq("user_id", userId)
    .maybeSingle();

  if (!listing) {
    return NextResponse.json({ error: "Listing not found" }, { status: 404 });
  }

  if (!listing.jumia_ref) {
    return NextResponse.json({
      diagnosis: "NO_FEED_REF",
      detail:    "This listing was never pushed to Jumia (no feedId stored).",
      listing,
    });
  }

  const { data: conn } = await db
    .from("jumia_connections")
    .select("shop_id, store_name, country, status, app_id")
    .eq("user_id", userId)
    .maybeSingle();

  let creds: { accessToken: string; shopId: string; currency: string };
  try {
    creds = await getValidJumiaCredentials(userId);
  } catch (e) {
    return NextResponse.json({
      diagnosis: "AUTH_FAILED",
      detail:    `Could not get a valid Jumia token: ${(e as Error).message}`,
      listing,
      connection: conn,
    });
  }

  // Live calls in parallel
  const [feedStatus, productDetails] = await Promise.all([
    getFeedStatus(creds.accessToken, listing.jumia_ref),
    getFeedProductDetails(creds.accessToken, listing.jumia_ref),
  ]);

  // If the feed has a definitive verdict, update our DB so /listings reflects it
  if (feedStatus) {
    let newStatus: string | null = null;
    let errorMsg: string | null = null;
    if (feedStatus.status === "DONE") {
      newStatus = feedStatus.failed > 0 ? "failed" : "live";
      if (feedStatus.failed > 0 && feedStatus.errors.length > 0) {
        errorMsg = JSON.stringify(feedStatus.errors[0]).slice(0, 500);
      }
    } else if (feedStatus.status === "ERROR") {
      newStatus = "failed";
      errorMsg = feedStatus.errors.length
        ? JSON.stringify(feedStatus.errors[0]).slice(0, 500)
        : "Jumia feed processing error";
    }
    if (newStatus && newStatus !== listing.status) {
      const updates: Record<string, unknown> = {
        status:      newStatus,
        jumia_error: errorMsg,
        updated_at:  new Date().toISOString(),
      };
      if (productDetails && productDetails.length > 0) {
        const info = productDetails[0];
        if (info.productSid) updates.jumia_product_sid = info.productSid;
        if (info.qcStatus)   updates.jumia_qc_status   = info.qcStatus;
      }
      await db.from("listings").update(updates).eq("id", params.listingId);
    }
  }

  // Build a human-readable diagnosis
  let diagnosis: string;
  let humanMessage: string;
  if (!feedStatus) {
    diagnosis    = "FEED_NOT_FOUND";
    humanMessage = `Jumia returned no data for feedId ${listing.jumia_ref}. Possible causes: feed too new (try again in 30s), feedId stored incorrectly, or shopId mismatch.`;
  } else if (feedStatus.status === "PROCESSING" || feedStatus.status === "PENDING" || feedStatus.status === "QUEUED") {
    diagnosis    = "STILL_PROCESSING";
    humanMessage = `Jumia is still processing the feed (${feedStatus.status}). Check back in 1–2 minutes.`;
  } else if (feedStatus.status === "DONE" && feedStatus.failed === 0 && feedStatus.success > 0) {
    diagnosis    = "ACCEPTED";
    humanMessage = `Jumia accepted ${feedStatus.success} product(s). They should appear in Vendor Center now (may take 5–10 min for the UI to refresh).`;
  } else if (feedStatus.status === "DONE" && feedStatus.failed > 0) {
    diagnosis    = "PRODUCTS_REJECTED";
    humanMessage = `Feed processed, but Jumia rejected ${feedStatus.failed} product(s). See errors[] below for the exact reason — usually invalid brand code, invalid category code, missing required attribute, or shop ID mismatch.`;
  } else if (feedStatus.status === "ERROR") {
    diagnosis    = "FEED_ERROR";
    humanMessage = `The whole feed failed at Jumia. See errors[] below.`;
  } else {
    diagnosis    = "UNKNOWN_STATUS";
    humanMessage = `Unrecognized feed status: ${feedStatus.status}. Showing raw response for inspection.`;
  }

  return NextResponse.json({
    diagnosis,
    humanMessage,
    listing,
    connection: {
      shop_id:    conn?.shop_id     ?? null,
      store_name: conn?.store_name  ?? null,
      country:    conn?.country     ?? null,
      status:     conn?.status      ?? null,
    },
    feedStatus,
    productDetails,
    suggestion: suggestionFor(diagnosis, feedStatus, productDetails),
  });
}

function suggestionFor(
  diagnosis:      string,
  feedStatus:     Awaited<ReturnType<typeof getFeedStatus>>,
  productDetails: Awaited<ReturnType<typeof getFeedProductDetails>>
): string[] {
  const tips: string[] = [];

  if (diagnosis === "PRODUCTS_REJECTED") {
    tips.push("Open the errors[] field below — Jumia tells you exactly which field on which product is invalid.");
    tips.push("Most common rejections: brand.code (run Sync brands in Settings), category.code (use the category picker, don't type it), missing required attribute for the category.");
    if (productDetails && productDetails.length > 0 && productDetails.some((p) => p.errors.length > 0)) {
      tips.push("The per-product errors are also visible under productDetails[].errors below.");
    }
  } else if (diagnosis === "STILL_PROCESSING") {
    tips.push("Refresh this page in 1–2 minutes. Jumia usually finishes processing within 30 seconds, but during peak hours can take a few minutes.");
  } else if (diagnosis === "ACCEPTED") {
    tips.push("If the listing still doesn't appear in Vendor Center after 10 minutes, double-check that you're logged into the same shop the connection points to (shop_id field above).");
  } else if (diagnosis === "AUTH_FAILED") {
    tips.push("Re-authorise: Settings → Integrations → Disconnect → Reconnect.");
  } else if (diagnosis === "FEED_NOT_FOUND") {
    tips.push("If this persists, the feedId stored in the DB doesn't match anything Jumia knows about. Push the listing again to get a fresh feedId.");
  }

  return tips;
}
