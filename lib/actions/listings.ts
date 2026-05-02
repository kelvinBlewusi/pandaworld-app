"use server";

import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import type { ListingRow, ListingInsert } from "@/lib/supabase/types";

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

  const original = await getListing(id);
  if (!original) throw new Error("Listing not found");

  const db = createServerClient();
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
