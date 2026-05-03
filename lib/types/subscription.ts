// ─── Subscription types & constants (no "use server" — safe to import anywhere)

export type Plan = "free" | "pro";
export type SubStatus = "active" | "cancelled" | "expired";

export interface Subscription {
  plan: Plan;
  status: SubStatus;
  listing_count: number;
  paystack_subscription_code: string | null;
  paystack_email_token: string | null;
  current_period_end: string | null;
  created_at: string;
}

export const PLAN_LIMITS: Record<Plan, number> = {
  free: 5,
  pro: Infinity,
};
