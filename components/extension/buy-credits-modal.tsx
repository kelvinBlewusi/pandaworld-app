"use client";

/**
 * "Buy Credits" modal for the extension dashboard — one-time credit-pack
 * top-ups via Paystack (app/api/extension/credits/checkout). Credits never
 * expire and are spent per autofill and per WhatsApp listing that goes live
 * (LISTING_CREDIT_COST / LIVE_LISTING_CREDIT_COST in lib/billing/
 * credit-packs.ts). Shown only
 * while billing is on (lib/billing/mode.ts).
 */

import { useState } from "react";
import { X, Check, Loader2, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import { CREDIT_PACKS, LIVE_LISTING_CREDIT_COST, POPULAR_PACK_ID, packFeatures, packReach } from "@/lib/billing/credit-packs";

interface Tier {
  id: string;
  name: string;
  credits: number;
  price: string;
  reach: string;
  popular?: boolean;
  /** What the pack unlocks now (short labels), and what it will. */
  unlocks: string[];
  soon: string[];
}

const TIERS: Tier[] = CREDIT_PACKS.map((p) => {
  const { listings } = packReach(p.credits);
  return {
    id: p.id,
    name: p.id.charAt(0).toUpperCase() + p.id.slice(1),
    credits: p.credits,
    price: `GHS ${p.amountGhs}`,
    // Listings only, as "50+" (owner's call, 2026-10-01).
    reach: `${listings}+ listings`,
    popular: p.id === POPULAR_PACK_ID,
    unlocks: packFeatures(p.id).filter((f) => !f.comingSoon).map((f) => f.short),
    soon:    packFeatures(p.id).filter((f) => f.comingSoon).map((f) => f.short),
  };
});

export function BuyCreditsModal({
  open,
  onClose,
  signedIn = true,
  signInHref,
  listingCost = LIVE_LISTING_CREDIT_COST,
}: {
  open: boolean;
  onClose: () => void;
  /** What a listing costs this seller (their country's price); the usual price otherwise. */
  listingCost?: number;
  // False when shown to a logged-out visitor (the /extension marketing
  // page's "Pricing" popup) — the dashboard's own usage is always signed
  // in, so this defaults to true and that caller needs no changes.
  signedIn?: boolean;
  // Where "Buy" sends a logged-out visitor instead of calling checkout —
  // required whenever signedIn is false.
  signInHref?: string;
}) {
  const [selected, setSelected] = useState(POPULAR_PACK_ID);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const tier = TIERS.find((t) => t.id === selected)!;

  async function buy() {
    // Logged-out visitor: /api/extension/credits/checkout requires a Clerk
    // session and would just 401. Send them to sign in instead of showing
    // an error for something that isn't actually broken.
    if (!signedIn) {
      if (signInHref) window.location.href = signInHref;
      return;
    }
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
        className="max-h-[calc(100vh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold text-zinc-900">Buy extra credits</h2>
            <p className="text-xs text-zinc-500">Added instantly · never expire · everything in the chat on every pack</p>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-5 space-y-2" role="radiogroup" aria-label="Credit packs">
          {TIERS.map((t) => (
            <button
              key={t.id}
              role="radio"
              aria-checked={selected === t.id}
              onClick={() => setSelected(t.id)}
              className={cn(
                "flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left transition-colors",
                selected === t.id ? "border-zinc-900 bg-zinc-50" : "border-zinc-200 hover:border-zinc-300",
              )}
            >
              <span
                className={cn(
                  "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2",
                  selected === t.id ? "border-zinc-900 bg-zinc-900" : "border-zinc-300",
                )}
              >
                {selected === t.id && <Check className="h-3 w-3 text-white" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
                    {t.credits} credits
                    {t.popular && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700">
                        Popular
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-sm font-semibold text-zinc-900">{t.price}</span>
                </span>
                <span className="mt-0.5 block text-xs text-zinc-500">About {listingCost === LIVE_LISTING_CREDIT_COST ? t.reach : `${packReach(t.credits, listingCost).listings}+ listings`}</span>
                {(t.unlocks.length > 0 || t.soon.length > 0) && (
                  <span className="mt-2 flex flex-wrap gap-1.5">
                    {t.unlocks.map((u) => (
                      <span key={u} className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                        <Check className="h-3 w-3" /> {u}
                      </span>
                    ))}
                    {t.soon.length > 0 && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                        <Check className="h-3 w-3" /> {t.soon.length} more {t.soon.length === 1 ? "tool" : "tools"}
                      </span>
                    )}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>

        {tier.soon.length > 0 && (
          <p className="mt-3 rounded-lg bg-zinc-50 px-3 py-2 text-[11px] leading-relaxed text-zinc-600">
            With {tier.name}: {tier.soon.join(" · ")}
          </p>
        )}

        {error && <p className="mt-3 text-xs text-red-600">{error}</p>}

        <button
          onClick={buy}
          disabled={pending}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-zinc-900 px-4 py-3 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {signedIn ? `Buy ${tier.credits} credits · ${tier.price}` : "Sign in to buy"}
        </button>
        <p className="mt-2.5 flex items-center justify-center gap-1 text-[11px] text-zinc-400">
          <Lock className="h-3 w-3" /> Secure checkout by Paystack
        </p>
        <p className="mt-1 text-center text-[11px] text-zinc-400">
          By buying you agree to our{" "}
          <a href="/terms" target="_blank" rel="noopener noreferrer" className="underline hover:text-zinc-600">Terms</a>
          {" "}and{" "}
          <a href="/privacy" target="_blank" rel="noopener noreferrer" className="underline hover:text-zinc-600">Privacy Policy</a>.
        </p>
      </div>
    </div>
  );
}
