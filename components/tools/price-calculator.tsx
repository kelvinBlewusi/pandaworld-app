"use client";

/**
 * Jumia listing-price / net-payout calculator.
 *
 * Pure client-side — no Jumia connection or account data required, just the
 * static commission/shipping table in lib/mock/categories. That's what lets
 * it render inside the main app ((main)/price-calculator, behind the
 * Jumia-OAuth gate), on the extension's own dashboard (extension/(app)/
 * calculator), and on the public, indexable app/jumia-price-calculator.
 */

import { useState, useMemo } from "react";
import { Calculator, Info, TrendingUp, TrendingDown, ArrowRight, RefreshCw } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { mockCategories } from "@/lib/mock/categories";
import { formatGHS } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { listingPriceFor } from "@/lib/marketing/jumia-fees";

// ── Types ─────────────────────────────────────────────────────────────────────

type Mode = "reverse" | "forward";
type ShippingMode = "je" | "ds";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Jumia formula (VendorHub GH):
 * Listing Price = (Vendor Price + Shipping Contribution) / (1 − Commission Rate)
 * Round UP to nearest 0.01
 */
function calcListingPrice(vendorPrice: number, shippingContrib: number, commissionPct: number) {
  return listingPriceFor(vendorPrice, shippingContrib, commissionPct);
}

/**
 * Forward: given listing price, what does the vendor actually receive?
 * Net = Listing Price − Commission − Shipping Contribution
 */
function calcNetPayout(listingPrice: number, shippingContrib: number, commissionPct: number) {
  const commission = listingPrice * (commissionPct / 100);
  return listingPrice - commission - shippingContrib;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function PriceCalculator({ showHeader = true }: {
  /** False on the public calculator page (app/jumia-price-calculator), which has its own H1. */
  showHeader?: boolean;
} = {}) {
  const [mode, setMode] = useState<Mode>("reverse");
  const [categoryId, setCategoryId] = useState<string>("");
  const [shippingMode, setShippingMode] = useState<ShippingMode>("je");
  const [priceInput, setPriceInput] = useState<string>("");

  const category = useMemo(
    () => mockCategories.find((c) => c.id === categoryId) ?? null,
    [categoryId]
  );

  const shippingContrib = category
    ? shippingMode === "je"
      ? category.shippingJE
      : category.shippingDS
    : 0;

  const result = useMemo(() => {
    const price = parseFloat(priceInput);
    if (!category || isNaN(price) || price <= 0) return null;

    if (mode === "reverse") {
      // Vendor price → listing price
      const listingPrice = calcListingPrice(price, shippingContrib, category.commissionRate);
      const commissionDeducted = listingPrice * (category.commissionRate / 100);
      return {
        listingPrice,
        vendorPrice: price,
        commissionDeducted,
        shippingDeducted: shippingContrib,
        netPayout: price, // by construction
        commissionRate: category.commissionRate,
      };
    } else {
      // Listing price → net payout
      const commissionDeducted = price * (category.commissionRate / 100);
      const netPayout = calcNetPayout(price, shippingContrib, category.commissionRate);
      return {
        listingPrice: price,
        vendorPrice: null,
        commissionDeducted,
        shippingDeducted: shippingContrib,
        netPayout,
        commissionRate: category.commissionRate,
      };
    }
  }, [mode, category, priceInput, shippingContrib]);

  const handleModeSwitch = (newMode: Mode) => {
    setMode(newMode);
    setPriceInput("");
  };

  return (
    <div className="space-y-6 max-w-2xl">
      {showHeader && (
        <div>
          <h1 className="text-2xl font-bold text-zinc-900">Price calculator</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Calculate the price to show on Jumia or estimate the amount you will receive.
          </p>
        </div>
      )}

      {/* Mode toggle */}
      <div className="flex rounded-xl border bg-zinc-50 p-1 gap-1">
        <button
          onClick={() => handleModeSwitch("reverse")}
          className={cn(
            "flex-1 rounded-lg px-4 py-2.5 text-sm font-medium transition-all",
            mode === "reverse"
              ? "bg-white shadow-sm text-zinc-900"
              : "text-zinc-500 hover:text-zinc-700"
          )}
        >
          <span className="flex items-center justify-center gap-2">
            <TrendingUp className="h-4 w-4" />
            Set price to show on Jumia
          </span>
          <p className="mt-0.5 text-xs font-normal text-zinc-400">
            I know what I want to earn
          </p>
        </button>
        <button
          onClick={() => handleModeSwitch("forward")}
          className={cn(
            "flex-1 rounded-lg px-4 py-2.5 text-sm font-medium transition-all",
            mode === "forward"
              ? "bg-white shadow-sm text-zinc-900"
              : "text-zinc-500 hover:text-zinc-700"
          )}
        >
          <span className="flex items-center justify-center gap-2">
            <TrendingDown className="h-4 w-4" />
            Check how much I will be paid
          </span>
          <p className="mt-0.5 text-xs font-normal text-zinc-400">
            I know my listing price
          </p>
        </button>
      </div>

      {/* Formula explainer */}
      <div className="flex gap-3 rounded-xl border border-blue-100 bg-blue-50 p-4">
        <Info className="h-4 w-4 shrink-0 text-blue-500 mt-0.5" />
        <div className="text-xs text-blue-700 leading-relaxed space-y-1">
          {mode === "reverse" ? (
            <>
              <p>
                <strong>Jumia formula:</strong> Listing Price = (Your Price + Shipping Contribution) ÷ (1 − Commission %)
              </p>
              <p className="text-blue-600 italic">
                Example (Fashion, JE): (GHS 950 + 6) ÷ (1 − 0.20) = GHS 1,195.00
              </p>
            </>
          ) : (
            <>
              <p>
                <strong>Net payout:</strong> Listing Price − Commission − Shipping Contribution
              </p>
              <p className="text-blue-600 italic">
                Example (Fashion, JE): GHS 1,195 − GHS 239 − GHS 6 = GHS 950.00
              </p>
            </>
          )}
          <p className="text-blue-500">
            Shipping contributions are per-category and differ between Jumia Express (JE) and Drop Shipping (DS).
          </p>
        </div>
      </div>

      {/* Inputs */}
      <div className="rounded-2xl border bg-white p-6 space-y-5 shadow-sm">
        <h2 className="text-sm font-semibold text-zinc-700">Your details</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {/* Category */}
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Category</Label>
            <Select value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a category…" />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {mockCategories.map((cat) => (
                  <SelectItem key={cat.id} value={cat.id}>
                    {cat.name}
                    <span className="ml-2 text-xs text-zinc-400">
                      {cat.commissionRate}% commission
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Shipping mode */}
          <div className="space-y-1.5">
            <Label>Shipping mode</Label>
            <Select value={shippingMode} onValueChange={(v) => setShippingMode(v as ShippingMode)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="je">
                  Jumia Express (JE)
                  {category ? ` — GHS ${category.shippingJE}` : ""}
                </SelectItem>
                <SelectItem value="ds">
                  Drop Shipping (DS)
                  {category ? ` — GHS ${category.shippingDS}` : ""}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Price input */}
          <div className="space-y-1.5">
            <Label>
              {mode === "reverse"
                ? "What you want to receive (GHS)"
                : "Your listing price on Jumia (GHS)"}
            </Label>
            <Input
              type="number"
              min="0"
              step="0.01"
              placeholder={mode === "reverse" ? "e.g. 950" : "e.g. 1195"}
              value={priceInput}
              onChange={(e) => setPriceInput(e.target.value)}
            />
          </div>
        </div>

        {/* Quick shipping info */}
        {category && (
          <div className="rounded-lg bg-zinc-50 border px-4 py-3 text-xs text-zinc-500 flex items-center gap-6">
            <span>
              <strong className="text-zinc-700">{category.name}</strong> · {category.commissionRate}% commission
            </span>
            <span>JE shipping: <strong className="text-zinc-700">GHS {category.shippingJE}</strong></span>
            <span>DS shipping: <strong className="text-zinc-700">GHS {category.shippingDS}</strong></span>
          </div>
        )}
      </div>

      {/* Result */}
      {result ? (
        <div className="rounded-2xl border bg-white shadow-sm overflow-hidden">
          {/* Gradient header */}
          <div
            className={cn(
              "px-6 py-4",
              mode === "reverse"
                ? "bg-gradient-to-r from-blue-500 to-indigo-600"
                : "bg-gradient-to-r from-emerald-500 to-teal-600"
            )}
          >
            <p className="text-xs font-medium text-white/70">
              {mode === "reverse" ? "Suggested listing price" : "Estimated earnings"}
            </p>
            <p className="mt-1 text-3xl font-bold text-white">
              {mode === "reverse"
                ? formatGHS(result.listingPrice)
                : formatGHS(result.netPayout)}
            </p>
            <p className="mt-0.5 text-xs text-white/60">
              {category?.name} · {shippingMode.toUpperCase()}
            </p>
          </div>

          {/* Breakdown */}
          <div className="px-6 py-5 space-y-3">
            {mode === "reverse" ? (
              <>
                {/* Reverse mode: show how listing price was derived */}
                <div className="flex items-center justify-between py-2 border-b">
                  <span className="text-sm text-zinc-600">Your desired payout</span>
                  <span className="text-sm font-semibold text-zinc-900">
                    {formatGHS(result.vendorPrice!)}
                  </span>
                </div>
                <div className="flex items-center justify-between py-2 border-b">
                  <div>
                    <span className="text-sm text-zinc-600">Shipping contribution</span>
                    <p className="text-xs text-zinc-400">
                      {shippingMode === "je" ? "Jumia Express" : "Drop Shipping"} — added to base
                    </p>
                  </div>
                  <span className="text-sm font-medium text-zinc-700">
                    + {formatGHS(result.shippingDeducted)}
                  </span>
                </div>
                <div className="flex items-center justify-between py-2 border-b">
                  <div>
                    <span className="text-sm text-zinc-600">
                      Commission ({result.commissionRate}%)
                    </span>
                    <p className="text-xs text-zinc-400">Divided out via formula</p>
                  </div>
                  <span className="text-sm font-medium text-zinc-700">
                    ÷ {(1 - result.commissionRate / 100).toFixed(2)}
                  </span>
                </div>
                <div className="flex items-center justify-between pt-3">
                  <div className="flex items-center gap-2">
                    <ArrowRight className="h-4 w-4 text-blue-500" />
                    <span className="text-sm font-bold text-zinc-900">
                      Set this as your Jumia price
                    </span>
                  </div>
                  <span className="text-xl font-bold text-blue-600">
                    {formatGHS(result.listingPrice)}
                  </span>
                </div>
                {/* Verification */}
                <div className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-xs text-blue-700 space-y-1">
                  <p className="font-medium">Verification (after Jumia deductions)</p>
                  <div className="flex justify-between">
                    <span>Listing price</span>
                    <span>{formatGHS(result.listingPrice)}</span>
                  </div>
                  <div className="flex justify-between text-red-600">
                    <span>− Commission ({result.commissionRate}%)</span>
                    <span>− {formatGHS(result.commissionDeducted)}</span>
                  </div>
                  <div className="flex justify-between text-red-600">
                    <span>− Shipping ({shippingMode.toUpperCase()})</span>
                    <span>− {formatGHS(result.shippingDeducted)}</span>
                  </div>
                  <div className="flex justify-between font-semibold text-emerald-700 border-t border-blue-200 pt-1 mt-1">
                    <span>= You receive</span>
                    <span>{formatGHS(result.netPayout)}</span>
                  </div>
                </div>
              </>
            ) : (
              <>
                {/* Forward mode: listing price → net payout */}
                <div className="flex items-center justify-between py-2 border-b">
                  <span className="text-sm text-zinc-600">Your listing price</span>
                  <span className="text-sm font-semibold text-zinc-900">
                    {formatGHS(result.listingPrice)}
                  </span>
                </div>
                <div className="flex items-center justify-between py-2 border-b">
                  <div>
                    <span className="text-sm text-zinc-600">
                      Commission ({result.commissionRate}%)
                    </span>
                    <p className="text-xs text-zinc-400">Jumia fee on selling price</p>
                  </div>
                  <span className="text-sm font-medium text-red-500">
                    − {formatGHS(result.commissionDeducted)}
                  </span>
                </div>
                <div className="flex items-center justify-between py-2 border-b">
                  <div>
                    <span className="text-sm text-zinc-600">Shipping contribution</span>
                    <p className="text-xs text-zinc-400">
                      {shippingMode === "je" ? "Jumia Express" : "Drop Shipping"}
                    </p>
                  </div>
                  <span className="text-sm font-medium text-red-500">
                    − {formatGHS(result.shippingDeducted)}
                  </span>
                </div>
                <div className="flex items-center justify-between pt-3">
                  <div className="flex items-center gap-1.5">
                    <TrendingDown className="h-4 w-4 text-emerald-500" />
                    <span className="text-sm font-bold text-zinc-900">Net payout to you</span>
                  </div>
                  <span
                    className={cn(
                      "text-xl font-bold",
                      result.netPayout >= 0 ? "text-emerald-600" : "text-red-500"
                    )}
                  >
                    {formatGHS(result.netPayout)}
                  </span>
                </div>
                {result.netPayout < 0 && (
                  <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
                    ⚠️ At this price, fees exceed your listing price. Consider raising your price.
                  </p>
                )}
                {result.netPayout >= 0 && (
                  <div className="rounded-lg border border-zinc-100 bg-zinc-50 px-4 py-2.5 text-xs text-zinc-500 flex items-center justify-between">
                    <span>Effective margin</span>
                    <span className="font-semibold text-zinc-700">
                      {((result.netPayout / result.listingPrice) * 100).toFixed(1)}% of listing price
                    </span>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Swap mode hint */}
          <div className="border-t px-6 py-3 bg-zinc-50">
            <button
              className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-600 transition-colors"
              onClick={() => handleModeSwitch(mode === "reverse" ? "forward" : "reverse")}
            >
              <RefreshCw className="h-3 w-3" />
              Switch to {mode === "reverse" ? "check earnings from a known price" : "calculate listing price from desired payout"}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed bg-zinc-50 py-16 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-zinc-100">
            <Calculator className="h-6 w-6 text-zinc-400" />
          </div>
          <div>
            <p className="text-sm font-medium text-zinc-500">
              {!category
                ? "Select a category to get started"
                : "Enter a price to see the breakdown"}
            </p>
            <p className="mt-1 text-xs text-zinc-400">
              Rates sourced from Jumia VendorHub GH commission schedule
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
