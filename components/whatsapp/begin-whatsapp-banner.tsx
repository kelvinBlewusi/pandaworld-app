"use client";

/**
 * The one-click entry point for a brand-new seller on
 * app/extension/(app)/whatsapp-listings — collapses WhatsAppCard's two
 * steps (generate a link code, then tap "Open WhatsApp") into one tap:
 * generate the code and open the wa.me link immediately. Shown only when
 * WhatsApp isn't connected yet (see the page's own connected/disconnected
 * branch) — once linked, the seller's next step is chat, not this page.
 */

import { WhatsAppIcon } from "@/components/whatsapp/whatsapp-icon";
import { Loader2, Copy } from "lucide-react";
import { useWhatsAppLink } from "@/components/whatsapp/use-whatsapp-link";

export function BeginWhatsAppBanner() {
  // Shared with the dashboard header's WhatsApp Bot button — see
  // useWhatsAppLink for why this isn't duplicated.
  const { loading, error, manualCode, open: handleClick } = useWhatsAppLink();

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={handleClick}
        disabled={loading}
        className="w-full rounded-2xl bg-gradient-to-r from-emerald-500 to-emerald-600 p-8 text-center text-white shadow-lg shadow-emerald-500/20 transition-colors hover:from-emerald-600 hover:to-emerald-700 disabled:opacity-70"
      >
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-white/20">
          {loading ? <Loader2 className="h-6 w-6 animate-spin" /> : <WhatsAppIcon className="h-6 w-6" />}
        </div>
        <p className="text-lg font-bold">Begin listing from WhatsApp</p>
        <p className="mt-1 text-sm text-emerald-50">
          {loading ? "Opening WhatsApp…" : "Tap to open WhatsApp — we'll connect your Jumia account right there in chat"}
        </p>
      </button>

      {manualCode && (
        <div className="rounded-xl border border-emerald-100 bg-emerald-50 p-4 text-center text-sm">
          <p className="text-emerald-700">Send this message to the PandaWorld bot number:</p>
          <div className="mt-2 flex items-center justify-center gap-2">
            <code className="rounded bg-emerald-100 px-2.5 py-1.5 font-mono text-sm text-emerald-900">
              LINK-{manualCode.code}
            </code>
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(manualCode.message)}
              className="flex items-center gap-1 text-xs text-emerald-700 hover:text-emerald-900"
            >
              <Copy className="h-3 w-3" />
              Copy message
            </button>
          </div>
          <p className="mt-1 text-xs text-emerald-500">This code expires in 15 minutes.</p>
        </div>
      )}
      {error && <p className="text-center text-sm text-red-600">{error}</p>}
    </div>
  );
}
