"use client";

import { Loader2 } from "lucide-react";
import { WhatsAppIcon } from "@/components/whatsapp/whatsapp-icon";
import { useWhatsAppLink } from "@/components/whatsapp/use-whatsapp-link";

/**
 * "WhatsApp Bot" in the dashboard header, beside Install Extension.
 *
 * The two products, side by side, at the one place every signed-in seller
 * passes through. Connecting WhatsApp was previously reachable only from
 * Settings or the whatsapp-listings page — findable if you already knew
 * it existed, which is the wrong bar for the half of the product a seller
 * hasn't tried yet.
 *
 * Runs the same flow as Settings (useWhatsAppLink): mint a one-time code
 * and open the bot chat with it pre-filled, so linking is one tap rather
 * than copy-a-code-then-find-WhatsApp.
 *
 * Green, where Install Extension is black. They are different products
 * and a seller should be able to tell them apart at a glance rather than
 * by reading two similar pills.
 */
export function WhatsAppBotButton() {
  const { loading, error, manualCode, open } = useWhatsAppLink();

  return (
    <div className="relative">
      <button
        type="button"
        onClick={open}
        disabled={loading}
        className="flex items-center gap-2 rounded-full bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 disabled:opacity-70"
      >
        {loading
          ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
          : <WhatsAppIcon className="h-4 w-4 shrink-0" />}
        WhatsApp Bot
      </button>

      {/* Anchored to the button rather than pushing the header around —
          the header is a fixed-height row and a message inline would
          shove Install Extension sideways mid-tap. */}
      {(error || manualCode) && (
        <div className="absolute right-0 top-full z-50 mt-2 w-72 rounded-xl border border-zinc-200 bg-white p-3 shadow-lg">
          {error ? (
            <p className="text-xs text-red-600">{error}</p>
          ) : (
            <>
              {/* The bot number isn't configured, so there's no chat to
                  open — but the code is real. Showing it beats failing. */}
              <p className="text-xs text-zinc-600">
                Send this to the PandaWorld bot on WhatsApp:
              </p>
              <code className="mt-1.5 block select-all rounded-lg bg-zinc-50 px-2 py-1.5 text-sm font-semibold text-zinc-900">
                {manualCode!.message}
              </code>
            </>
          )}
        </div>
      )}
    </div>
  );
}
