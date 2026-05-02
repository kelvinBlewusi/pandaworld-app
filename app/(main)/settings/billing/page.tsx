"use client";

import { Check, Zap, Building2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const plans = [
  {
    id: "free",
    name: "Free",
    price: "GHS 0",
    period: "forever",
    description: "Perfect for getting started",
    icon: Sparkles,
    iconColor: "text-zinc-400",
    gradient: "",
    current: true,
    features: [
      "Up to 10 listings / month",
      "Jumia channel only",
      "AI copy generation",
      "Price calculator",
      "Email support",
    ],
    limitations: [
      "No bulk import",
      "No multi-channel",
      "No priority support",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    price: "GHS 199",
    period: "/ month",
    description: "For growing vendors",
    icon: Zap,
    iconColor: "text-blue-500",
    gradient: "ring-2 ring-blue-500",
    current: false,
    badge: "Most popular",
    features: [
      "Unlimited listings",
      "Jumia + 2 extra channels",
      "Bulk CSV import",
      "AI image enhancement",
      "Priority email support",
      "Weekly performance report",
    ],
    limitations: [],
  },
  {
    id: "business",
    name: "Business",
    price: "GHS 499",
    period: "/ month",
    description: "For serious sellers & agencies",
    icon: Building2,
    iconColor: "text-purple-500",
    gradient: "",
    current: false,
    features: [
      "Everything in Pro",
      "All channels (incl. Amazon, eBay)",
      "Team seats (up to 5 users)",
      "API access",
      "Dedicated account manager",
      "Custom branding on reports",
      "SLA support",
    ],
    limitations: [],
  },
];

export default function BillingPage() {
  return (
    <div className="space-y-8 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-zinc-900">Plans & billing</h1>
        <p className="mt-1 text-sm text-zinc-500">
          You are on the <strong>Free</strong> plan. Upgrade to unlock more listings,
          channels, and AI features.
        </p>
      </div>

      {/* Plan cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        {plans.map((plan) => {
          const Icon = plan.icon;
          return (
            <div
              key={plan.id}
              className={cn(
                "relative rounded-2xl border bg-white p-6 shadow-sm flex flex-col",
                plan.gradient
              )}
            >
              {plan.badge && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-blue-600 px-3 py-1 text-[11px] font-semibold text-white shadow">
                  {plan.badge}
                </div>
              )}
              {plan.current && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-zinc-800 px-3 py-1 text-[11px] font-semibold text-white shadow">
                  Current plan
                </div>
              )}

              <div className="mb-4 flex items-center gap-2">
                <div
                  className={cn(
                    "flex h-8 w-8 items-center justify-center rounded-lg",
                    plan.id === "pro" ? "bg-blue-50" : plan.id === "business" ? "bg-purple-50" : "bg-zinc-100"
                  )}
                >
                  <Icon className={cn("h-4 w-4", plan.iconColor)} />
                </div>
                <span className="font-semibold text-zinc-800">{plan.name}</span>
              </div>

              <div className="mb-1">
                <span className="text-3xl font-bold text-zinc-900">{plan.price}</span>
                <span className="text-sm text-zinc-400"> {plan.period}</span>
              </div>
              <p className="mb-5 text-xs text-zinc-400">{plan.description}</p>

              <ul className="mb-6 flex-1 space-y-2">
                {plan.features.map((feat) => (
                  <li key={feat} className="flex items-start gap-2 text-xs text-zinc-600">
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                    {feat}
                  </li>
                ))}
              </ul>

              <Button
                className={cn(
                  "w-full",
                  plan.current && "cursor-default",
                  plan.id === "pro" &&
                    "bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700"
                )}
                variant={plan.current ? "outline" : "default"}
                disabled={plan.current}
              >
                {plan.current ? "Current plan" : `Upgrade to ${plan.name}`}
              </Button>
            </div>
          );
        })}
      </div>

      {/* Billing info notice */}
      <div className="rounded-xl border border-amber-100 bg-amber-50 p-4">
        <p className="text-xs text-amber-700">
          <strong>Phase 1 note:</strong> Payments are not yet wired up. Clicking "Upgrade"
          does nothing — Stripe integration is planned for Phase 2. Prices are in GHS and
          indicative only.
        </p>
      </div>

      {/* Invoice placeholder */}
      <section className="rounded-2xl border bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-sm font-semibold text-zinc-700">Billing history</h2>
        <div className="py-8 text-center">
          <p className="text-sm text-zinc-400">
            No invoices yet — you're on the Free plan.
          </p>
        </div>
      </section>
    </div>
  );
}
