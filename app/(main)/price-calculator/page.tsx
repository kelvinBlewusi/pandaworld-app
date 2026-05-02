"use client";

import { useState, useMemo } from "react";
import { Calculator, Info, TrendingDown } from "lucide-react";
import { Button } from "@/components/ui/button";
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

const SHIPPING_CONTRIBUTION: Record<string, number> = {
  je: 15,
  ds: 0,
};

export default function PriceCalculatorPage() {
  const [categoryId, setCategoryId] = useState<string>("");
  const [sellingPrice, setSellingPrice] = useState<string>("");
  const [shippingMode, setShippingMode] = useState<string>("je");

  const result = useMemo(() => {
    const price = parseFloat(sellingPrice);
    if (!categoryId || isNaN(price) || price <= 0) return null;

    const category = mockCategories.find((c) => c.id === categoryId);
    if (!category) return null;

    const commissionAmount = (price * category.commissionRate) / 100;
    const shippingContrib = SHIPPING_CONTRIBUTION[shippingMode] ?? 0;
    const netPayout = price - commissionAmount - shippingContrib;

    return {
      sellingPrice: price,
      category: category.name,
      commissionRate: category.commissionRate,
      commissionAmount,
      shippingContrib,
      netPayout,
    };
  }, [categoryId, sellingPrice, shippingMode]);

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-zinc-900">Price calculator</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Understand your Jumia fees and estimate your net payout before you list.
        </p>
      </div>

      {/* Explainer */}
      <div className="flex gap-3 rounded-xl border border-blue-100 bg-blue-50 p-4">
        <Info className="h-4 w-4 shrink-0 text-blue-500 mt-0.5" />
        <p className="text-xs text-blue-700 leading-relaxed">
          Jumia charges a <strong>commission fee</strong> as a percentage of the selling price,
          which varies by category. If you use <strong>Jumia Express (JE)</strong>, a fixed
          shipping contribution is also deducted. DS (Drop Shipping) has no shipping deduction.
          VAT and other charges may apply — check your Jumia Vendor Centre for the latest rates.
        </p>
      </div>

      {/* Inputs */}
      <div className="rounded-2xl border bg-white p-6 space-y-5 shadow-sm">
        <h2 className="text-sm font-semibold text-zinc-700">Your listing details</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Category</Label>
            <Select value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a category" />
              </SelectTrigger>
              <SelectContent>
                {mockCategories.map((cat) => (
                  <SelectItem key={cat.id} value={cat.id}>
                    {cat.name} — {cat.commissionRate}%
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Selling price (GHS)</Label>
            <Input
              type="number"
              min="0"
              step="0.01"
              placeholder="e.g. 1299"
              value={sellingPrice}
              onChange={(e) => setSellingPrice(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Shipping mode</Label>
            <Select value={shippingMode} onValueChange={setShippingMode}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="je">Jumia Express (JE) – GHS 15 deduction</SelectItem>
                <SelectItem value="ds">Drop Shipping (DS) – no deduction</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {/* Result breakdown */}
      {result ? (
        <div className="rounded-2xl border bg-white shadow-sm overflow-hidden">
          <div className="bg-gradient-to-r from-blue-500 to-purple-600 px-6 py-4">
            <p className="text-xs font-medium text-blue-100">Estimated breakdown</p>
            <p className="mt-0.5 text-sm text-white font-semibold">
              {result.category} · {shippingMode.toUpperCase()}
            </p>
          </div>
          <div className="px-6 py-5 space-y-3">
            <div className="flex items-center justify-between py-2 border-b">
              <span className="text-sm text-zinc-600">Selling price</span>
              <span className="text-sm font-semibold text-zinc-900">
                {formatGHS(result.sellingPrice)}
              </span>
            </div>
            <div className="flex items-center justify-between py-2 border-b">
              <div>
                <span className="text-sm text-zinc-600">
                  Commission ({result.commissionRate}%)
                </span>
                <p className="text-xs text-zinc-400">{result.category}</p>
              </div>
              <span className="text-sm font-medium text-red-500">
                − {formatGHS(result.commissionAmount)}
              </span>
            </div>
            <div className="flex items-center justify-between py-2 border-b">
              <div>
                <span className="text-sm text-zinc-600">Shipping contribution</span>
                <p className="text-xs text-zinc-400">
                  {shippingMode === "je" ? "Jumia Express" : "Drop Shipping – none"}
                </p>
              </div>
              <span className="text-sm font-medium text-red-500">
                {result.shippingContrib > 0
                  ? `− ${formatGHS(result.shippingContrib)}`
                  : "GHS 0.00"}
              </span>
            </div>
            <div className="flex items-center justify-between pt-3">
              <div className="flex items-center gap-1.5">
                <TrendingDown className="h-4 w-4 text-emerald-500" />
                <span className="text-sm font-bold text-zinc-900">
                  Net payout to you
                </span>
              </div>
              <span
                className={
                  result.netPayout >= 0
                    ? "text-xl font-bold text-emerald-600"
                    : "text-xl font-bold text-red-500"
                }
              >
                {formatGHS(result.netPayout)}
              </span>
            </div>
            {result.netPayout < 0 && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
                ⚠️ At this price, fees exceed your selling price. Consider raising your price.
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed bg-zinc-50 py-16 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-zinc-100">
            <Calculator className="h-6 w-6 text-zinc-400" />
          </div>
          <p className="text-sm font-medium text-zinc-500">
            Select a category and enter a price to see your breakdown
          </p>
        </div>
      )}
    </div>
  );
}
