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
    const s = feedStatus.status.toUpperCase();
    if (s === "DONE" || s === "COMPLETED") {
      newStatus = feedStatus.failed > 0 ? "failed" : "live";
      if (feedStatus.failed > 0 && feedStatus.errors.length > 0) {
        errorMsg = String(feedStatus.errors[0]).slice(0, 500);
      }
    } else if (s === "ERROR" || s === "FAILED") {
      newStatus = "failed";
      errorMsg = feedStatus.errors.length
        ? String(feedStatus.errors[0]).slice(0, 500)
        : "Jumia rejected the feed";
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
  const s = feedStatus?.status?.toUpperCase();
  if (!feedStatus) {
    diagnosis    = "FEED_NOT_FOUND";
    humanMessage = `Jumia returned no data for feedId ${listing.jumia_ref}. Possible causes: feed too new (try again in 30s), feedId stored incorrectly, or shopId mismatch.`;
  } else if (s === "PROCESSING" || s === "PENDING" || s === "QUEUED") {
    diagnosis    = "STILL_PROCESSING";
    humanMessage = `Jumia is still processing the feed (${feedStatus.status}). Check back in 1–2 minutes.`;
  } else if ((s === "DONE" || s === "COMPLETED") && feedStatus.failed === 0 && feedStatus.success > 0) {
    diagnosis    = "ACCEPTED";
    humanMessage = `Jumia accepted ${feedStatus.success} product(s). They should appear in Vendor Center now (may take 5–10 min for the UI to refresh).`;
  } else if (feedStatus.failed > 0 && feedStatus.errors.length > 0) {
    // Use the FIRST real error message as the human-readable explanation
    diagnosis    = "PRODUCTS_REJECTED";
    humanMessage = String(feedStatus.errors[0]);
  } else if (s === "FAILED" || s === "ERROR") {
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
    // Look at the actual error text to give context-specific advice
    const errText = [
      ...(feedStatus?.errors ?? []),
      ...(productDetails?.flatMap((p) => p.errors) ?? []),
    ].map(String).join(" ").toLowerCase();

    if (errText.includes("more specific") || errText.includes("can't list products in this category")) {
      tips.push("CATEGORY ISSUE: Jumia only accepts listings at the deepest (leaf) category — e.g. 'Garden Hoses', not 'Garden & Outdoors'.");
      tips.push("Open the listing → click 'Change' next to Category → pick a more specific subcategory.");
      tips.push("Then click Save & Push to Jumia again.");
    } else if (errText.includes("variation") && errText.includes("filled")) {
      tips.push("VARIATION FIX: This was a code bug — we were sending an empty variation field. The latest deploy auto-fills it from the product's color (or 'Default' if no color set). Just re-push the listing.");
    } else if (errText.includes("already exists in parent sku") || errText.includes("different parent sku")) {
      tips.push("DUPLICATE SKU: A previous push attempt already registered this product on Jumia's side. The next push will auto-generate a fresh SKU suffix (-RXXXX) to bypass the duplicate check. Just click Retry.");
    } else if (errText.includes("description") && errText.includes("characters")) {
      tips.push("DESCRIPTION TOO SHORT: Jumia requires 50–9,000 characters. Open the listing and expand the description to at least 50 characters.");
    } else if (errText.includes("brand")) {
      tips.push("BRAND ISSUE: The brand code is invalid. Edit the listing → click the Brand field → pick from the autocomplete (which queries Jumia's live brand catalog).");
    } else if (errText.includes("image")) {
      tips.push("IMAGE ISSUE: Re-upload images, or use the Polish button on the review page so they meet Jumia's 500×500–2000×2000 white-BG requirements.");
    } else if (errText.includes("attribute") || errText.includes("required")) {
      tips.push("MISSING REQUIRED ATTRIBUTE: Open the listing → scroll to the category-specific attributes → fill any field marked Required.");
    } else {
      tips.push("Open the errors[] field below — Jumia tells you exactly which field on which product is invalid.");
      tips.push("Most common rejections: brand.code, category.code, missing required attribute for the category.");
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
