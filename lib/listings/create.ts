/**
 * Draft-listing creation, extracted out of lib/actions/listings.ts so a
 * caller with no Clerk session (the WhatsApp webhook) can create a listing
 * for a known userId — the exact same reason lib/jumia/push-listing.ts and
 * lib/actions/auto-analyze.ts exist.
 *
 * This does NOT live in lib/actions/listings.ts because that file starts
 * with "use server": every export from a "use server" file becomes a
 * publicly-invokable server action, so a userId-parameterized variant
 * placed there would let any client call it with an arbitrary userId,
 * bypassing auth entirely. This is a plain module with no such surface —
 * only importable by code that already resolved userId itself (the web
 * app's createListing, after auth(); the webhook, after looking up the
 * linked account).
 */

import { createServerClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import type { ListingRow, ListingInsert } from "@/lib/supabase/types";

/**
 * Creating a draft is free: what costs credits is the AI draft that fills
 * it (WHATSAPP_DRAFT_CREDIT_COST, charged by the WhatsApp worker and the
 * web auto-analyze route after it succeeds). The monthly listing quota
 * that used to be checked here was removed 2026-09-28.
 */
export async function createListingForUser(userId: string, input: {
  title?: string;
  images?: string[];
  category_id?: string;
  category_path?: string;
  category_code?: string;
  commission_rate?: number;
  /**
   * The chat batch this listing belongs to, and its position in it.
   *
   * Set at INSERT rather than in a follow-up update, because a partial
   * unique index on the pair is what stops a WhatsApp album — several
   * photos delivered as separate webhooks within the same second — from
   * racing and producing one listing per photo. Tagging afterwards
   * leaves a window where two concurrent deliveries both see no listing
   * for the slot and both create one.
   */
  whatsapp_batch_id?: string | null;
  whatsapp_seq?: number | null;
}): Promise<ListingRow> {
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
    sale_price: null,
    sale_start_date: null,
    sale_end_date: null,
    whatsapp_batch_id: input.whatsapp_batch_id ?? null,
    whatsapp_seq: input.whatsapp_seq ?? null,
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
