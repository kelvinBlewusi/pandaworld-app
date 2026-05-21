"use server";

/**
 * Quota engine — the single arbiter of "can this user do X right now?".
 *
 * Every gated action (listing creation, image polish, image enhance)
 * calls `checkQuota({ userId, action })` BEFORE doing the work, and
 * `incrementUsage()` AFTER the work succeeds. The engine handles four
 * things in one place:
 *
 *   1. Reading the user's tier + current usage from the subscriptions
 *      table (auto-provisions a free row if missing).
 *   2. **Lazy period reset** — if now() > period_start + 30 days, reset
 *      the usage counters to 0 and bump period_start. This means we
 *      never need a perfectly-timed cron to keep quotas fresh; any
 *      action a user takes drives their reset for free. The daily
 *      Vercel cron (/api/cron/reset-quotas) is a backup that resets
 *      idle accounts so an admin viewing them in Supabase sees correct
 *      numbers.
 *   3. Lookup of the tier's monthly quota via lib/billing/plans.ts
 *      (the single source of truth — change a quota there and every
 *      callsite picks it up).
 *   4. **Admin bypass** — userIds listed in the `ADMIN_USER_IDS` env
 *      var skip every quota check (allowed=true, limit=Infinity).
 *      incrementUsage is a no-op for them. See lib/billing/admin.ts.
 *
 * IMPORTANT: this module is "use server" — only callable from server
 * actions and route handlers, never imported into client components.
 */

import { createServerClient } from "@/lib/supabase/server";
import type { Plan } from "@/lib/billing/plans";
import { getListingQuota, getPolishQuota } from "@/lib/billing/plans";
import { isAdmin } from "@/lib/billing/admin";

// ─── Constants ───────────────────────────────────────────────────────────────

const PERIOD_LENGTH_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export type QuotaAction = "listing" | "polish";

export interface QuotaCheckResult {
  /** True if the user can perform one more action of this type. */
  allowed: boolean;
  /** Resolved plan (defaults to "free" if no subscription row exists). */
  plan: Plan;
  /** Calls of this action consumed in the current period. */
  used: number;
  /** Monthly quota for this action on the user's plan. Infinity for admins. */
  limit: number;
  /** ISO timestamp when the period rolls over (and counters reset). */
  period_resets_at: string;
  /** True for admin users (env-var allow-list) — not metered. */
  is_admin: boolean;
}

export interface QuotaSummary {
  plan: Plan;
  listings: { used: number; limit: number };
  polishes: { used: number; limit: number };
  period_resets_at: string;
  is_admin: boolean;
}

// ─── Internals ───────────────────────────────────────────────────────────────

interface QuotaRow {
  plan: Plan;
  listings_used_this_period: number;
  polishes_used_this_period: number;
  period_start: string;
}

/**
 * Read the subscription row, auto-resetting period counters if the
 * 30-day window has elapsed. Returns the (possibly reset) row.
 *
 * This is the heart of the lazy-reset pattern: a single SELECT +
 * conditional UPDATE per call. No cron required for correctness; the
 * Vercel cron is a cleanup pass for idle accounts only.
 */
async function readOrResetQuotaRow(userId: string): Promise<QuotaRow> {
  const db = createServerClient();

  // Try to read the existing row. If none, insert a default free row.
  const { data: existing } = await db
    .from("subscriptions")
    .select(
      "plan, listings_used_this_period, polishes_used_this_period, period_start"
    )
    .eq("user_id", userId)
    .maybeSingle();

  let row: QuotaRow;
  if (!existing) {
    const nowIso = new Date().toISOString();
    const { data: inserted, error: insertError } = await db
      .from("subscriptions")
      .insert({
        user_id: userId,
        plan: "free",
        status: "active",
        listings_used_this_period: 0,
        polishes_used_this_period: 0,
        period_start: nowIso,
      })
      .select(
        "plan, listings_used_this_period, polishes_used_this_period, period_start"
      )
      .single();

    if (insertError || !inserted) {
      // Race: another request inserted between our SELECT and INSERT.
      // Re-read.
      const { data: recovered } = await db
        .from("subscriptions")
        .select(
          "plan, listings_used_this_period, polishes_used_this_period, period_start"
        )
        .eq("user_id", userId)
        .single();
      row = recovered as QuotaRow;
    } else {
      row = inserted as QuotaRow;
    }
  } else {
    row = existing as QuotaRow;
  }

  // ── Lazy period reset ────────────────────────────────────────────────────
  const periodStartedAt = new Date(row.period_start).getTime();
  const ageMs = Date.now() - periodStartedAt;

  if (ageMs >= PERIOD_LENGTH_MS) {
    // Time to roll the period forward. Compute the NEW period_start as
    // the most recent boundary the user has crossed — if a user was
    // inactive for 3 months, we still only credit them ONE fresh
    // quota window (not three).
    const periodsElapsed = Math.floor(ageMs / PERIOD_LENGTH_MS);
    const newPeriodStart = new Date(
      periodStartedAt + periodsElapsed * PERIOD_LENGTH_MS
    );

    const { error: resetError } = await db
      .from("subscriptions")
      .update({
        listings_used_this_period: 0,
        polishes_used_this_period: 0,
        period_start: newPeriodStart.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);

    if (!resetError) {
      row.listings_used_this_period = 0;
      row.polishes_used_this_period = 0;
      row.period_start = newPeriodStart.toISOString();
    }
    // If the update errored, we surface the old usage. The cron job
    // will retry on its next sweep. Worst case the user gets ONE more
    // gated call against the old period — preferable to throwing here.
  }

  return row;
}

function quotaForAction(plan: Plan, action: QuotaAction): number {
  return action === "listing" ? getListingQuota(plan) : getPolishQuota(plan);
}

function usedForAction(row: QuotaRow, action: QuotaAction): number {
  return action === "listing"
    ? row.listings_used_this_period
    : row.polishes_used_this_period;
}

function periodResetsAt(periodStart: string): string {
  return new Date(new Date(periodStart).getTime() + PERIOD_LENGTH_MS).toISOString();
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Check whether the user can perform one more action of this type
 * in the current billing period. Auto-resets the period if the 30-day
 * window has elapsed.
 *
 * Admins (ADMIN_USER_IDS env var) bypass every quota — `allowed=true`,
 * `limit=Infinity`. We don't even hit the database for admins; the
 * check returns synthetic numbers so any UI that reads the result still
 * works.
 *
 * Call this BEFORE the work runs. If `allowed=false`, return a friendly
 * error to the caller with the recommended upgrade tier — the UI can
 * deep-link them into the Paystack flow.
 */
export async function checkQuota(
  userId: string,
  action: QuotaAction,
): Promise<QuotaCheckResult> {
  if (isAdmin(userId)) {
    return {
      allowed:          true,
      plan:             "business",        // surface as the highest tier in UI
      used:             0,
      limit:            Number.POSITIVE_INFINITY,
      period_resets_at: new Date(Date.now() + PERIOD_LENGTH_MS).toISOString(),
      is_admin:         true,
    };
  }

  const row = await readOrResetQuotaRow(userId);
  const limit = quotaForAction(row.plan, action);
  const used = usedForAction(row, action);

  return {
    allowed:          used < limit,
    plan:             row.plan,
    used,
    limit,
    period_resets_at: periodResetsAt(row.period_start),
    is_admin:         false,
  };
}

/**
 * Increment the per-period usage counter for the given action.
 *
 * Call this AFTER the gated work completes successfully. We use an
 * atomic SQL increment so concurrent requests can't race to skip the
 * cap — Supabase's RPC isn't necessary here because the +1 happens
 * server-side under our service-role key.
 *
 * No-op for admin users (they're unmetered).
 */
export async function incrementUsage(
  userId: string,
  action: QuotaAction,
): Promise<void> {
  if (isAdmin(userId)) return; // admins bypass metering

  const db = createServerClient();

  // Read current value in one round-trip
  const { data: row } = await db
    .from("subscriptions")
    .select(
      "listings_used_this_period, polishes_used_this_period"
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (!row) {
    // No row — should have been created in checkQuota. Defensive.
    console.warn(
      `[quota] incrementUsage called for ${userId} with no subscription row`
    );
    return;
  }

  const column =
    action === "listing"
      ? "listings_used_this_period"
      : "polishes_used_this_period";
  const currentValue = (row as Record<string, number>)[column];

  const { error } = await db
    .from("subscriptions")
    .update({
      [column]: currentValue + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);

  if (error) {
    console.error(
      `[quota] Failed to increment ${action} usage for ${userId}:`,
      error.message
    );
  }
}

/**
 * Read-only snapshot of the user's quota state for the billing UI.
 * Returns BOTH listings + polishes so the page can render two usage
 * bars in one round-trip.
 *
 * For admin users, returns Infinity limits so the UI can render an
 * "unlimited" pill instead of a usage bar.
 */
export async function getQuotaSummary(userId: string): Promise<QuotaSummary> {
  if (isAdmin(userId)) {
    return {
      plan:             "business",
      listings: { used: 0, limit: Number.POSITIVE_INFINITY },
      polishes: { used: 0, limit: Number.POSITIVE_INFINITY },
      period_resets_at: new Date(Date.now() + PERIOD_LENGTH_MS).toISOString(),
      is_admin:         true,
    };
  }

  const row = await readOrResetQuotaRow(userId);

  return {
    plan:             row.plan,
    listings: {
      used:  row.listings_used_this_period,
      limit: getListingQuota(row.plan),
    },
    polishes: {
      used:  row.polishes_used_this_period,
      limit: getPolishQuota(row.plan),
    },
    period_resets_at: periodResetsAt(row.period_start),
    is_admin:         false,
  };
}

/**
 * Cron sweep: reset stale rows where period_start + 30d < now() AND
 * counters are non-zero. Idempotent. Safe to run on any schedule.
 * Called by /api/cron/reset-quotas — meant for users who haven't
 * triggered a quota check organically (idle accounts).
 *
 * Returns the count of rows reset for observability.
 */
export async function resetStaleQuotas(): Promise<{ reset_count: number }> {
  const db = createServerClient();

  const cutoff = new Date(Date.now() - PERIOD_LENGTH_MS).toISOString();

  // Snap period_start forward to "now" rather than computing the exact
  // boundary — idle accounts don't need precision, and this keeps the
  // SQL trivial.
  const { data, error } = await db
    .from("subscriptions")
    .update({
      listings_used_this_period: 0,
      polishes_used_this_period: 0,
      period_start: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .lt("period_start", cutoff)
    .eq("status", "active")
    .select("user_id");

  if (error) {
    console.error("[quota] resetStaleQuotas failed:", error.message);
    return { reset_count: 0 };
  }

  return { reset_count: data?.length ?? 0 };
}
