// ─── Subscription types (no "use server" — safe to import anywhere) ────────
//
// Plan + SubStatus + helpers live in lib/billing/plans.ts now — this file
// is the database-row type for the `subscriptions` table and re-exports
// the Plan union so existing imports of `@/lib/types/subscription` keep
// working without churning every callsite.
//
// If you're adding new fields to the subscriptions table, update the
// SQL migration (supabase/migrations/<date>_*.sql) AND this interface.

import type { Plan, SubStatus } from "@/lib/billing/plans";
export type { Plan, SubStatus };

export interface Subscription {
  /** Internal tier id. See lib/billing/plans.ts for the mapping. */
  plan: Plan;
  /** Active / cancelled / expired — drives "is this user paid?" checks. */
  status: SubStatus;

  // ── Monthly quota tracking ────────────────────────────────────────────────
  // Reset to 0 by lib/billing/quota.ts when now() > period_start + 30 days.
  // Period_start gets bumped forward at the same time.
  //
  // Admin bypass (unlimited usage for dev/staff accounts) lives in
  // lib/billing/admin.ts — an env-var-based allow-list. No DB flag for
  // admin status because privileged access shouldn't live in a table
  // a compromised service-role key could rewrite.
  listings_used_this_period: number;
  polishes_used_this_period: number;
  period_start: string; // ISO timestamp

  // ── Paystack handles ─────────────────────────────────────────────────────
  paystack_subscription_code: string | null;
  paystack_email_token: string | null;
  current_period_end: string | null;

  created_at: string;
}
