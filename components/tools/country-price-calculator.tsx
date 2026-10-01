"use client";

/**
 * Jumia price calculator for one country, on /sell-on-jumia/<country>:
 * pick the category and the commission fills in from Jumia's own table for
 * that country (lib/marketing/country-fees.ts), along with the per-item fee
 * where Jumia publishes one by category or by item size. Where it doesn't
 * (Kenya, Côte d'Ivoire), the seller types the fee from Vendor Center.
 *
 * Same formula Jumia publishes: list at (payout + fee) ÷ (1 − commission).
 */

import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  commissionOn,
  itemFeeFor,
  listPriceFor,
  payoutAt,
  type CountryFees,
  type Fulfilment,
} from "@/lib/marketing/country-fees";

type Mode = "list" | "payout";

const selectClass =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

export function CountryPriceCalculator({
  fees,
  currency,
  wholeUnits,
  samplePrice,
}: {
  fees:        CountryFees;
  currency:    string;
  wholeUnits:  boolean;
  samplePrice: number;
}) {
  const [mode, setMode] = useState<Mode>("list");
  const [categoryName, setCategoryName] = useState("");
  const [fulfilment, setFulfilment] = useState<Fulfilment>("ds");
  const [sizeId, setSizeId] = useState("");
  const [typedFee, setTypedFee] = useState("");
  const [amount, setAmount] = useState("");

  const how = fees.itemFee;
  const manualFee = how.by === "manual";
  const sizes = how.by === "size" ? how.sizes.filter((s) => s[fulfilment] != null) : [];
  const category = fees.categories.find((c) => c.name === categoryName) ?? null;
  const step = wholeUnits ? 1 : 0.01;

  const money = useMemo(
    () => new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      minimumFractionDigits: wholeUnits ? 0 : 2,
      maximumFractionDigits: wholeUnits ? 0 : 2,
    }),
    [currency, wholeUnits],
  );

  const fee = manualFee ? parseFloat(typedFee) || 0 : itemFeeFor(fees, category, fulfilment, sizeId || null);

  const result = useMemo(() => {
    const value = parseFloat(amount);
    if (!category || fee == null || !(value > 0)) return null;
    const pct = category.commission;
    if (mode === "list") {
      const listPrice = listPriceFor(fees, value, fee, pct, fulfilment, step);
      return { listPrice, commission: commissionOn(fees, listPrice, pct, fulfilment), payout: value };
    }
    return { listPrice: value, commission: commissionOn(fees, value, pct, fulfilment), payout: payoutAt(fees, value, fee, pct, fulfilment) };
  }, [amount, category, fee, fees, fulfilment, mode, step]);

  const feeLabel = fees.feeName.charAt(0).toUpperCase() + fees.feeName.slice(1);
  const missing = !category ? "a category" : fee == null ? (how.by === "size" ? "the item's size" : "a category") : "a price";

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

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="cc-category">Category</Label>
          <select id="cc-category" className={selectClass} value={categoryName} onChange={(e) => setCategoryName(e.target.value)}>
            <option value="">Choose your product&apos;s category</option>
            {fees.categories.map((c) => (
              <option key={c.name} value={c.name}>{c.name} ({c.commission}%)</option>
            ))}
          </select>
        </div>

        {!manualFee && (
          <div className="space-y-1.5">
            <Label>Who stores and ships it</Label>
            <div className="flex gap-1 rounded-md border bg-zinc-50 p-1">
              {([["ds", "You (drop shipping)"], ["je", "Jumia Express"]] as const).map(([f, label]) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFulfilment(f)}
                  className={cn(
                    "flex-1 rounded px-2 py-1.5 text-xs font-medium transition-all",
                    fulfilment === f ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500 hover:text-zinc-700",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        {how.by === "size" && (
          <div className="space-y-1.5">
            <Label htmlFor="cc-size">Item size</Label>
            <select id="cc-size" className={selectClass} value={sizes.some((s) => s.id === sizeId) ? sizeId : ""} onChange={(e) => setSizeId(e.target.value)}>
              <option value="">Choose a size</option>
              {sizes.map((s) => (
                <option key={s.id} value={s.id}>{s.label} ({money.format(s[fulfilment] ?? 0)})</option>
              ))}
            </select>
          </div>
        )}

        {manualFee && (
          <div className="space-y-1.5">
            <Label htmlFor="cc-fee">{feeLabel} ({currency})</Label>
            <Input id="cc-fee" inputMode="decimal" placeholder="0" value={typedFee} onChange={(e) => setTypedFee(e.target.value)} />
            <p className="text-xs text-zinc-500">{how.hint}</p>
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="cc-amount">{mode === "list" ? `You want to receive (${currency})` : `Listing price (${currency})`}</Label>
          <Input id="cc-amount" inputMode="decimal" placeholder={String(samplePrice)} value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
      </div>

      {result && category ? (
        <dl className="divide-y divide-zinc-100 rounded-xl bg-zinc-50 px-4 text-sm">
          <div className="flex justify-between py-2.5">
            <dt className="text-zinc-600">Listing price on Jumia</dt>
            <dd className="font-semibold text-zinc-900">{money.format(result.listPrice)}</dd>
          </div>
          <div className="flex justify-between gap-4 py-2.5">
            <dt className="text-zinc-600">Commission ({category.commission}%)</dt>
            <dd className="text-zinc-700">− {money.format(result.commission)}</dd>
          </div>
          <div className="flex justify-between gap-4 py-2.5">
            <dt className="text-zinc-600">{feeLabel}</dt>
            <dd className="text-zinc-700">− {money.format(fee ?? 0)}</dd>
          </div>
          <div className="flex justify-between py-2.5">
            <dt className="font-semibold text-zinc-900">You receive</dt>
            <dd className={cn("font-bold", result.payout >= 0 ? "text-emerald-600" : "text-red-600")}>{money.format(result.payout)}</dd>
          </div>
        </dl>
      ) : (
        <p className="text-sm text-zinc-500">Choose {missing} to see the numbers.</p>
      )}

      {fees.minCommissionDs != null && fulfilment === "ds" && (
        <p className="text-xs text-zinc-500">
          Jumia takes at least {money.format(fees.minCommissionDs)} commission on items you ship from your own warehouse.
        </p>
      )}
    </div>
  );
}
