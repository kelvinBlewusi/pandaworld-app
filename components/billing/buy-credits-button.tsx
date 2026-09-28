"use client";

import { useState } from "react";
import { BuyCreditsModal } from "@/components/extension/buy-credits-modal";
import { cn } from "@/lib/utils";

/** "Buy credits" button + the Paystack pack picker, for server-rendered pages. */
export function BuyCreditsButton({ className, label = "Buy credits" }: { className?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "rounded-full bg-orange-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-orange-600",
          className,
        )}
      >
        {label}
      </button>
      <BuyCreditsModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}
