"use client";

/**
 * Mounted on /extension/dashboard — detects the ?credits_ref= param Paystack
 * redirects back with after checkout (app/api/extension/credits/checkout's
 * callback_url), verifies + credits the purchase, then cleans the URL and
 * refreshes the page so the new balance shows up immediately. Renders
 * nothing. See app/api/extension/credits/verify/route.ts.
 */

import { useEffect, useRef } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";

export function CreditsPurchaseHandler() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const handled = useRef(false);

  useEffect(() => {
    const reference = searchParams.get("credits_ref");
    if (!reference || handled.current) return;
    handled.current = true;

    fetch(`/api/extension/credits/verify?reference=${encodeURIComponent(reference)}`)
      .finally(() => {
        router.replace(pathname);
        router.refresh();
      });
  }, [searchParams, router, pathname]);

  return null;
}
