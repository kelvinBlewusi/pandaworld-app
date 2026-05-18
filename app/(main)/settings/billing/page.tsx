"use client";

import { useState, useEffect, useTransition, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  Check,
  Zap,
  Sparkles,
  Loader2,
  AlertCircle,
  CalendarDays,
  X,
  CreditCard,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { getSubscription, cancelSubscription } from "@/lib/actions/subscription";
import type { Subscription } from "@/lib/types/subscription";

// ─── Plan definitions ─────────────────────────────────────────────────────────

const PLANS = [
  {
    id: "free" as const,
    name: "Free",
    price: "GHS 0",
    period: "forever",
    description: "Try it out",
    icon: Sparkles,
    iconBg: "bg-zinc-100",
    iconColor: "text-zinc-500",
    features: [
      "5 product uploads",
      "AI listing generation",
      "Jumia export (.xlsx)",
      "Price calculator",
      "Email support",
    ],
    limit: 5,
  },
  {
    id: "pro" as const,
    name: "Pro",
    price: "GHS 50",
    period: "/ month",
    description: "For serious sellers",
    icon: Zap,
    iconBg: "bg-blue-50",
    iconColor: "text-blue-500",
    badge: "Most popular",
    features: [
      "Unlimited product uploads",
      "AI listing generation",
      "Jumia export (.xlsx)",
      "Price calculator",
      "Priority support",
      "Early access to new features",
    ],
    limit: Infinity,
  },
];

// ─── Inner page (needs useSearchParams — must be inside Suspense) ─────────────

function BillingPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [sub, setSub] = useState<Subscription | null>(null);
  const [listingCount, setListingCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [upgrading, setUpgrading] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [cancelPending, startCancelTransition] = useTransition();
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [toast, setToast] = useState<{ type: "success" | "error"; msg: string } | null>(null);

  // ── Load subscription on mount ──────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      const [subData, countRes] = await Promise.all([
        getSubscription(),
        fetch("/api/paystack/listing-count").then((r) =>
          r.ok ? r.json() : { count: 0 }
        ),
      ]);
      setSub(subData);
      setListingCount(countRes.count ?? 0);
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
          showToast("success", "🎉 Welcome to Pro! Your plan has been upgraded.");
          // Reload subscription
          const updated = await getSubscription();
          setSub(updated);
          // Clean up URL
          router.replace("/settings/billing");
        } else {
          showToast("error", `Payment verification failed: ${data.error ?? "Unknown error"}`);
        }
      })
      .catch(() => showToast("error", "Could not verify payment. Contact support."))
      .finally(() => setVerifying(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function showToast(type: "success" | "error", msg: string) {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 5000);
  }

  // ── Upgrade to Pro ─────────────────────────────────────────────────────────
  async function handleUpgrade() {
    setUpgrading(true);
    try {
      const res = await fetch("/api/paystack/initialize", { method: "POST" });
      const data = await res.json();
      if (data.authorization_url) {
        window.location.href = data.authorization_url;
      } else {
        showToast("error", data.error ?? "Could not start payment. Try again.");
        setUpgrading(false);
      }
    } catch {
      showToast("error", "Network error. Please try again.");
      setUpgrading(false);
    }
  }

  // ── Cancel subscription ────────────────────────────────────────────────────
  function handleCancel() {
    setCancelError(null);
    startCancelTransition(async () => {
      const result = await cancelSubscription();
      if (result.success) {
        setShowCancelConfirm(false);
        showToast("success", "Subscription cancelled. Your Pro access continues until the period ends, then reverts to Free.");
        const updated = await getSubscription();
        setSub(updated);
      } else {
        setCancelError(result.error ?? "Cancellation failed");
      }
    });
  }

  const currentPlan = sub?.plan ?? "free";
  const isPro = currentPlan === "pro" && sub?.status === "active";
  const freePlan = PLANS[0];
  const usedPct = Math.min(100, (listingCount / freePlan.limit) * 100);

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
    <div className="space-y-8 max-w-3xl">
      {/* Toast */}
      {toast && (
        <div
          className={cn(
            "fixed top-4 right-4 z-50 flex items-center gap-3 rounded-xl border px-4 py-3 shadow-lg text-sm font-medium",
            toast.type === "success"
              ? "bg-emerald-50 border-emerald-200 text-emerald-800"
              : "bg-red-50 border-red-200 text-red-800"
          )}
        >
          {toast.type === "success" ? (
            <Check className="h-4 w-4 shrink-0" />
          ) : (
            <AlertCircle className="h-4 w-4 shrink-0" />
          )}
          {toast.msg}
          <button onClick={() => setToast(null)} className="ml-2 opacity-60 hover:opacity-100">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-zinc-900">Plans & billing</h1>
        <p className="mt-1 text-sm text-zinc-500">
          You are on the{" "}
          <span className="font-semibold text-zinc-800 capitalize">{currentPlan}</span> plan.
          {!isPro && " Upgrade to Pro to unlock unlimited uploads and priority support."}
        </p>
      </div>

      {/* Usage bar (free only) */}
      {!isPro && (
        <div className="rounded-2xl border bg-white p-5 shadow-sm space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-zinc-800">Free trial usage</p>
              <p className="text-xs text-zinc-400">
                {listingCount} of {freePlan.limit} products uploaded
              </p>
            </div>
            {listingCount >= freePlan.limit && (
              <span className="rounded-full bg-red-50 px-2.5 py-1 text-xs font-medium text-red-600">
                Limit reached
              </span>
            )}
          </div>
          <div className="h-2 w-full rounded-full bg-zinc-100 overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                usedPct >= 100 ? "bg-red-500" : usedPct >= 80 ? "bg-amber-400" : "bg-emerald-500"
              )}
              style={{ width: `${usedPct}%` }}
            />
          </div>
        </div>
      )}

      {/* Plan cards */}
      <div className="grid gap-4 sm:grid-cols-2">
        {PLANS.map((plan) => {
          const Icon = plan.icon;
          const isCurrent = currentPlan === plan.id && (plan.id === "free" ? !isPro : isPro);

          return (
            <div
              key={plan.id}
              className={cn(
                "relative rounded-2xl border bg-white p-6 flex flex-col shadow-sm",
                plan.id === "pro" && "ring-2 ring-blue-500"
              )}
            >
              {plan.badge && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-blue-600 px-3 py-1 text-[11px] font-semibold text-white shadow">
                  {plan.badge}
                </div>
              )}
              {isCurrent && (
                <div className="absolute -top-3 right-4 rounded-full bg-zinc-800 px-3 py-1 text-[11px] font-semibold text-white shadow">
                  Current plan
                </div>
              )}

              <div className="mb-4 flex items-center gap-2.5">
                <div className={cn("flex h-9 w-9 items-center justify-center rounded-xl", plan.iconBg)}>
                  <Icon className={cn("h-4 w-4", plan.iconColor)} />
                </div>
                <div>
                  <p className="font-semibold text-zinc-900">{plan.name}</p>
                  <p className="text-xs text-zinc-400">{plan.description}</p>
                </div>
              </div>

              <div className="mb-5">
                <span className="text-3xl font-bold text-zinc-900">{plan.price}</span>
                <span className="text-sm text-zinc-400"> {plan.period}</span>
              </div>

              <ul className="mb-6 flex-1 space-y-2.5">
                {plan.features.map((feat) => (
                  <li key={feat} className="flex items-start gap-2 text-xs text-zinc-600">
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                    {feat}
                  </li>
                ))}
              </ul>

              {plan.id === "free" ? (
                <Button variant="outline" disabled className="w-full cursor-default">
                  {isPro ? "Downgrade" : "Current plan"}
                </Button>
              ) : isCurrent ? (
                sub?.paystack_subscription_code ? (
                  <Button
                    variant="outline"
                    className="w-full text-red-500 hover:text-red-600 border-red-200 hover:border-red-300"
                    onClick={() => setShowCancelConfirm(true)}
                  >
                    Cancel subscription
                  </Button>
                ) : (
                  <Button variant="outline" disabled className="w-full cursor-default">
                    Active — renews manually
                  </Button>
                )
              ) : (
                <Button
                  className="w-full bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 gap-2"
                  onClick={handleUpgrade}
                  disabled={upgrading}
                >
                  {upgrading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <CreditCard className="h-4 w-4" />
                  )}
                  {upgrading ? "Redirecting to Paystack…" : "Upgrade to Pro — GHS 50/mo"}
                </Button>
              )}
            </div>
          );
        })}
      </div>

      {/* Pro subscription details */}
      {isPro && (
        <section className="rounded-2xl border bg-white p-6 shadow-sm space-y-4">
          <h2 className="text-sm font-semibold text-zinc-700 flex items-center gap-2">
            <CalendarDays className="h-4 w-4 text-zinc-400" />
            Subscription details
          </h2>
          <Separator />
          <div className="grid gap-3 sm:grid-cols-2 text-sm">
            <div>
              <p className="text-xs text-zinc-400">Plan</p>
              <p className="font-medium text-zinc-800 mt-0.5">Pro — GHS 50 / month</p>
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
              Your subscription is cancelled. You&apos;ll have Pro access until the period ends, then revert to Free.
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
              You&apos;ll keep Pro access until your current period ends. After that, you&apos;ll be limited to 5 product uploads.
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
                Keep Pro
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
