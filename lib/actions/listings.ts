"use server";

import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import type { ListingRow } from "@/lib/supabase/types";

// ─── Fetch all listings for the current user ──────────────────────────────────

export async function getListings() {
  const { userId } = await auth();
  if (!userId) return [];

  const db = createServerClient();
  const { data, error } = await db
    .from("listings")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) { console.error("getListings:", error); return []; }
  return data ?? [];
}

// ─── Fetch a single listing ───────────────────────────────────────────────────

export async function getListing(id: string) {
  const { userId } = await auth();
  if (!userId) return null;

  const db = createServerClient();
  const { data, error } = await db
    .from("listings")
    .select("*, variants(*)")
    .eq("id", id)
    .eq("user_id", userId)
    .single();

  if (error) { console.error("getListing:", error); return null; }
  return data;
}

// ─── Create a new listing (draft) ────────────────────────────────────────────

export async function createListing(input: {
  title?: string;
  images?: string[];
  category_id?: string;
  category_path?: string;
  category_code?: string;
  commission_rate?: number;
}) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthenticated");

  const db = createServerClient();
  const sku = `PA-${Date.now().toString(36).toUpperCase()}`;

  const { data, error } = await db
    .from("listings")
    .insert({
      user_id: userId,
      sku,
      title: input.title ?? null,
      images: input.images ?? [],
      category_id: input.category_id ?? null,
      category_path: input.category_path ?? null,
      category_code: input.category_code ?? null,
      commission_rate: input.commission_rate ?? null,
      status: "draft",
    })
    .select()
    .single();

  if (error) throw new Error(error.message);
  revalidatePath("/listings");
  return data;
}

// ─── Update a listing ─────────────────────────────────────────────────────────

export async function updateListing(
  id: string,
  updates: Partial<Omit<ListingRow, "id" | "user_id" | "created_at" | "updated_at">>
) {
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
  return data;
}

// ─── Delete a listing ─────────────────────────────────────────────────────────

export async function deleteListing(id: string) {
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

  return data.reduce(
    (acc, row) => {
      const s = row.status as string;
      if (s in acc) acc[s as keyof typeof acc]++;
      return acc;
    },
    { draft: 0, live: 0, pending_approval: 0, failed: 0 }
  );
}
