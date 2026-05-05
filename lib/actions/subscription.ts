"use server";

import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import type { Plan, Subscription } from "@/lib/types/subscription";
import { PLAN_LIMITS } from "@/lib/types/subscription";

// ─── Get or initialise subscription row ──────────────────────────────────────

export async function getSubscription(): Promise<Subscription | null> {
  const { userId } = await auth();
  if (!userId) return null;

  const db = createServerClient();

  // Try to upsert a default free row (ignoreDuplicates = don't overwrite existing)
  const { data, error } = await db
    .from("subscriptions")
    .upsert(
      { user_id: userId, plan: "free", status: "active" },
      { onConflict: "user_id", ignoreDuplicates: true }
    )
    .select()
    .maybeSingle();

  if (error || !data) {
    // Row already existed — just fetch it
    const { data: existing } = await db
      .from("subscriptions")
      .select("*")
      .eq("user_id", userId)
      .single();
    return existing as Subscription | null;
  }

  return data as Subscription;
}

// ─── Count listings for the current user ────────────────────────────────────

export async function getListingCount(): Promise<number> {
  const { userId } = await auth();
  if (!userId) return 0;

  const db = createServerClient();
  const { count } = await db
    .from("listings")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);

  return count ?? 0;
}

// ─── Check if user can create a new listing ──────────────────────────────────

export async function canCreateListing(): Promise<{
  allowed: boolean;
  plan: Plan;
  used: number;
  limit: number;
}> {
  const { userId } = await auth();
  if (!userId) return { allowed: false, plan: "free", used: 0, limit: 5 };

  const db = createServerClient();

  const [subResult, countResult] = await Promise.all([
    db.from("subscriptions").select("plan").eq("user_id", userId).maybeSingle(),
    db.from("listings").select("id", { count: "exact", head: true }).eq("user_id", userId),
  ]);

  const plan = (subResult.data?.plan ?? "free") as Plan;
  const used = countResult.count ?? 0;
  const limit = PLAN_LIMITS[plan];

  return { allowed: used < limit, plan, used, limit };
}

// ─── Cancel Paystack subscription ────────────────────────────────────────────

export async function cancelSubscription(): Promise<{ success: boolean; error?: string }> {
  const { userId } = await auth();
  if (!userId) return { success: false, error: "Unauthenticated" };

  const db = createServerClient();

  const { data: sub } = await db
    .from("subscriptions")
    .select("paystack_subscription_code, paystack_email_token")
    .eq("user_id", userId)
    .single();

  if (!sub?.paystack_subscription_code) {
    return { success: false, error: "No active subscription found" };
  }

  const res = await fetch("https://api.paystack.co/subscription/disable", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      code: sub.paystack_subscription_code,
      token: sub.paystack_email_token,
    }),
  });

  if (!res.ok) {
    return { success: false, error: "Failed to cancel with Paystack" };
  }

  await db
    .from("subscriptions")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("user_id", userId);

  return { success: true };
}
