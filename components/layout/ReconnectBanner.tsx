"use client";

/**
 * Persistent banner shown across every app page when the seller's Jumia
 * OAuth token can no longer be refreshed — almost always because they
 * deleted the OAuth Application from Vendor Center → Applications.
 *
 * On mount we PROACTIVELY ping /api/jumia/verify which hits Jumia /shops
 * with the seller's token to detect a dead OAuth in < 1 second. We don't
 * wait for them to click "Push to Jumia" and discover it's broken.
 *
 * Without reconnecting, no listings can be pushed, no categories synced,
 * no attribute schemas fetched. So this banner is loud and persistent
 * (cannot be dismissed) until the seller redoes the connect flow.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AlertCircle } from "lucide-react";

export function ReconnectBanner() {
  const pathname = usePathname();
  const router   = useRouter();
  const [needsReconnect, setNeedsReconnect] = useState(false);
  const [reason, setReason] = useState<string | null>(null);

  // Skip the check entirely on onboarding pages (would loop) and on auth pages
  const skipPath =
    pathname?.startsWith("/onboarding") ||
    pathname?.startsWith("/sign-in") ||
    pathname?.startsWith("/sign-up");

  useEffect(() => {
    if (skipPath) return;
    let cancelled = false;

    fetch("/api/jumia/verify")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.ok) {
          setNeedsReconnect(false);
          return;
        }
        setReason(d.reason ?? null);
        if (d.reason === "needs_reconnect") {
          setNeedsReconnect(true);
          // Strong nudge: after a short delay, auto-redirect to onboarding.
          // Banner remains visible until the redirect fires.
          setTimeout(() => {
            if (!cancelled && pathname !== "/onboarding/connect") {
              router.push("/onboarding/connect?reason=disconnected");
            }
          }, 4000);
        }
      })
      .catch(() => { /* fail closed — don't show banner if verify itself fails */ });

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, skipPath]);

  if (!needsReconnect) return null;

  return (
    <div className="bg-gradient-to-r from-red-500 to-rose-600 text-white shadow-md">
      <div className="mx-auto max-w-7xl px-4 py-2 flex items-center justify-between gap-3 text-xs sm:text-sm">
        <div className="flex items-center gap-2 min-w-0">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="font-semibold">Jumia connection broken</span>
          <span className="opacity-90 truncate hidden sm:inline">
            {reason === "needs_reconnect"
              ? "— your OAuth app was deleted or revoked in Vendor Center. Redirecting to reconnect…"
              : "— authorisation needed before you can push listings."}
          </span>
        </div>
        <Link
          href="/onboarding/connect?reason=disconnected"
          className="shrink-0 rounded-md bg-white/15 hover:bg-white/25 px-3 py-1 font-semibold transition-colors"
        >
          Reconnect now →
        </Link>
      </div>
    </div>
  );
}
