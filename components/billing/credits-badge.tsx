import { Coins, Crown, Sparkles, type LucideIcon } from "lucide-react";
import type { MyCredits } from "@/lib/actions/credits";
import { cn } from "@/lib/utils";

/**
 * Small pill with the seller's credit balance — the sidebar UserChip and
 * the Settings → Account header. Replaced the monthly-plan badge
 * (2026-09-28). "Admin · Unlimited" for admins, "Free · unlimited" while
 * billing is off, otherwise the balance.
 */
export function CreditsBadge({
  credits,
  size = "sm",
  className,
}: {
  credits: MyCredits;
  size?: "xs" | "sm";
  className?: string;
}) {
  const style: { Icon: LucideIcon; bg: string; text: string; label: string } = credits.isAdmin
    ? { Icon: Crown, bg: "bg-amber-50", text: "text-amber-600", label: "Admin · Unlimited" }
    : credits.unlimited
      ? { Icon: Sparkles, bg: "bg-zinc-100", text: "text-zinc-600", label: "Free · unlimited" }
      : {
          Icon:  Coins,
          bg:    "bg-orange-50",
          text:  "text-orange-600",
          label: `${credits.credits} credit${credits.credits === 1 ? "" : "s"}`,
        };
  const { Icon } = style;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full py-0.5 font-semibold",
        style.bg,
        style.text,
        size === "xs" ? "px-1.5 text-[10px]" : "px-2 text-[11px]",
        className,
      )}
    >
      <Icon className="h-2.5 w-2.5" />
      {style.label}
    </span>
  );
}
