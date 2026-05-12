"use client";

/**
 * Persistent banner shown across every app page when the seller's Jumia
 * OAuth token can no longer be refreshed — almost always because they
 * deleted the OAuth Application from Vendor Center → Applications.
 *
 * Without reconnecting, no listings can be pushed, no categories synced,
 * no attribute schemas fetched. So this banner is loud and persistent
 * (cannot be dismissed) until the seller redoes the connect flow.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertCircle } from "lucide-react";

export function ReconnectBanner() {
  const [needsReconnect, setNeedsReconnect] = useState(false);

  useEffect(() => {
    fetch("/api/jumia/status")
      .then((r) => r.json())
      .then((d) => setNeedsReconnect(Boolean(d.needs_reconnect)))
      .catch(() => setNeedsReconnect(false));
  }, []);

  if (!needsReconnect) return null;

  return (
    <div className="bg-gradient-to-r from-red-500 to-rose-600 text-white shadow-md">
      <div className="mx-auto max-w-7xl px-4 py-2 flex items-center justify-between gap-3 text-xs sm:text-sm">
        <div className="flex items-center gap-2 min-w-0">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="font-semibold">Jumia connection broken</span>
          <span className="opacity-90 truncate hidden sm:inline">
            — your OAuth app was likely deleted from Vendor Center → Applications. Reconnect to keep pushing listings.
          </span>
        </div>
        <Link
          href="/onboarding/connect"
          className="shrink-0 rounded-md bg-white/15 hover:bg-white/25 px-3 py-1 font-semibold transition-colors"
        >
          Reconnect →
        </Link>
      </div>
    </div>
  );
}
