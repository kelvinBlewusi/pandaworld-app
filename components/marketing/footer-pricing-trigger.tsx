"use client";

/**
 * Footer "Donate" trigger for extension-flavored pages (/, /extension) —
 * opens the same support-donation card (DonateModal) as the hero nav's
 * own "Donate" button, instead of MarketingFooter's default plain link
 * to /pricing (the classic web app's unrelated monthly-plan pricing).
 * See extension-hero-backdrop.tsx's own "Donate" button for why these
 * must never be conflated on this page. Stands in for the old "Pricing"
 * trigger (BuyCreditsModal) while WhatsApp + the extension are free —
 * see lib/billing/free-for-all.ts.
 */

import { useState } from "react";
import { DonateModal } from "@/components/extension/donate-modal";

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
        Donate
      </button>
      <DonateModal open={open} onClose={() => setOpen(false)} signedIn={signedIn} signInHref={signInHref} />
    </>
  );
}
