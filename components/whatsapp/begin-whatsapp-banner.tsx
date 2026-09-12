"use client";

/**
 * The one-click entry point for a brand-new seller on
 * app/extension/(app)/whatsapp-listings — collapses WhatsAppCard's two
 * steps (generate a link code, then tap "Open WhatsApp") into one tap:
 * generate the code and open the wa.me link immediately. Shown only when
 * WhatsApp isn't connected yet (see the page's own connected/disconnected
 * branch) — once linked, the seller's next step is chat, not this page.
 */

import { useState } from "react";
import { Loader2, MessageCircle, Copy } from "lucide-react";

export function BeginWhatsAppBanner() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set only when the code was generated but WHATSAPP_BOT_NUMBER isn't
  // configured (so there's no wa.me link to open automatically) — same
  // degraded case WhatsAppCard handles by showing the code as text
  // instead of a button. Not an error: the code is real and usable.
  const [manualCode, setManualCode] = useState<string | null>(null);

  async function handleClick() {
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
        setManualCode(data.code);
      } else {
        setError("Couldn't generate a link — try again.");
      }
    } catch {
      setError("Network error — check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={handleClick}
        disabled={loading}
        className="w-full rounded-2xl bg-gradient-to-r from-emerald-500 to-emerald-600 p-8 text-center text-white shadow-lg shadow-emerald-500/20 transition-colors hover:from-emerald-600 hover:to-emerald-700 disabled:opacity-70"
      >
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-white/20">
          {loading ? <Loader2 className="h-6 w-6 animate-spin" /> : <MessageCircle className="h-6 w-6" />}
        </div>
        <p className="text-lg font-bold">Begin listing from WhatsApp</p>
        <p className="mt-1 text-sm text-emerald-50">
          {loading ? "Opening WhatsApp…" : "Tap to open WhatsApp — we'll connect your Jumia account right there in chat"}
        </p>
      </button>

      {manualCode && (
        <div className="rounded-xl border border-emerald-100 bg-emerald-50 p-4 text-center text-sm">
          <p className="text-emerald-700">Send this code as a WhatsApp message to the PandaWorld bot number:</p>
          <div className="mt-2 flex items-center justify-center gap-2">
            <code className="rounded bg-emerald-100 px-2.5 py-1.5 font-mono text-sm text-emerald-900">
              LINK-{manualCode}
            </code>
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(`LINK-${manualCode}`)}
              className="flex items-center gap-1 text-xs text-emerald-700 hover:text-emerald-900"
            >
              <Copy className="h-3 w-3" />
              Copy
            </button>
          </div>
          <p className="mt-1 text-xs text-emerald-500">This code expires in 15 minutes.</p>
        </div>
      )}
      {error && <p className="text-center text-sm text-red-600">{error}</p>}
    </div>
  );
}
