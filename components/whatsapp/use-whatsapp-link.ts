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
        window.open(data.waLink, "_blank", "noopener,noreferrer");
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
