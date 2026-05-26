import {
  Sparkles,
  Zap,
  Rocket,
  Briefcase,
  Crown,
  type LucideIcon,
} from "lucide-react";
import type { Plan } from "@/lib/billing/plans";
import { cn } from "@/lib/utils";

/**
 * Reusable plan badge — small coloured pill showing the seller's
 * current tier. Used in the sidebar UserChip and the Settings →
 * Account profile section.
 *
 * Two important behaviours:
 *
 *  1. Admin override — if `isAdmin` is true, the badge shows
 *     "Admin · Unlimited" with a Crown icon, regardless of what
 *     plan was passed. Admins are unmetered by env-var allowlist
 *     (see lib/billing/admin.ts).
 *
 *  2. Effective-plan only — the consumer is responsible for
 *     resolving the EFFECTIVE plan before passing it in. Don't
 *     pass `sub.plan` directly (that's the stored plan, which can
 *     be stale until the cron downgrades expired rows). Read
 *     `quota.plan` from `getQuotaSummary()` instead — that already
 *     auto-expires past-due paid plans to "free".
 *
 * Sizes:
 *   - xs: tiny — for the sidebar UserChip
 *   - sm: comfortable — for the profile header
 */

interface PlanBadgeProps {
  plan: Plan;
  /** True if the seller is in ADMIN_USER_IDS — overrides plan display. */
  isAdmin?: boolean;
  /** Visual scale. Default "sm". */
  size?: "xs" | "sm";
  /** Optional extra Tailwind classes. */
  className?: string;
}

interface BadgeStyle {
  Icon:  LucideIcon;
  bg:    string;
  text:  string;
  label: string;
}

// Tier → visual config. Match the icons used on the billing page
// so the colour story is consistent (Starter = emerald, Pro = blue,
// Business = purple, Free = neutral zinc).
const PLAN_STYLES: Record<Plan, BadgeStyle> = {
  free: {
    Icon:  Sparkles,
    bg:    "bg-zinc-100",
    text:  "text-zinc-600",
    label: "Free plan",
  },
  starter: {
    Icon:  Zap,
    bg:    "bg-emerald-50",
    text:  "text-emerald-600",
    label: "Starter plan",
  },
  pro: {
    Icon:  Rocket,
    bg:    "bg-blue-50",
    text:  "text-blue-600",
    label: "Pro plan",
  },
  business: {
    Icon:  Briefcase,
    bg:    "bg-purple-50",
    text:  "text-purple-600",
    label: "Business plan",
  },
};

// Admin gets its own gold styling — same Crown icon as the billing-page
// admin banner so sellers recognise the visual.
const ADMIN_STYLE: BadgeStyle = {
  Icon:  Crown,
  bg:    "bg-amber-50",
  text:  "text-amber-600",
  label: "Admin · Unlimited",
};

export function PlanBadge({
  plan,
  isAdmin = false,
  size = "sm",
  className,
}: PlanBadgeProps) {
  const style = isAdmin ? ADMIN_STYLE : PLAN_STYLES[plan];

  // Size tokens. xs is for cramped contexts (sidebar). sm is the default.
  const px   = size === "xs" ? "px-1.5" : "px-2";
  const py   = size === "xs" ? "py-0.5" : "py-0.5";
  const text = size === "xs" ? "text-[10px]" : "text-[11px]";
  const icon = size === "xs" ? "h-2.5 w-2.5" : "h-2.5 w-2.5";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full font-semibold",
        style.bg,
        style.text,
        px,
        py,
        text,
        className,
      )}
    >
      <style.Icon className={icon} />
      {style.label}
    </span>
  );
}
