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
import { checkQuota, incrementUsage } from "@/lib/billing/quota";
import { PLANS, getNextTierUpgrade } from "@/lib/billing/plans";

export function buildQuotaError(plan: string, used: number, limit: number): Error {
  const next = getNextTierUpgrade(plan as keyof typeof PLANS);
  const upgradeNote = next
    ? ` Upgrade to ${PLANS[next].name} (${PLANS[next].display_price}/month) for ${PLANS[next].monthly_listings} listings.`
    : " You're already on the highest tier — wait for next period or contact support.";
  return new Error(
    `QUOTA_EXCEEDED: You've used ${used} of ${limit} listings on the ${PLANS[plan as keyof typeof PLANS].name} plan this month.${upgradeNote}`
  );
}

export async function createListingForUser(userId: string, input: {
  title?: string;
  images?: string[];
  category_id?: string;
  category_path?: string;
  category_code?: string;
  commission_rate?: number;
}): Promise<ListingRow> {
  const db = createServerClient();

  // ── Plan enforcement: per-period listing quota ───────────────────────────
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
