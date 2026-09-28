"use client";

/**
 * "Buy Credits" modal for the extension dashboard — one-time credit-pack
 * top-ups via Paystack (app/api/extension/credits/checkout). Credits never
 * expire and are spent per autofill / WhatsApp draft (LISTING_CREDIT_COST /
 * WHATSAPP_DRAFT_CREDIT_COST in lib/billing/credit-packs.ts). Shown only
 * while billing is on (lib/billing/mode.ts).
 */

import { useState } from "react";
import { X, Check, Loader2, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import { CREDIT_PACKS, POPULAR_PACK_ID, packReach } from "@/lib/billing/credit-packs";

interface Tier {
  id: string;
  credits: number;
  price: string;
  reach: string;
  popular?: boolean;
}

const TIERS: Tier[] = CREDIT_PACKS.map((p) => {
  const { autofills, drafts } = packReach(p.credits);
  return {
    id: p.id,
    credits: p.credits,
    price: `GHS ${p.amountGhs}`,
    reach: `${autofills} autofills or ${drafts} WhatsApp listings`,
    popular: p.id === POPULAR_PACK_ID,
  };
});

export function BuyCreditsModal({
  open,
  onClose,
  signedIn = true,
  signInHref,
}: {
  open: boolean;
  onClose: () => void;
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
                <p className="mt-0.5 text-xs text-zinc-500">{t.price} · about {t.reach}</p>
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
          {signedIn ? `Buy ${tier.credits} credits · ${tier.price}` : "Sign in to buy"}
        </button>
        <p className="mt-2.5 flex items-center justify-center gap-1 text-[11px] text-zinc-400">
          <Lock className="h-3 w-3" /> Secure checkout by Paystack
        </p>
      </div>
    </div>
  );
}
