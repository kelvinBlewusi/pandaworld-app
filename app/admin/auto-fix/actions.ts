"use server";

import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth/is-admin";
import { createServerClient } from "@/lib/supabase/server";
import { resubmitAutomatically } from "@/lib/jumia/auto-resubmit";
import { notifyResolvedListings, AUTO_RESUBMITTED } from "@/lib/jumia/push-listing";

/**
 * Fix and resubmit one rejected listing as lib/jumia/auto-resubmit.ts does
 * without a tap, for a rejection from before that existed, and tell its
 * seller on WhatsApp the same way.
 */
// Server actions are reachable by POST from anyone, whatever page renders
// them — the /admin layout's gate doesn't cover this, so check here too.
export async function autoFixListingAction(formData: FormData): Promise<void> {
  const { userId } = await auth();
  if (!isAdmin(userId)) throw new Error("Admin only");

  const listingId = String(formData.get("listing_id") ?? "").trim();
  if (!listingId) return;

  const db = createServerClient();
  const { data: row } = await db
    .from("listings")
    .select("id, user_id, status, title, jumia_error, whatsapp_batch_id, whatsapp_seq")
    .eq("id", listingId)
    .maybeSingle();
  if (!row || row.status !== "failed") redirect(`/admin/auto-fix?skipped=${encodeURIComponent(listingId)}`);

  const result = await resubmitAutomatically(row.user_id as string, listingId, row.jumia_error as string | null);
  if (!result) redirect(`/admin/auto-fix?failed=${encodeURIComponent(listingId)}`);

  if (result.note && row.whatsapp_batch_id) {
    await notifyResolvedListings(row.user_id as string, [{
      listingId,
      title:       row.title as string | null,
      whatsappSeq: row.whatsapp_seq as number | null,
      batchId:     row.whatsapp_batch_id as string,
      newStatus:   AUTO_RESUBMITTED,
      errorMsg:    result.note,
      counts:      { liveCount: 0, totalCount: 0, rejectedSkus: [] },
    }]);
  }
  redirect(`/admin/auto-fix?done=${encodeURIComponent(listingId)}`);
}
