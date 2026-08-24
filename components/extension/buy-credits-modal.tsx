"use client";

/**
 * "Buy Credits" modal for the extension dashboard — one-time credit-pack
 * top-ups, separate from the classic app's plan-based monthly quota
 * (lib/billing/quota.ts) and its Paystack checkout (app/api/paystack/*).
 *
 * Checkout is intentionally NOT wired to a real payment provider yet — see
 * docs/chrome-extension-plan.md §10 update. Submitting calls
 * /api/extension/credits/checkout, which currently always returns "not
 * configured" until the provider, pricing, and currency are decided and a
 * live secret key exists. This modal is the agreed UI shell for that flow.
 */

import { useState } from "react";
import { X, Check, Loader2, Lock } from "lucide-react";
import { cn } from "@/lib/utils";

interface Tier {
  id: string;
  credits: number;
  price: string;
  perCredit: string;
  popular?: boolean;
}

// Placeholder tiers — pricing/currency not yet decided (GHS vs USD) and
// this is a stand-in until that's settled with real numbers.
const TIERS: Tier[] = [
  { id: "small",  credits: 50,  price: "GHS 60",  perCredit: "GHS 1.20/credit" },
  { id: "medium", credits: 150, price: "GHS 150", perCredit: "GHS 1.00/credit", popular: true },
  { id: "large",  credits: 500, price: "GHS 400", perCredit: "GHS 0.80/credit" },
];

export function BuyCreditsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [selected, setSelected] = useState("medium");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const tier = TIERS.find((t) => t.id === selected)!;

  async function buy() {
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/extension/credits/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: selected }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Could not start checkout.");
        return;
      }
      if (data.url) window.location.href = data.url;
    } catch {
      setError("Network error — please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold text-zinc-900">Buy extra credits</h2>
            <p className="text-xs text-zinc-500">Added instantly · never expire</p>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-5 space-y-2.5">
          {TIERS.map((t) => (
            <button
              key={t.id}
              onClick={() => setSelected(t.id)}
              className={cn(
                "flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left transition-colors",
                selected === t.id ? "border-zinc-900 bg-zinc-50" : "border-zinc-200 hover:border-zinc-300",
              )}
            >
              <div>
                <span className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
                  {t.credits} credits
                  {t.popular && (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700">
                      Popular
                    </span>
                  )}
                </span>
                <p className="mt-0.5 text-xs text-zinc-500">
                  {t.price} · {t.perCredit}
                </p>
              </div>
              <span
                className={cn(
                  "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2",
                  selected === t.id ? "border-zinc-900 bg-zinc-900" : "border-zinc-300",
                )}
              >
                {selected === t.id && <Check className="h-3 w-3 text-white" />}
              </span>
            </button>
          ))}
        </div>

        {error && <p className="mt-3 text-xs text-red-600">{error}</p>}

        <button
          onClick={buy}
          disabled={pending}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-zinc-900 px-4 py-3 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Buy {tier.credits} credits · {tier.price}
        </button>
        <p className="mt-2.5 flex items-center justify-center gap-1 text-[11px] text-zinc-400">
          <Lock className="h-3 w-3" /> Secure checkout
        </p>
      </div>
    </div>
  );
}
