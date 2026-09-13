"use client";

/**
 * "Donate" modal — temporarily stands in for BuyCreditsModal on both the
 * extension dashboard (components/extension/shell.tsx) and the marketing
 * page's Pricing trigger (components/marketing/extension-hero-backdrop.tsx)
 * while lib/billing/free-for-all.ts's FREE_FOR_ALL_MODE is on: WhatsApp +
 * the extension are free to use, so instead of selling credit packs we
 * just ask sellers who want to support the project to chip in whatever
 * they like. Grants nothing back (no credits, no plan change) — see
 * lib/billing/donations.ts. BuyCreditsModal itself is untouched and still
 * fully wired up (checkout + webhook + verify), so switching back to paid
 * credits later is just swapping which modal these two callers render.
 */

import { useState } from "react";
import { X, Heart, Loader2, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import { MIN_DONATION_GHS, MAX_DONATION_GHS } from "@/lib/billing/donation-limits";

const SUGGESTED_AMOUNTS = [10, 20, 50, 100];

export function DonateModal({
  open,
  onClose,
  signedIn = true,
  signInHref,
}: {
  open: boolean;
  onClose: () => void;
  // False when shown to a logged-out visitor (the /extension marketing
  // page's "Donate" popup) — the dashboard's own usage is always signed
  // in, so this defaults to true and that caller needs no changes.
  signedIn?: boolean;
  // Where "Donate" sends a logged-out visitor instead of calling checkout —
  // required whenever signedIn is false.
  signInHref?: string;
}) {
  const [amount, setAmount] = useState<number | null>(20);
  const [customAmount, setCustomAmount] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const effectiveAmount = customAmount.trim() ? Number(customAmount) : amount;
  const validAmount =
    effectiveAmount != null &&
    Number.isFinite(effectiveAmount) &&
    effectiveAmount >= MIN_DONATION_GHS &&
    effectiveAmount <= MAX_DONATION_GHS;

  async function donate() {
    if (!signedIn) {
      if (signInHref) window.location.href = signInHref;
      return;
    }
    if (!validAmount) {
      setError(`Enter an amount between GHS ${MIN_DONATION_GHS} and GHS ${MAX_DONATION_GHS}.`);
      return;
    }
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/donations/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountGhs: effectiveAmount }),
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
            <h2 className="text-lg font-bold text-zinc-900">Support PandaWorld</h2>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-5 grid grid-cols-4 gap-2">
          {SUGGESTED_AMOUNTS.map((a) => (
            <button
              key={a}
              onClick={() => {
                setAmount(a);
                setCustomAmount("");
              }}
              className={cn(
                "rounded-xl border px-2 py-3 text-sm font-semibold transition-colors",
                amount === a && !customAmount.trim()
                  ? "border-zinc-900 bg-zinc-50 text-zinc-900"
                  : "border-zinc-200 text-zinc-600 hover:border-zinc-300",
              )}
            >
              GHS {a}
            </button>
          ))}
        </div>

        <div className="mt-3">
          <label className="text-xs font-medium text-zinc-500">Or enter your own amount (GHS)</label>
          <input
            type="number"
            min={MIN_DONATION_GHS}
            max={MAX_DONATION_GHS}
            value={customAmount}
            onChange={(e) => setCustomAmount(e.target.value)}
            placeholder={`${MIN_DONATION_GHS} - ${MAX_DONATION_GHS}`}
            className="mt-1.5 w-full rounded-xl border border-zinc-200 px-4 py-3 text-sm text-zinc-900 outline-none focus:border-zinc-400"
          />
        </div>

        {error && <p className="mt-3 text-xs text-red-600">{error}</p>}

        <button
          onClick={donate}
          disabled={pending || !validAmount}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-zinc-900 px-4 py-3 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Heart className="h-4 w-4" />}
          {signedIn
            ? `Donate${validAmount ? ` GHS ${effectiveAmount}` : ""}`
            : "Sign in to donate"}
        </button>
        <p className="mt-2.5 flex items-center justify-center gap-1 text-[11px] text-zinc-400">
          <Lock className="h-3 w-3" /> Secure checkout by Paystack
        </p>
      </div>
    </div>
  );
}
