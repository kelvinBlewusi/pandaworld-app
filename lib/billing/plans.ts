/**
 * Central plan configuration — the single source of truth for tier
 * names, prices, monthly quotas, Paystack plan codes, and feature
 * bullets.
 *
 * Imported by:
 *   - app/pricing/page.tsx (public marketing page)
 *   - app/(main)/settings/billing/page.tsx (logged-in billing settings)
 *   - app/api/paystack/initialize/route.ts (route to correct plan code)
 *   - lib/billing/quota.ts (read monthly quota limits)
 *
 * Why centralised: today the price + quotas are duplicated across
 * three files. Any change requires editing all three; they drift.
 * One file, one source of truth, every prompt site reads from here.
 *
 * Updating a plan:
 *   - Change the GHS price in `price_ghs_pesewas` (Paystack uses the
 *     smallest currency unit, so GHS 30 = 3000 pesewas).
 *   - Bump the quota numbers in `monthly_listings` / `monthly_polishes`.
 *   - If the Paystack plan code changes (e.g. you create a new
 *     recurring plan after a price change), update the matching
 *     `paystack_plan_code` env-var name in the route handler.
 */

// ─── Plan types ──────────────────────────────────────────────────────────────

export type Plan =
  | "free"        // 5 listings / month, no image polish
  | "starter"     // GHS 30 / month — 30 listings, 10 polishes
  | "pro"         // GHS 65 / month — 100 listings, 30 polishes
  | "business";   // GHS 120 / month — 500 listings (fair-use), 150 polishes

// Note: there is intentionally no "legacy" tier here. Admins (devs / staff)
// get unlimited usage via lib/billing/admin.ts (env-var-based list) — not
// via a database plan, so we never need to grandfather anyone in the schema.

export type SubStatus = "active" | "cancelled" | "expired";

export interface PlanConfig {
  /** Stable internal id used as DB enum + tier query string. */
  id: Plan;
  /** Human-readable tier name (Title Case). */
  name: string;
  /** Price in Paystack's smallest unit (GHS pesewas). 0 for free tiers. */
  price_ghs_pesewas: number;
  /** Pretty price label for UI, including currency prefix. */
  display_price: string;
  /** Billing period descriptor. "lifetime" for free/legacy. */
  period: "month" | "lifetime";
  /**
   * Monthly listing-analysis quota. `Number.POSITIVE_INFINITY` for
   * legacy Pro who get unlimited as a grandfather perk.
   */
  monthly_listings: number;
  /** Monthly image-polish quota (PhotoRoom + Gemini image-gen combined). */
  monthly_polishes: number;
  /**
   * Env-var name (not the value!) that holds the Paystack Payment Page
   * URL for this tier (e.g. "https://paystack.com/pay/pandaworld-starter").
   *
   * Why a Page URL and not a plan_code: switched in May 2026 from the
   * API-driven /transaction/initialize flow (which required Plan codes)
   * to Paystack-hosted Payment Pages. The Page URL is what the seller's
   * browser redirects to — Paystack hosts the entire checkout UI on
   * their domain. Our /api/paystack/initialize just builds the right
   * URL with metadata (user_id + tier) appended as query params; no
   * API call to Paystack is made on the initialise side.
   *
   * null for free (nothing to charge).
   */
  paystack_page_url_env: string | null;
  /** Bullet list rendered on plan cards. */
  features: string[];
  /** Pinned badge for the recommended tier. */
  badge?: "Most popular" | "Best value";
  /** One-line description shown under the tier name. */
  description: string;
  /**
   * Hide from the public pricing page. Currently unused (all four
   * tiers are public) — kept on the type so a future internal/promo
   * tier can be added without re-touching every consumer.
   */
  hidden_from_pricing?: boolean;
  /** Order shown on the pricing page (low → high). */
  sort_order: number;
}

// ─── Plan definitions ────────────────────────────────────────────────────────
//
// Numbers below are the May 2026 launch values. If you want to A/B
// test pricing later, this is the only file that needs changing for
// the user-facing copy + Paystack plan-code routing.

export const PLANS: Record<Plan, PlanConfig> = {
  free: {
    id:                     "free",
    name:                   "Free",
    price_ghs_pesewas:      0,
    display_price:          "GHS 0",
    period:                 "month",
    monthly_listings:       5,
    monthly_polishes:       0,
    paystack_page_url_env: null,
    features: [
      "5 product uploads / month",
      "AI listing generation",
      "Jumia export (.xlsx)",
      "Price calculator",
      "Email support",
    ],
    description:            "Try it out",
    sort_order:             0,
  },

  starter: {
    id:                     "starter",
    name:                   "Starter",
    price_ghs_pesewas:      3000,                  // GHS 30
    display_price:          "GHS 30",
    period:                 "month",
    monthly_listings:       30,
    monthly_polishes:       10,
    paystack_page_url_env: "PAYSTACK_STARTER_PAGE_URL",
    features: [
      "30 product uploads / month",
      "10 image polishes / month",
      "AI listing generation",
      "Jumia export (.xlsx)",
      "Email support",
    ],
    description:            "Casual sellers, 10–20 listings/mo",
    sort_order:             1,
  },

  pro: {
    id:                     "pro",
    name:                   "Pro",
    price_ghs_pesewas:      6500,                  // GHS 65
    display_price:          "GHS 65",
    period:                 "month",
    monthly_listings:       100,
    monthly_polishes:       30,
    paystack_page_url_env: "PAYSTACK_PRO_PAGE_URL",
    features: [
      "100 product uploads / month",
      "30 image polishes / month",
      "Bulk push to Jumia",
      "Priority support",
      "Early access to new features",
    ],
    badge:                  "Most popular",
    description:            "Serious sellers, 30+ listings/mo",
    sort_order:             2,
  },

  business: {
    id:                     "business",
    name:                   "Business",
    price_ghs_pesewas:      12000,                 // GHS 120
    display_price:          "GHS 120",
    period:                 "month",
    monthly_listings:       500,                   // fair-use cap
    monthly_polishes:       150,
    paystack_page_url_env: "PAYSTACK_BUSINESS_PAGE_URL",
    features: [
      "500 product uploads / month (fair-use)",
      "150 image polishes / month",
      "Bulk push to Jumia",
      "Advanced analytics",
      "Priority support (Slack/WhatsApp)",
      "Early access to new features",
    ],
    badge:                  "Best value",
    description:            "Resellers and high-volume stores",
    sort_order:             3,
  },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/** True if the plan grants paid features. Free is the only non-paid plan. */
export function isPaidPlan(plan: Plan): boolean {
  return plan !== "free";
}

/** True if the plan should appear on the public /pricing page. */
export function isPublicPlan(plan: Plan): boolean {
  return !PLANS[plan].hidden_from_pricing;
}

/** All public plans in display order. Use this on /pricing + billing UI. */
export function getPublicPlans(): PlanConfig[] {
  return Object.values(PLANS)
    .filter((p) => isPublicPlan(p.id))
    .sort((a, b) => a.sort_order - b.sort_order);
}

/**
 * Returns the Paystack Payment Page URL for a tier by reading the env var.
 * Used by /api/paystack/initialize to redirect the seller's browser to
 * the Paystack-hosted checkout page. Returns null for free (nothing to
 * charge) or when the env var isn't configured yet.
 */
export function getPaystackPageUrl(plan: Plan): string | null {
  const envName = PLANS[plan].paystack_page_url_env;
  if (!envName) return null;
  const value = process.env[envName];
  if (!value || value.trim().length === 0) return null;
  return value.trim();
}

/**
 * Monthly quota lookups. Centralised here so the quota engine and the
 * UI both ask the same source.
 */
export function getListingQuota(plan: Plan): number {
  return PLANS[plan].monthly_listings;
}

export function getPolishQuota(plan: Plan): number {
  return PLANS[plan].monthly_polishes;
}

/**
 * Suggested next-tier upgrade when a user hits their quota. Returns
 * the natural step-up: Free → Starter → Pro → Business. Business stays
 * (no higher tier to offer).
 */
export function getNextTierUpgrade(plan: Plan): Plan | null {
  switch (plan) {
    case "free":     return "starter";
    case "starter":  return "pro";
    case "pro":      return "business";
    case "business": return null;
  }
}

/**
 * Find the tier whose price matches the given amount (in GHS pesewas).
 * Returns null if no paid tier matches.
 *
 * Used by /api/paystack/verify + /api/paystack/webhook as the most
 * reliable tier resolution path — Paystack always passes back the
 * actual amount charged via tx.amount, regardless of whether
 * metadata or reference round-tripped. The seller paid for what
 * they paid for, not what they intended.
 *
 * Each Payment Page has a fixed amount tied to one tier:
 *   GHS 30  → starter
 *   GHS 65  → pro
 *   GHS 120 → business
 *
 * If a Page were configured for custom amounts, the matcher could
 * return null on an unexpected amount — caller should fall back to
 * metadata / reference / sensible default in that case.
 */
export function findTierByAmount(amountInPesewas: number): Plan | null {
  if (typeof amountInPesewas !== "number" || !Number.isFinite(amountInPesewas)) {
    return null;
  }
  const match = Object.values(PLANS).find(
    (p) => isPaidPlan(p.id) && p.price_ghs_pesewas === amountInPesewas
  );
  return match?.id ?? null;
}
