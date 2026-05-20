import Link from "next/link";
import { Mail, Users } from "lucide-react";
import { Wordmark } from "./wordmark";
import { SUPPORT_EMAIL, SUPPORT_MAILTO, COMMUNITY_WHATSAPP_URL } from "@/lib/constants/support";

/**
 * Shared footer for public marketing pages (/, /pricing, /terms,
 * /privacy). Lives outside app/page.tsx because Next.js refuses to
 * tree-shake non-default exports from page files.
 *
 * Skinny by design: wordmark + tagline + contact channels. Terms and
 * Privacy are placeholders for now — links render as visible but
 * non-responsive text so the seller sees we intend to ship them
 * (and a future legal review is acknowledged) without anyone being
 * able to navigate to drafts that haven't been lawyer-reviewed yet.
 */

export function MarketingFooter() {
  return (
    <footer className="border-t border-zinc-100 bg-zinc-50">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-6 px-6 py-10 sm:flex-row">
        <div className="flex flex-col items-center gap-2 text-sm text-zinc-500 sm:flex-row">
          <Wordmark size={20} />
          <span className="sm:before:content-['·_']">Built for Jumia sellers</span>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-zinc-500">
          <Link href="/pricing" className="hover:text-zinc-900">
            Pricing
          </Link>

          {/* Terms + Privacy — intentionally non-responsive for now.
              Pages exist as drafts at /terms + /privacy but they need
              a Ghana-qualified lawyer review before we send sellers
              to them. Styled as disabled text so visitors see the
              intent (and screen readers get a note), no click does
              anything. */}
          <span
            className="cursor-not-allowed text-zinc-300"
            aria-disabled="true"
            title="Coming soon"
          >
            Terms
          </span>
          <span
            className="cursor-not-allowed text-zinc-300"
            aria-disabled="true"
            title="Coming soon"
          >
            Privacy
          </span>

          <a
            href={SUPPORT_MAILTO}
            className="inline-flex items-center gap-1.5 hover:text-zinc-900"
          >
            <Mail className="h-3 w-3" />
            {SUPPORT_EMAIL}
          </a>

          <a
            href={COMMUNITY_WHATSAPP_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 font-medium text-emerald-700 transition-colors hover:bg-emerald-100"
          >
            <Users className="h-3 w-3" />
            Join our community
          </a>
        </div>
      </div>
    </footer>
  );
}
