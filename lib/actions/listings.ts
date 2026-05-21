"use server";

import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import type { ListingRow, ListingInsert, VariantRow } from "@/lib/supabase/types";
import { checkQuota, incrementUsage } from "@/lib/billing/quota";
import { PLANS, getNextTierUpgrade } from "@/lib/billing/plans";

// ─── Quota-error helper ──────────────────────────────────────────────────────
//
// Format the "you've hit your monthly quota" message consistently so
// the API route + UI know what to display. The prefix is what the
// process-listing route uses to translate to HTTP 402. The human part
// names the next tier so the seller can act on it.
//
// Returning a normal Error (not a custom class) keeps the function
// thenable from server components without needing a class export.

function buildQuotaError(plan: string, used: number, limit: number): Error {
  const next = getNextTierUpgrade(plan as keyof typeof PLANS);
  const upgradeNote = next
    ? ` Upgrade to ${PLANS[next].name} (${PLANS[next].display_price}/month) for ${PLANS[next].monthly_listings} listings.`
    : " You're already on the highest tier — wait for next period or contact support.";
  return new Error(
    `QUOTA_EXCEEDED: You've used ${used} of ${limit} listings on the ${PLANS[plan as keyof typeof PLANS].name} plan this month.${upgradeNote}`
  );
}

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

  const db = createServerClient();

  // ── Plan enforcement: per-period listing quota ───────────────────────────
  // Delegated to lib/billing/quota.ts which handles lazy period resets
  // and legacy-Pro grandfather logic. The error message names the
  // recommended upgrade tier so the UI can deep-link the seller.
  const quota = await checkQuota(userId, "listing");
  if (!quota.allowed) {
    throw buildQuotaError(quota.plan, quota.used, quota.limit);
  }

  const sku = `PA-${Date.now().toString(36).toUpperCase()}`;

  const insert: ListingInsert = {
    user_id: userId,
    sku,
    title: input.title ?? null,
    images: input.images ?? [],
    category_id: input.category_id ?? null,
    category_path: input.category_path ?? null,
    category_code: input.category_code ?? null,
    commission_rate: input.commission_rate ?? null,
    status: "draft",
    description: null,
    highlights: null,
    brand: null,
    color: null,
    color_family: null,
    weight_kg: null,
    main_material: null,
    material_family: null,
    production_country: null,
    warranty_duration: null,
    warranty_type: null,
    warranty_text: null,
    warranty_address: null,
    model: null,
    product_line: null,
    size_l: null,
    size_w: null,
    size_h: null,
    certifications: [],
    youtube_id: null,
    selling_price: null,
  };

  const { data, error } = await db
    .from("listings")
    .insert(insert)
    .select()
    .single();

  if (error) throw new Error(error.message);

  // Bump the period counter only AFTER a successful insert — keeps the
  // quota accurate even if Supabase errors mid-flight.
  await incrementUsage(userId, "listing");

  revalidatePath("/listings");
  return data as ListingRow;
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

export async function deleteListing(id: string): Promise<void> {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthenticated");

  const db = createServerClient();
  const { error } = await db
    .from("listings")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);

  if (error) throw new Error(error.message);
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

export async function bulkDeleteListings(ids: string[]): Promise<void> {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthenticated");
  if (!ids.length) return;

  const db = createServerClient();
  const { error } = await db
    .from("listings")
    .delete()
    .in("id", ids)
    .eq("user_id", userId);

  if (error) throw new Error(error.message);
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
