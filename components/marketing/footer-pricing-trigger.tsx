"use client";

/**
 * Footer "Pricing" trigger for extension-flavored pages (/, /extension) —
 * opens the same credit-pack pricing card (BuyCreditsModal) as the hero
 * nav's own "Pricing" button, instead of MarketingFooter's default plain
 * link to /pricing (the classic web app's unrelated monthly-plan pricing).
 * See extension-hero-backdrop.tsx's own "Pricing" button for why these two
 * pricing models must never be conflated on this page.
 */

import { useState } from "react";
import { BuyCreditsModal } from "@/components/extension/buy-credits-modal";

export function FooterPricingTrigger({
  signedIn,
  signInHref,
}: {
  signedIn: boolean;
  signInHref: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="hover:text-zinc-900">
        Pricing
      </button>
      <BuyCreditsModal open={open} onClose={() => setOpen(false)} signedIn={signedIn} signInHref={signInHref} />
    </>
  );
}
