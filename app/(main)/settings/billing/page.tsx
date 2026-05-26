"use client";

import { useState, useEffect, useTransition, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  Check,
  Sparkles,
  Zap,
  Rocket,
  Briefcase,
  Loader2,
  AlertCircle,
  CalendarDays,
  CreditCard,
  Crown,
  Lock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
  getSubscription,
  cancelSubscription,
  getQuotaSummaryForCurrentUser,
} from "@/lib/actions/subscription";
import type { Subscription } from "@/lib/types/subscription";
import type { QuotaSummary } from "@/lib/billing/quota";
import { PLANS, getPublicPlans, type Plan, type PlanConfig } from "@/lib/billing/plans";
import { NotificationToast, type ToastInput } from "@/components/ui/notification-toast";

// ─── Icon mapping ────────────────────────────────────────────────────────────
// React-only — kept out of lib/billing/plans.ts so the plan module
// stays clean of UI dependencies. Order maps to the central plan ids.

const PLAN_ICON: Record<Plan, { Icon: React.ElementType; iconBg: string; iconColor: string }> = {
  free:     { Icon: Sparkles,  iconBg: "bg-zinc-100",   iconColor: "text-zinc-500" },
  starter:  { Icon: Zap,       iconBg: "bg-emerald-50", iconColor: "text-emerald-500" },
  pro:      { Icon: Rocket,    iconBg: "bg-blue-50",    iconColor: "text-blue-500" },
  business: { Icon: Briefcase, iconBg: "bg-purple-50",  iconColor: "text-purple-500" },
};

// ─── Inner page (needs useSearchParams — must be inside Suspense) ─────────────

function BillingPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [sub, setSub] = useState<Subscription | null>(null);
  const [quota, setQuota] = useState<QuotaSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [upgradingTier, setUpgradingTier] = useState<Plan | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [cancelPending, startCancelTransition] = useTransition();
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [toast, setToast] = useState<ToastInput | null>(null);

  // ── Load subscription + quota on mount ─────────────────────────────────────
  useEffect(() => {
    async function load() {
      const [subData, quotaData] = await Promise.all([
        getSubscription(),
        getQuotaSummaryForCurrentUser(),
      ]);
      setSub(subData);
      setQuota(quotaData);
      setLoading(false);
    }
    load();
  }, []);

  // ── Handle Paystack redirect back ──────────────────────────────────────────
  useEffect(() => {
    const ref = searchParams.get("trxref") ?? searchParams.get("reference");
    if (!ref) return;

    setVerifying(true);
    fetch(`/api/paystack/verify?reference=${ref}`)
      .then((r) => r.json())
      .then(async (data) => {
        if (data.success) {
          const planName = PLANS[(data.plan as Plan) ?? "pro"]?.name ?? "your new plan";
          showToast({
            type:    "success",
            title:   `Welcome to ${planName}`,
            message: `Your plan has been activated. Quota is fresh for the new period.`,
          });
          const [updatedSub, updatedQuota] = await Promise.all([
            getSubscription(),
            getQuotaSummaryForCurrentUser(),
          ]);
          setSub(updatedSub);
          setQuota(updatedQuota);
          router.replace("/settings/billing");
        } else {
          showToast({
            type:    "error",
            title:   "Payment verification failed",
            message: data.error ?? "Unknown error",
          });
        }
      })
      .catch(() =>
        showToast({
          type:    "error",
          title:   "Could not verify payment",
          message: "Network error. Contact support if this persists.",
        })
      )
      .finally(() => setVerifying(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function showToast(toastInput: ToastInput) {
    setToast(toastInput);
    // NotificationToast handles its own auto-dismiss + slide-out;
    // we just clear the state when it tells us it's done.
  }

  // ── Initiate paid-plan upgrade (or tier switch) ────────────────────────────
  async function handleUpgrade(tier: Plan) {
    if (tier === "free") return; // not purchasable
    setUpgradingTier(tier);
    try {
      const res = await fetch(`/api/paystack/initialize?tier=${tier}`, {
        method: "POST",
      });
      const data = await res.json();
      if (data.authorization_url) {
        window.location.href = data.authorization_url;
      } else {
        showToast({
          type:    "error",
          title:   "Could not start payment",
          message: data.error ?? "Try again in a moment.",
        });
        setUpgradingTier(null);
      }
    } catch {
      showToast({
        type:    "error",
        title:   "Network error",
        message: "Check your connection and try again.",
      });
      setUpgradingTier(null);
    }
  }

  // ── Cancel subscription ────────────────────────────────────────────────────
  function handleCancel() {
    setCancelError(null);
    startCancelTransition(async () => {
      const result = await cancelSubscription();
      if (result.success) {
        setShowCancelConfirm(false);
        showToast({
          type:    "success",
          title:   "Subscription cancelled",
          message: "Paid features continue until the current period ends, then revert to Free.",
        });
        const updated = await getSubscription();
        setSub(updated);
      } else {
        setCancelError(result.error ?? "Cancellation failed");
      }
    });
  }

  const currentPlan: Plan = sub?.plan ?? "free";
  const isPaid = currentPlan !== "free" && sub?.status === "active";
  const isAdmin = quota?.is_admin === true;
  const publicTiers = getPublicPlans();

  if (loading || verifying) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
        <span className="ml-2 text-sm text-zinc-400">
          {verifying ? "Verifying payment…" : "Loading…"}
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-5xl">
      {/* macOS-style notification toast (with chime via Web Audio API).
          Sits absolutely-positioned top-right; auto-dismisses after 5s. */}
      {toast && (
        <NotificationToast toast={toast} onClose={() => setToast(null)} />
      )}

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-zinc-900">Plans & billing</h1>
        <p className="mt-1 text-sm text-zinc-500">
          {isAdmin ? (
            <>You have <span className="font-semibold text-zinc-800">admin access</span> — every quota is unlimited.</>
          ) : (
            <>
              You are on the{" "}
              <span className="font-semibold text-zinc-800">{PLANS[currentPlan].name}</span> plan.
              {!isPaid && " Upgrade any time to unlock more listings + image polish."}
            </>
          )}
        </p>
      </div>

      {/* Admin banner — bypass all quotas */}
      {isAdmin && (
        <div className="rounded-2xl border border-amber-200 bg-gradient-to-r from-amber-50 to-yellow-50 p-5 text-sm">
          <div className="flex items-start gap-3">
            <Crown className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
            <div>
              <p className="font-semibold text-amber-900">
                Admin account — unlimited usage
              </p>
              <p className="mt-1 text-amber-800/80">
                Your account is in the <code className="rounded bg-amber-100 px-1 py-0.5 text-[11px] font-mono text-amber-900">ADMIN_USER_IDS</code>{" "}
                allow-list. Listing creation, image polish, and AI rebuild
                run without any monthly cap. Billing pages still display so
                you can see what regular users see, but no payment is needed
                for your own account.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Usage bars — hidden for admins (unmetered) */}
      {!isAdmin && quota && (
        <div className="grid gap-4 sm:grid-cols-2">
          <UsageBar
            label="Product listings this month"
            used={quota.listings.used}
            limit={quota.listings.limit}
            resetsAt={quota.period_resets_at}
          />
          <UsageBar
            label="Image polishes this month"
            used={quota.polishes.used}
            limit={quota.polishes.limit}
            resetsAt={quota.period_resets_at}
          />
        </div>
      )}

      {/* Plan cards — 4 tiers, render from central config */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {publicTiers.map((plan) => {
          const isCurrent = currentPlan === plan.id;
          const iconConfig = PLAN_ICON[plan.id];
          return (
            <PlanCard
              key={plan.id}
              plan={plan}
              currentPlan={currentPlan}
              iconConfig={iconConfig}
              isCurrent={isCurrent}
              isPaid={isPaid}
              upgradingTier={upgradingTier}
              onUpgrade={handleUpgrade}
              onCancel={() => setShowCancelConfirm(true)}
              hasPaystackSubscription={!!sub?.paystack_subscription_code}
            />
          );
        })}
      </div>

      {/* Subscription details */}
      {isPaid && (
        <section className="rounded-2xl border bg-white p-6 shadow-sm space-y-4">
          <h2 className="text-sm font-semibold text-zinc-700 flex items-center gap-2">
            <CalendarDays className="h-4 w-4 text-zinc-400" />
            Subscription details
          </h2>
          <Separator />
          <div className="grid gap-3 sm:grid-cols-2 text-sm">
            <div>
              <p className="text-xs text-zinc-400">Plan</p>
              <p className="font-medium text-zinc-800 mt-0.5">
                {PLANS[currentPlan].name} — {PLANS[currentPlan].display_price} / month
              </p>
            </div>
            <div>
              <p className="text-xs text-zinc-400">Status</p>
              <p className="mt-0.5">
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-xs font-medium",
                    sub?.status === "active"
                      ? "bg-emerald-50 text-emerald-700"
                      : "bg-amber-50 text-amber-700"
                  )}
                >
                  {sub?.status === "active" ? "Active" : "Cancelled"}
                </span>
              </p>
            </div>
            {sub?.current_period_end && (
              <div>
                <p className="text-xs text-zinc-400">
                  {sub.status === "cancelled" ? "Access until" : "Next renewal"}
                </p>
                <p className="font-medium text-zinc-800 mt-0.5">
                  {new Date(sub.current_period_end).toLocaleDateString("en-GB", {
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                  })}
                </p>
              </div>
            )}
          </div>
          {sub?.status === "cancelled" && (
            <div className="rounded-lg bg-amber-50 border border-amber-100 p-3 text-xs text-amber-700">
              Your subscription is cancelled. You&apos;ll have paid access until
              the period ends, then revert to Free (5 listings / month).
            </div>
          )}
        </section>
      )}

      {/* Cancel confirmation modal */}
      {showCancelConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-md rounded-2xl border bg-white p-6 shadow-xl space-y-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-50">
                <AlertCircle className="h-5 w-5 text-red-500" />
              </div>
              <div>
                <p className="font-semibold text-zinc-900">Cancel subscription?</p>
                <p className="text-xs text-zinc-500">This will revert you to the Free plan.</p>
              </div>
            </div>
            <p className="text-sm text-zinc-600">
              You&apos;ll keep {PLANS[currentPlan].name} access until your current
              period ends. After that, you&apos;ll be limited to 5 product uploads
              per month.
            </p>
            {cancelError && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
                {cancelError}
              </p>
            )}
            <div className="flex gap-3">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => setShowCancelConfirm(false)}
                disabled={cancelPending}
              >
                Keep {PLANS[currentPlan].name}
              </Button>
              <Button
                variant="destructive"
                className="flex-1 gap-2"
                onClick={handleCancel}
                disabled={cancelPending}
              >
                {cancelPending && <Loader2 className="h-4 w-4 animate-spin" />}
                Yes, cancel
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Paystack badge */}
      <p className="text-center text-xs text-zinc-400">
        Payments are processed securely by{" "}
        <a
          href="https://paystack.com"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-zinc-600"
        >
          Paystack
        </a>
        . Subscriptions renew monthly and can be cancelled anytime.
      </p>
    </div>
  );
}

// ─── Reusable plan card ──────────────────────────────────────────────────────

interface PlanCardProps {
  plan: PlanConfig;
  /** The seller's current plan — used to compute the lock state for
      lower-tier cards (e.g. Pro user can't pick Starter). */
  currentPlan: Plan;
  iconConfig: { Icon: React.ElementType; iconBg: string; iconColor: string };
  isCurrent: boolean;
  isPaid: boolean;
  upgradingTier: Plan | null;
  onUpgrade: (tier: Plan) => void;
  onCancel: () => void;
  hasPaystackSubscription: boolean;
}

function PlanCard({
  plan,
  currentPlan,
  iconConfig,
  isCurrent,
  isPaid,
  upgradingTier,
  onUpgrade,
  onCancel,
  hasPaystackSubscription,
}: PlanCardProps) {
  const { Icon, iconBg, iconColor } = iconConfig;
  const isFree = plan.id === "free";

  // ── Lock logic ─────────────────────────────────────────────────────────
  // A paid plan card is LOCKED if the seller is currently on a higher
  // paid tier (e.g. Pro user sees Starter as locked). Free is exempt
  // from the lock — paid users see Free as "Cancel to downgrade"
  // because cancelling the subscription is the only way to step down.
  //
  // Rationale: paying for a lower tier mid-subscription is wasteful
  // (you already get more features at the current tier). To switch
  // down, sellers cancel + repurchase the lower tier next period.
  const currentSortOrder = PLANS[currentPlan].sort_order;
  const isLocked =
    !isFree &&
    !isCurrent &&
    isPaid &&
    plan.sort_order < currentSortOrder;

  // ── Design language ────────────────────────────────────────────────────
  // Per May 2026 redesign: match the macOS-style notification toast.
  // No more bright-blue ring on the "Most popular" card — every tier
  // gets equal visual weight so sellers don't feel funneled. Subtler
  // badges (text-only pills), softer borders, glass background.
  return (
    <div
      className={cn(
        "relative flex flex-col rounded-2xl border border-zinc-200/70 bg-white/95 p-5 shadow-sm transition-all duration-200",
        "[backdrop-filter:saturate(1.5)_blur(16px)]",
        // Hover lift — only when card is interactive (not current/locked)
        !isCurrent && !isLocked && "hover:shadow-md hover:border-zinc-300",
        // Lock state: dim but keep content readable
        isLocked && "opacity-55",
      )}
    >
      {/* Soft badges — text-only, neutral palette. No saturated blue
          ring, no shouting colors. Position varies by badge type. */}
      {plan.badge && !isLocked && !isCurrent && (
        <div className="absolute -top-2.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-zinc-200 bg-white px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-600 shadow-sm">
          {plan.badge}
        </div>
      )}
      {isCurrent && (
        <div className="absolute -top-2.5 right-3 flex items-center gap-1 whitespace-nowrap rounded-full bg-zinc-900 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white shadow-sm">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          Current
        </div>
      )}
      {isLocked && (
        <div className="absolute -top-2.5 left-1/2 flex -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500 shadow-sm">
          <Lock className="h-2.5 w-2.5" />
          Below your plan
        </div>
      )}

      {/* Header — icon + name + description */}
      <div className="mb-3 flex items-center gap-2.5">
        <div className={cn("flex h-9 w-9 items-center justify-center rounded-xl", iconBg)}>
          <Icon className={cn("h-4 w-4", iconColor)} />
        </div>
        <div>
          <p className="font-semibold text-zinc-900">{plan.name}</p>
          <p className="text-[10px] text-zinc-400">{plan.description}</p>
        </div>
      </div>

      {/* Price */}
      <div className="mb-4">
        <span className="text-2xl font-bold text-zinc-900">{plan.display_price}</span>
        <span className="text-xs text-zinc-400">
          {plan.period === "month" ? " / month" : " forever"}
        </span>
      </div>

      {/* Features */}
      <ul className="mb-5 flex-1 space-y-2">
        {plan.features.map((feat) => (
          <li key={feat} className="flex items-start gap-2 text-[11px] text-zinc-600">
            <Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" />
            {feat}
          </li>
        ))}
      </ul>

      {/* CTA — same neutral button across all paid tiers since no card
          is highlighted any more. Pinned at bottom via mt-auto. */}
      <div className="mt-auto pt-1">
      {isLocked ? (
        <Button
          variant="outline"
          disabled
          className="h-10 w-full cursor-not-allowed gap-1.5 border-zinc-200 text-sm text-zinc-400"
        >
          <Lock className="h-3.5 w-3.5" />
          Below your current plan
        </Button>
      ) : isFree ? (
        isPaid ? (
          <Button
            variant="outline"
            className="h-10 w-full border-amber-200 text-sm text-amber-700 hover:border-amber-300"
            onClick={onCancel}
            disabled={!hasPaystackSubscription}
          >
            Cancel to downgrade
          </Button>
        ) : (
          <Button variant="outline" disabled className="h-10 w-full cursor-default text-sm">
            Current plan
          </Button>
        )
      ) : isCurrent ? (
        hasPaystackSubscription ? (
          <Button
            variant="outline"
            className="h-10 w-full border-red-200 text-sm text-red-500 hover:border-red-300 hover:text-red-600"
            onClick={onCancel}
          >
            Cancel subscription
          </Button>
        ) : (
          <Button variant="outline" disabled className="h-10 w-full cursor-default text-sm">
            Active — renews manually
          </Button>
        )
      ) : (
        <Button
          variant="outline"
          className="h-10 w-full gap-2 border-zinc-300 text-sm font-medium hover:bg-zinc-900 hover:text-white hover:border-zinc-900"
          onClick={() => onUpgrade(plan.id)}
          disabled={upgradingTier !== null}
        >
          {upgradingTier === plan.id ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Redirecting…
            </>
          ) : (
            <>
              <CreditCard className="h-4 w-4" />
              {isPaid ? `Switch to ${plan.name}` : `Choose ${plan.name}`}
            </>
          )}
        </Button>
      )}
      </div>
    </div>
  );
}

// ─── Usage bar — one row per quota type ──────────────────────────────────────

function UsageBar({
  label,
  used,
  limit,
  resetsAt,
}: {
  label: string;
  used: number;
  limit: number;
  resetsAt: string;
}) {
  // Render an "unlimited" pill when the quota is effectively unbounded
  // (legacy Pro). isFinite(Infinity) === false.
  const unlimited = !Number.isFinite(limit);
  const usedPct = unlimited ? 0 : Math.min(100, (used / Math.max(1, limit)) * 100);
  const reset = new Date(resetsAt);

  return (
    <div className="rounded-2xl border bg-white p-5 shadow-sm space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-zinc-800">{label}</p>
          <p className="text-xs text-zinc-400">
            {unlimited
              ? `${used} used — unlimited on your plan`
              : `${used} of ${limit} used`}
          </p>
        </div>
        {!unlimited && used >= limit && (
          <span className="rounded-full bg-red-50 px-2.5 py-1 text-xs font-medium text-red-600">
            Limit reached
          </span>
        )}
      </div>
      {!unlimited && (
        <div className="h-2 w-full rounded-full bg-zinc-100 overflow-hidden">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              usedPct >= 100 ? "bg-red-500" : usedPct >= 80 ? "bg-amber-400" : "bg-emerald-500"
            )}
            style={{ width: `${usedPct}%` }}
          />
        </div>
      )}
      <p className="text-[10px] text-zinc-400">
        Resets {reset.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
      </p>
    </div>
  );
}

// ─── Wrap in Suspense (required for useSearchParams) ─────────────────────────

export default function BillingPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
        </div>
      }
    >
      <BillingPageInner />
    </Suspense>
  );
}
