"use client";

/**
 * Footer "Donate" trigger for the homepage and Guides while billing is off
 * (lib/billing/mode.ts) — opens the same support-donation card
 * (DonateModal) instead of MarketingFooter's plain link to /pricing, since
 * nothing is being charged yet.
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
