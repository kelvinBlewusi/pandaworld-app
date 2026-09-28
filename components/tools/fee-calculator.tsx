"use client";

/**
 * Jumia price calculator for any market: the seller enters their
 * category's commission and the fixed fee / shipping contribution, in the
 * country's currency. The Ghana calculator (price-calculator.tsx) picks
 * rates from a table instead; other countries' per-category rates aren't
 * something we hold, so they're typed in from the country's VendorHub.
 *
 * Same formula as Jumia publishes: list at (payout + fee) ÷ (1 − commission).
 */

import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { listingPriceFor } from "@/lib/marketing/jumia-fees";

type Mode = "list" | "payout";

export function FeeCalculator({
  currency,
  wholeUnits,
  samplePrice,
}: {
  currency:    string;
  wholeUnits:  boolean;
  samplePrice: number;
}) {
  const [mode, setMode] = useState<Mode>("list");
  const [amount, setAmount] = useState("");
  const [commission, setCommission] = useState("");
  const [fee, setFee] = useState("");

  const money = useMemo(
    () => new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      minimumFractionDigits: wholeUnits ? 0 : 2,
      maximumFractionDigits: wholeUnits ? 0 : 2,
    }),
    [currency, wholeUnits],
  );

  const result = useMemo(() => {
    const value = parseFloat(amount);
    const pct = parseFloat(commission);
    const fixed = parseFloat(fee) || 0;
    if (!(value > 0) || !(pct >= 0) || pct >= 100) return null;
    const rate = pct / 100;
    const step = wholeUnits ? 1 : 0.01;
    if (mode === "list") {
      const listPrice = listingPriceFor(value, fixed, pct, step);
      return { listPrice, commission: listPrice * rate, fee: fixed, payout: value };
    }
    const commissionAmount = value * rate;
    return { listPrice: value, commission: commissionAmount, fee: fixed, payout: value - commissionAmount - fixed };
  }, [amount, commission, fee, mode, wholeUnits]);

  return (
    <div className="space-y-5 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
      <div className="flex gap-1 rounded-xl border bg-zinc-50 p-1">
        {([["list", "Price to list at"], ["payout", "What I'll be paid"]] as const).map(([m, label]) => (
          <button
            key={m}
            type="button"
            onClick={() => { setMode(m); setAmount(""); }}
            className={cn(
              "flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-all",
              mode === m ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500 hover:text-zinc-700",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="fc-amount">{mode === "list" ? `You want to receive (${currency})` : `Listing price (${currency})`}</Label>
          <Input id="fc-amount" inputMode="decimal" placeholder={String(samplePrice)} value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="fc-commission">Commission (%)</Label>
          <Input id="fc-commission" inputMode="decimal" placeholder="e.g. 15" value={commission} onChange={(e) => setCommission(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="fc-fee">Fixed fee / shipping ({currency})</Label>
          <Input id="fc-fee" inputMode="decimal" placeholder="0" value={fee} onChange={(e) => setFee(e.target.value)} />
        </div>
      </div>

      {result ? (
        <dl className="divide-y divide-zinc-100 rounded-xl bg-zinc-50 px-4 text-sm">
          <div className="flex justify-between py-2.5">
            <dt className="text-zinc-600">Listing price on Jumia</dt>
            <dd className="font-semibold text-zinc-900">{money.format(result.listPrice)}</dd>
          </div>
          <div className="flex justify-between py-2.5">
            <dt className="text-zinc-600">Commission ({commission}%)</dt>
            <dd className="text-zinc-700">− {money.format(result.commission)}</dd>
          </div>
          <div className="flex justify-between py-2.5">
            <dt className="text-zinc-600">Fixed fee / shipping</dt>
            <dd className="text-zinc-700">− {money.format(result.fee)}</dd>
          </div>
          <div className="flex justify-between py-2.5">
            <dt className="font-semibold text-zinc-900">You receive</dt>
            <dd className={cn("font-bold", result.payout >= 0 ? "text-emerald-600" : "text-red-600")}>{money.format(result.payout)}</dd>
          </div>
        </dl>
      ) : (
        <p className="text-sm text-zinc-500">
          Enter a price and your category&apos;s commission. Find the commission for your category on Jumia&apos;s
          commission page, linked below.
        </p>
      )}
    </div>
  );
}
