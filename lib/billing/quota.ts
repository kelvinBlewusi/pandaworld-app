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
import type { Plan, SubStatus } from "@/lib/billing/plans";
import { getListingQuota, getPolishQuota } from "@/lib/billing/plans";
import { isAdmin } from "@/lib/billing/admin";
import { FREE_FOR_ALL_MODE } from "@/lib/billing/free-for-all";

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
  /**
   * True for admin users (env-var allow-list) — not metered. Also true
   * for every user while FREE_FOR_ALL_MODE (lib/billing/free-for-all.ts)
   * is on, so the existing "Unlimited usage" UI banner this flag drives
   * shows for everyone during that growth phase, not just staff.
   */
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
  status: SubStatus;
  /**
   * When the current paid billing period ends (set by /verify and the
   * Paystack webhook on every charge.success). NULL for free users
   * who never paid, or for legacy rows that pre-date this column.
   */
  current_period_end: string | null;
  listings_used_this_period: number;
  polishes_used_this_period: number;
  period_start: string;
}

/**
 * Compute the EFFECTIVE plan — what the user should be treated as
 * RIGHT NOW, regardless of what's stored in the `plan` column.
 *
 * A paid plan auto-expires to free when:
 *   - status is "expired"                                   (cron flipped it)
 *   - status is "cancelled" AND current_period_end < now()  (cancel-and-wait flow)
 *   - status is "active" AND current_period_end < now()     (one-time Page
 *     payment that wasn't renewed — common with non-recurring Pages)
 *
 * This is the LAZY enforcement path. The Vercel cron
 * (/api/cron/reset-quotas → expireOverduePlans) is the EAGER backup
 * that flips the actual DB row to plan="free", status="expired" so
 * admin queries against Supabase show the right state too.
 *
 * Free + admin users are unaffected — they never go through expiry.
 */
function getEffectivePlan(row: QuotaRow): Plan {
  if (row.plan === "free") return "free";

  if (row.status === "expired") return "free";

  if (row.current_period_end) {
    const expiredAt = new Date(row.current_period_end).getTime();
    if (Date.now() > expiredAt) {
      return "free";
    }
  }

  // Paid plan, status active (or cancelled but still within paid period)
  return row.plan;
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

  // SELECT shape is shared between the read, recover-from-race, and
  // initial-insert paths — keep them aligned. status + current_period_end
  // are needed so getEffectivePlan() can decide if a paid plan has
  // already expired without paying for a separate round-trip.
  const COLUMNS =
    "plan, status, current_period_end, listings_used_this_period, polishes_used_this_period, period_start";

  // Try to read the existing row. If none, insert a default free row.
  const { data: existing } = await db
    .from("subscriptions")
    .select(COLUMNS)
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
      .select(COLUMNS)
      .single();

    if (insertError || !inserted) {
      // Race: another request inserted between our SELECT and INSERT.
      // Re-read.
      const { data: recovered } = await db
        .from("subscriptions")
        .select(COLUMNS)
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
  if (FREE_FOR_ALL_MODE || isAdmin(userId)) {
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

  // Effective plan = what the user should be treated as RIGHT NOW.
  // Auto-expires paid plans to "free" when current_period_end has
  // passed (one-time Page payments, cancelled subscriptions whose
  // grace period is up, status="expired" rows the cron flipped).
  // See getEffectivePlan() for the full rule set.
  const effectivePlan = getEffectivePlan(row);
  const limit = quotaForAction(effectivePlan, action);
  // Cap the displayed usage at the limit so a Pro user who used 80/100
  // and just downgraded to Free doesn't see 80/5 — they see 5/5.
  const usedRaw = usedForAction(row, action);
  const used = Number.isFinite(limit) ? Math.min(usedRaw, limit) : usedRaw;

  return {
    allowed:          used < limit,
    plan:             effectivePlan,
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
  if (FREE_FOR_ALL_MODE || isAdmin(userId)) return; // unmetered

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
 * Decrement the per-period usage counter for the given action (i.e.
 * refund a quota credit). Called from `deleteListing()` when the user
 * deletes a draft that was never submitted to Jumia — see the listings
 * action for the status-based eligibility check.
 *
 * Floors at 0 so an out-of-sync state (deleting more rows than were
 * counted against the current period) can't produce a negative usage
 * value that breaks the UI.
 *
 * No-op for admin users (they're unmetered).
 */
export async function decrementUsage(
  userId: string,
  action: QuotaAction,
): Promise<void> {
  if (FREE_FOR_ALL_MODE || isAdmin(userId)) return; // unmetered

  const db = createServerClient();

  const { data: row } = await db
    .from("subscriptions")
    .select(
      "listings_used_this_period, polishes_used_this_period"
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (!row) {
    // No row to refund against. Silent — happens if the seller is brand
    // new and their subscription row hasn't been provisioned yet
    // (shouldn't happen, but no need to warn).
    return;
  }

  const column =
    action === "listing"
      ? "listings_used_this_period"
      : "polishes_used_this_period";
  const currentValue = (row as Record<string, number>)[column];
  // Math.max(0, …) prevents the counter ever dipping below zero — keeps
  // the usage bar UI honest even if the seller deletes drafts faster
  // than we increment.
  const newValue = Math.max(0, currentValue - 1);

  if (newValue === currentValue) return; // already at 0; nothing to do

  const { error } = await db
    .from("subscriptions")
    .update({
      [column]: newValue,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);

  if (error) {
    console.error(
      `[quota] Failed to decrement ${action} usage for ${userId}:`,
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
  if (FREE_FOR_ALL_MODE || isAdmin(userId)) {
    return {
      plan:             "business",
      listings: { used: 0, limit: Number.POSITIVE_INFINITY },
      polishes: { used: 0, limit: Number.POSITIVE_INFINITY },
      period_resets_at: new Date(Date.now() + PERIOD_LENGTH_MS).toISOString(),
      is_admin:         true,
    };
  }

  const row = await readOrResetQuotaRow(userId);

  // Effective plan = what the user is RIGHT NOW. Auto-expires paid
  // plans to free when current_period_end has passed. See
  // getEffectivePlan() for the rules.
  const effectivePlan = getEffectivePlan(row);
  const listingLimit  = getListingQuota(effectivePlan);
  const polishLimit   = getPolishQuota(effectivePlan);

  // Cap displayed usage at the limit so a Pro user who used 80/100
  // and just downgraded to Free doesn't see 80/5 — they see 5/5.
  const cap = (n: number, lim: number) =>
    Number.isFinite(lim) ? Math.min(n, lim) : n;

  return {
    plan:             effectivePlan,
    listings: {
      used:  cap(row.listings_used_this_period, listingLimit),
      limit: listingLimit,
    },
    polishes: {
      used:  cap(row.polishes_used_this_period, polishLimit),
      limit: polishLimit,
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

/**
 * Cron sweep: expire paid plans whose current_period_end has passed.
 * Idempotent. Called by /api/cron/reset-quotas alongside
 * resetStaleQuotas.
 *
 * What it does — finds rows where ALL of these hold:
 *   1. plan != 'free'                (the row claims a paid tier)
 *   2. current_period_end < now()    (the paid period is over)
 *   3. status != 'expired'           (we haven't already flipped it)
 *
 * …and flips them to:
 *   plan = 'free'
 *   status = 'expired'
 *   listings_used_this_period = 0  (fresh free quota)
 *   polishes_used_this_period = 0
 *   period_start = now()           (start a new free window today)
 *
 * Why this is needed alongside the lazy expiry in getEffectivePlan():
 *   - Lazy expiry is for correctness AT REQUEST TIME — every quota
 *     check returns the right limits regardless of what's in the row.
 *   - Cron expiry is for HYGIENE — keeps the actual DB column accurate
 *     so anyone querying Supabase directly sees the truth, and so the
 *     UI's plan badge (which reads `subscriptions.plan` via
 *     getSubscription()) shows "Free" instead of a stale "Pro".
 *
 * Returns the count of rows expired for observability.
 */
export async function expireOverduePlans(): Promise<{ expired_count: number }> {
  const db = createServerClient();

  const nowIso = new Date().toISOString();

  const { data, error } = await db
    .from("subscriptions")
    .update({
      plan:                       "free",
      status:                     "expired",
      listings_used_this_period:  0,
      polishes_used_this_period:  0,
      period_start:               nowIso,
      updated_at:                 nowIso,
    })
    // Has a defined expiry that's already in the past
    .lt("current_period_end", nowIso)
    // Currently on a paid tier (free rows have nothing to expire)
    .neq("plan", "free")
    // Haven't already been flipped (idempotency)
    .neq("status", "expired")
    .select("user_id, plan");

  if (error) {
    console.error("[quota] expireOverduePlans failed:", error.message);
    return { expired_count: 0 };
  }

  if (data && data.length > 0) {
    // Log which users were downgraded so we can spot patterns
    // (e.g. lots of expiries on the same day → renewal email job
    // broke last week).
    console.info(
      `[quota] expireOverduePlans: downgraded ${data.length} user(s) to free: ` +
        data.map((r) => `${r.user_id} (was ${r.plan})`).join(", "),
    );
  }

  return { expired_count: data?.length ?? 0 };
}
