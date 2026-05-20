import Link from "next/link";
import { Wordmark } from "./wordmark";

/**
 * Shared footer for public marketing pages (/, /pricing, /terms,
 * /privacy). Lives outside app/page.tsx because Next.js refuses to
 * tree-shake non-default exports from page files.
 *
 * Skinny by design: wordmark + tagline + the four legal/info links
 * Google indexes. No social handles, no newsletter yet — add them
 * when we actually have content to point at.
 */

export function MarketingFooter() {
  return (
    <footer className="border-t border-zinc-100 bg-zinc-50">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-8 sm:flex-row">
        <div className="flex items-center gap-3 text-sm text-zinc-500">
          <Wordmark size={20} />
          <span>· Built for Jumia sellers</span>
        </div>
        <div className="flex items-center gap-4 text-xs text-zinc-500">
          <Link href="/pricing" className="hover:text-zinc-900">
            Pricing
          </Link>
          <Link href="/terms" className="hover:text-zinc-900">
            Terms
          </Link>
          <Link href="/privacy" className="hover:text-zinc-900">
            Privacy
          </Link>
          <a
            href="https://vendorcenter.jumia.com"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-zinc-900"
          >
            Vendor Center ↗
          </a>
        </div>
      </div>
    </footer>
  );
}
