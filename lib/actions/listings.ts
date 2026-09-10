"use server";

import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import type { ListingRow, VariantRow } from "@/lib/supabase/types";
import { checkQuota, incrementUsage, decrementUsage } from "@/lib/billing/quota";
import { createListingForUser, buildQuotaError } from "@/lib/listings/create";

// ─── Fetch all listings for the current user ──────────────────────────────────

export async function getListings(): Promise<ListingRow[]> {
  const { userId } = await auth();
  if (!userId) return [];

  const db = createServerClient();
  const { data, error } = await db
    .from("listings")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) { console.error("getListings:", error); return []; }
  return (data ?? []) as ListingRow[];
}

// ─── Fetch a single listing ───────────────────────────────────────────────────

export async function getListing(id: string): Promise<ListingRow | null> {
  const { userId } = await auth();
  if (!userId) return null;

  const db = createServerClient();
  const { data, error } = await db
    .from("listings")
    .select("*")
    .eq("id", id)
    .eq("user_id", userId)
    .single();

  if (error) { console.error("getListing:", error); return null; }
  return data as ListingRow;
}

// ─── Create a new listing (draft) ────────────────────────────────────────────

export async function createListing(input: {
  title?: string;
  images?: string[];
  category_id?: string;
  category_path?: string;
  category_code?: string;
  commission_rate?: number;
}): Promise<ListingRow> {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthenticated");
  return createListingForUser(userId, input);
}

// ─── Update a listing ─────────────────────────────────────────────────────────

export async function updateListing(
  id: string,
  updates: Partial<Omit<ListingRow, "id" | "user_id" | "created_at" | "updated_at">>
): Promise<ListingRow> {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthenticated");

  const db = createServerClient();
  const { data, error } = await db
    .from("listings")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", userId)
    .select()
    .single();

  if (error) throw new Error(error.message);
  revalidatePath("/listings");
  revalidatePath(`/listings/${id}/review`);
  return data as ListingRow;
}

// ─── Delete a listing ─────────────────────────────────────────────────────────
//
// Quota refund policy:
//   - draft + processing  → refund (the seller paid the quota cost for
//     the AI analysis, never actually used it on Jumia — give it back so
//     they can re-use the credit on a real listing).
//   - pending_approval    → NO refund (already on Jumia waiting for QC,
//     the AI work + push was consumed).
//   - live + failed       → NO refund (Jumia QC's already evaluated it).
//
// This is what "if a user deletes drafts that were not submitted to
// jumia, lets their quota reset" means in practice — only refund for
// the never-pushed states.

const QUOTA_REFUNDABLE_STATUSES = new Set(["draft", "processing"]);

export async function deleteListing(id: string): Promise<void> {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthenticated");

  const db = createServerClient();

  // Read status BEFORE deletion so we know whether to refund.
  // .maybeSingle() — if the listing's gone (race), we just delete-noop.
  const { data: listing } = await db
    .from("listings")
    .select("status")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();

  const shouldRefund =
    listing != null &&
    typeof listing.status === "string" &&
    QUOTA_REFUNDABLE_STATUSES.has(listing.status);

  const { error } = await db
    .from("listings")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);

  if (error) throw new Error(error.message);

  // Refund AFTER the delete succeeds so we don't credit a quota back
  // when the delete itself failed.
  if (shouldRefund) {
    await decrementUsage(userId, "listing");
  }

  revalidatePath("/listings");
}

// ─── Duplicate a listing ─────────────────────────────────────────────────────

export async function duplicateListing(id: string): Promise<ListingRow> {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthenticated");

  const db = createServerClient();

  // ── Plan enforcement (same monthly quota applies to duplicates) ──────────
  const quota = await checkQuota(userId, "listing");
  if (!quota.allowed) {
    throw buildQuotaError(quota.plan, quota.used, quota.limit);
  }

  const original = await getListing(id);
  if (!original) throw new Error("Listing not found");

  const sku = `PA-${Date.now().toString(36).toUpperCase()}`;

  const { id: _id, created_at: _c, updated_at: _u, ...rest } = original;
  void _id; void _c; void _u;

  const { data, error } = await db
    .from("listings")
    .insert({
      ...rest,
      sku,
      title: original.title ? `${original.title} (Copy)` : null,
      status: "draft",
    })
    .select()
    .single();

  if (error) throw new Error(error.message);

  // Duplicates count against the same monthly quota as fresh creates.
  await incrementUsage(userId, "listing");

  revalidatePath("/listings");
  return data as ListingRow;
}

// ─── Bulk delete listings ────────────────────────────────────────────────────
//
// Same refund policy as deleteListing — count how many of the listings
// being bulk-deleted are in a refundable state (draft / processing) and
// decrement the quota by that exact count. Listings already pushed to
// Jumia (pending_approval / live / failed) do not refund.

export async function bulkDeleteListings(ids: string[]): Promise<void> {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthenticated");
  if (!ids.length) return;

  const db = createServerClient();

  // Read statuses for all rows we're about to delete (single round-trip).
  // Only count refundable rows — push the rest through without a credit.
  const { data: targets } = await db
    .from("listings")
    .select("status")
    .in("id", ids)
    .eq("user_id", userId);

  const refundCount = (targets ?? []).reduce<number>(
    (acc, row) =>
      typeof row.status === "string" && QUOTA_REFUNDABLE_STATUSES.has(row.status)
        ? acc + 1
        : acc,
    0,
  );

  const { error } = await db
    .from("listings")
    .delete()
    .in("id", ids)
    .eq("user_id", userId);

  if (error) throw new Error(error.message);

  // Decrement once per refundable listing. Loop is cheap (each row is
  // one tiny SQL UPDATE) and decrementUsage floors at 0 so we can't
  // over-refund even if `targets` and the delete diverged.
  for (let i = 0; i < refundCount; i++) {
    await decrementUsage(userId, "listing");
  }

  revalidatePath("/listings");
}

// ─── Bulk update listing status ──────────────────────────────────────────────

export async function bulkUpdateStatus(
  ids: string[],
  status: string
): Promise<void> {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthenticated");
  if (!ids.length) return;

  const db = createServerClient();
  const { error } = await db
    .from("listings")
    .update({ status, updated_at: new Date().toISOString() })
    .in("id", ids)
    .eq("user_id", userId);

  if (error) throw new Error(error.message);
  revalidatePath("/listings");
}

// ─── Dashboard stats ──────────────────────────────────────────────────────────

export async function getDashboardStats() {
  const { userId } = await auth();
  if (!userId) return { draft: 0, live: 0, pending_approval: 0, failed: 0 };

  const db = createServerClient();
  const { data, error } = await db
    .from("listings")
    .select("status")
    .eq("user_id", userId);

  if (error || !data) return { draft: 0, live: 0, pending_approval: 0, failed: 0 };

  const counts = { draft: 0, live: 0, pending_approval: 0, failed: 0 };
  for (const row of data as { status: string }[]) {
    if (row.status in counts) {
      counts[row.status as keyof typeof counts]++;
    }
  }
  return counts;
}

// ─── Variants table I/O ──────────────────────────────────────────────────────

/** Read all variant rows for a listing, ordered by created_at. */
export async function getVariantsForListing(listingId: string): Promise<VariantRow[]> {
  const { userId } = await auth();
  if (!userId) return [];

  const db = createServerClient();

  // Verify the listing belongs to this user first (RLS would also block,
  // but an explicit check returns [] instead of throwing).
  const { data: owner } = await db
    .from("listings")
    .select("id")
    .eq("id", listingId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!owner) return [];

  const { data, error } = await db
    .from("variants")
    .select("*")
    .eq("listing_id", listingId)
    .order("created_at", { ascending: true });
  if (error) {
    console.error("getVariantsForListing:", error);
    return [];
  }
  return (data ?? []) as VariantRow[];
}

/**
 * Replace the variants list for a listing.
 *
 * The seller's review-page UI owns the canonical variants state (axes-
 * derived combos OR a single synthetic row for simple products). On save
 * we mirror that into the DB so:
 *   - the push route can read the seller's typed `variation` instead of
 *     falling back to listing.color in buildBaseProduct
 *   - a refreshed review page hydrates from DB instead of resetting to
 *     "blank + colour fallback"
 *
 * Implementation: delete all existing rows for the listing, insert the
 * new ones. Cheap because variants per listing are small (1–~50). Keeps
 * the table free of orphaned rows when the seller removes a combo.
 */
export async function replaceVariantsForListing(
  listingId: string,
  rows: Array<Omit<VariantRow, "id" | "listing_id" | "created_at">>,
): Promise<void> {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthenticated");

  const db = createServerClient();

  // Ownership guard (belt-and-braces alongside RLS).
  const { data: owner } = await db
    .from("listings")
    .select("id")
    .eq("id", listingId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!owner) throw new Error("Listing not found");

  // Wipe + insert. Wrapped in best-effort error handling rather than a
  // transaction (Supabase REST doesn't support multi-statement txns).
  // The window between delete and insert is tiny; if it fails, the user
  // gets an explicit save error to retry.
  const { error: delErr } = await db
    .from("variants")
    .delete()
    .eq("listing_id", listingId);
  if (delErr) throw new Error(`Failed to clear variants: ${delErr.message}`);

  if (rows.length === 0) {
    revalidatePath(`/listings/${listingId}/review`);
    return;
  }

  const payload = rows.map((r) => ({ ...r, listing_id: listingId }));
  const { error: insErr } = await db.from("variants").insert(payload);
  if (insErr) throw new Error(`Failed to insert variants: ${insErr.message}`);

  revalidatePath(`/listings/${listingId}/review`);
}
