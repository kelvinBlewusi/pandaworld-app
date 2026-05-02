import { cn } from "@/lib/utils";
import type { Marketplace } from "@/lib/mock/listings";

const config: Record<Marketplace, { label: string; className: string; emoji: string }> = {
  jumia: {
    label: "Jumia",
    className: "bg-orange-50 text-orange-600 border-orange-200",
    emoji: "🛒",
  },
  shopify: {
    label: "Shopify",
    className: "bg-green-50 text-green-700 border-green-200",
    emoji: "🏪",
  },
  ebay: {
    label: "eBay",
    className: "bg-blue-50 text-blue-600 border-blue-200",
    emoji: "🔵",
  },
  amazon: {
    label: "Amazon",
    className: "bg-yellow-50 text-yellow-700 border-yellow-200",
    emoji: "📦",
  },
};

interface MarketplaceBadgeProps {
  marketplace: Marketplace;
  className?: string;
}

export function MarketplaceBadge({ marketplace, className }: MarketplaceBadgeProps) {
  const cfg = config[marketplace];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium",
        cfg.className,
        className
      )}
    >
      {cfg.emoji} {cfg.label}
    </span>
  );
}
