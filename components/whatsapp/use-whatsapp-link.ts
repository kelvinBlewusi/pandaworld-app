"use client";

import { useState } from "react";

/**
 * Generate a one-time link code and open the bot chat with it pre-filled.
 *
 * Extracted from BeginWhatsAppBanner so the dashboard header button and
 * that banner run the SAME flow. Two copies of "connect WhatsApp" would
 * drift the moment either changed, and this one has enough edge cases —
 * an unconfigured bot number, a rate limit, a network failure — that the
 * second copy would inevitably handle fewer of them than the first.
 */
export interface WhatsAppLinkState {
  loading: boolean;
  error: string | null;
  /**
   * Set only when the code was generated but WHATSAPP_BOT_NUMBER isn't
   * configured, so there's no wa.me link to open. Not an error — the code
   * is real and the seller can send it manually.
   */
  manualCode: { code: string; message: string } | null;
  open: () => Promise<void>;
  reset: () => void;
}

/**
 * Open the bot chat, surviving a popup blocker.
 *
 * WHY THIS IS NOT JUST window.open: the link code is minted by an awaited
 * fetch, so by the time we have a URL the browser no longer considers this
 * a user gesture. Safari — iOS Safari in particular — blocks a
 * window.open() that isn't inside a direct gesture handler, and it blocks
 * it SILENTLY: no error, no prompt, the tap simply does nothing.
 *
 * Reported on 2026-09-15: both dashboard buttons did nothing on a seller's
 * test phone while working on the developer's own, and the Settings page
 * button worked everywhere. Settings is the tell — it renders the wa.me
 * URL as a real <a href> that the seller taps directly, so there is no
 * async gap and nothing to block.
 *
 * Navigating the CURRENT tab is never popup-blocked, so that is the
 * fallback. It is only a fallback because on desktop a new tab is nicer —
 * the seller keeps the dashboard they were on.
 *
 * Note the missing "noopener": with it, window.open returns null even on
 * SUCCESS in browsers that implement the spec, which would make the
 * blocked-check fire every time and always navigate away. The opener is
 * severed on the handle instead, which gets the same protection with a
 * usable return value.
 */
function openWhatsApp(url: string): void {
  let opened: Window | null = null;
  try {
    opened = window.open(url, "_blank");
  } catch {
    opened = null;
  }

  if (opened) {
    // Same protection "noopener" would have given, applied after the fact.
    try { opened.opener = null; } catch { /* cross-origin — already severed */ }
    return;
  }

  window.location.href = url;
}

export function useWhatsAppLink(): WhatsAppLinkState {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualCode, setManualCode] = useState<{ code: string; message: string } | null>(null);

  async function open() {
    setLoading(true);
    setError(null);
    setManualCode(null);
    try {
      const res = await fetch("/api/whatsapp/generate-link", { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? `Couldn't generate a link (HTTP ${res.status}). Try again.`);
        return;
      }
      if (data?.waLink) {
        openWhatsApp(data.waLink);
      } else if (data?.code) {
        setManualCode({ code: data.code, message: data.message ?? `LINK-${data.code}` });
      } else {
        setError("Couldn't generate a link — try again.");
      }
    } catch {
      setError("Network error — check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  return {
    loading,
    error,
    manualCode,
    open,
    reset: () => { setError(null); setManualCode(null); },
  };
}
