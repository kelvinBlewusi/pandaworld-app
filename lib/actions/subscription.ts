"use server";

import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import type { Plan, Subscription } from "@/lib/types/subscription";
import {
  checkQuota,
  getQuotaSummary,
  type QuotaSummary,
} from "@/lib/billing/quota";

// ─── Get or initialise subscription row ──────────────────────────────────────
//
// Used by the billing settings page to render plan name, status,
// period_end, paystack metadata. Quota numbers come from
// getQuotaSummary() — keep the two concerns separate so the UI can
// request only what it needs.

export async function getSubscription(): Promise<Subscription | null> {
  const { userId } = await auth();
  if (!userId) return null;

  const db = createServerClient();

  // Try to upsert a default free row (ignoreDuplicates = don't overwrite existing)
  const { data, error } = await db
    .from("subscriptions")
    .upsert(
      {
        user_id: userId,
        plan: "free",
        status: "active",
        listings_used_this_period: 0,
        polishes_used_this_period: 0,
        period_start: new Date().toISOString(),
      },
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

// ─── Quota summary for the billing page ─────────────────────────────────────
//
// Thin wrapper so client components can call it without importing the
// quota module directly (quota.ts is "use server" — its exports can
// be called from client components, but going via this server action
// keeps the import surface tidy).

export async function getQuotaSummaryForCurrentUser(): Promise<QuotaSummary | null> {
  const { userId } = await auth();
  if (!userId) return null;
  return getQuotaSummary(userId);
}

// ─── Check if user can create a new listing ──────────────────────────────────
//
// Delegates to checkQuota in lib/billing/quota.ts. Kept here for
// backwards compatibility with existing callers that imported the
// canCreateListing name — internally it's a one-line shim now.

export async function canCreateListing(): Promise<{
  allowed: boolean;
  plan: Plan;
  used: number;
  limit: number;
}> {
  const { userId } = await auth();
  if (!userId) return { allowed: false, plan: "free", used: 0, limit: 5 };

  const result = await checkQuota(userId, "listing");
  return {
    allowed: result.allowed,
    plan:    result.plan,
    used:    result.used,
    limit:   result.limit,
  };
}

// ─── Cancel Paystack subscription ────────────────────────────────────────────
//
// Handles both flavours of paid plan since the May 2026 Payment Pages
// migration:
//
//   - Recurring Payment Page: Paystack fired subscription.create after
//     the first charge, so paystack_subscription_code is populated.
//     We call Paystack's /subscription/disable to stop future charges.
//
//   - One-time Payment Page (no recurring config in Paystack):
//     subscription_code is NULL because no Paystack subscription was
//     ever created. There's nothing to disable on their side — the
//     seller already paid once and Paystack won't auto-charge them
//     again. We just mark the row status=cancelled so the access
//     reverts to Free at the current period_end.

export async function cancelSubscription(): Promise<{ success: boolean; error?: string }> {
  const { userId } = await auth();
  if (!userId) return { success: false, error: "Unauthenticated" };

  const db = createServerClient();

  const { data: sub } = await db
    .from("subscriptions")
    .select("paystack_subscription_code, paystack_email_token, plan, status")
    .eq("user_id", userId)
    .single();

  if (!sub || sub.plan === "free" || sub.status !== "active") {
    return { success: false, error: "No active paid plan to cancel" };
  }

  // Recurring path: paystack_subscription_code is present, call Paystack
  // to disable the recurring charge.
  if (sub.paystack_subscription_code) {
    const res = await fetch("https://api.paystack.co/subscription/disable", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code:  sub.paystack_subscription_code,
        token: sub.paystack_email_token,
      }),
    });

    if (!res.ok) {
      return { success: false, error: "Failed to cancel with Paystack" };
    }
  }
  // One-time path: nothing to disable on Paystack — they already
  // received the money and aren't going to auto-charge again. Fall
  // through to the DB update below which marks status=cancelled.

  await db
    .from("subscriptions")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("user_id", userId);

  return { success: true };
}
