import Link from "next/link";
import { Mail, Users } from "lucide-react";
import { Wordmark } from "./wordmark";
import { JumiaPandaWorldPuzzle } from "./jumia-pandaworld-puzzle";
import { FooterPricingTrigger } from "./footer-pricing-trigger";
import { CALCULATOR_HREF, COMMISSION_RATES_HREF } from "@/lib/marketing/links";
import {
  SUPPORT_EMAIL,
  SUPPORT_MAILTO,
  COMMUNITY_WHATSAPP_URL,
  SOCIAL_LINKS,
} from "@/lib/constants/support";

// Lightweight inline X (Twitter) + Instagram glyphs — the lucide-react
// `Twitter` icon still ships the bird; we want the X mark. No new dep.
function XIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 1200 1227" aria-hidden="true" className={className} fill="currentColor">
      <path d="M714.163 519.284 1160.89 0H1055.03L667.137 450.887 357.328 0H0L468.492 681.821 0 1226.37H105.866L515.491 750.218 842.672 1226.37H1200L714.137 519.284h.026ZM569.165 687.828l-47.468-67.894-377.7-540.24h162.604l304.797 435.991 47.468 67.894 396.2 566.721H892.476L569.165 687.854v-.026Z"/>
    </svg>
  );
}

function InstagramIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="currentColor">
      <path d="M12 2.163c3.204 0 3.584.012 4.85.07 1.366.062 2.633.336 3.608 1.311.975.975 1.249 2.242 1.311 3.608.058 1.266.069 1.646.069 4.85s-.012 3.584-.07 4.85c-.062 1.366-.336 2.633-1.311 3.608-.975.975-2.242 1.249-3.608 1.311-1.266.058-1.646.07-4.85.07s-3.584-.012-4.85-.07c-1.366-.062-2.633-.336-3.608-1.311-.975-.975-1.249-2.242-1.311-3.608C2.175 15.747 2.163 15.367 2.163 12s.012-3.584.07-4.85c.062-1.366.336-2.633 1.311-3.608.975-.975 2.242-1.249 3.608-1.311C8.416 2.175 8.796 2.163 12 2.163ZM12 0C8.741 0 8.332.014 7.052.072 5.776.13 4.904.333 4.14.63a5.876 5.876 0 0 0-2.126 1.384A5.876 5.876 0 0 0 .63 4.14C.333 4.904.131 5.776.072 7.052.014 8.332 0 8.741 0 12s.014 3.668.072 4.948c.058 1.276.261 2.148.558 2.912.305.789.717 1.459 1.384 2.126.667.667 1.337 1.079 2.126 1.384.764.297 1.636.499 2.912.558C8.332 23.986 8.741 24 12 24s3.668-.014 4.948-.072c1.276-.058 2.148-.261 2.912-.558a5.876 5.876 0 0 0 2.126-1.384 5.876 5.876 0 0 0 1.384-2.126c.297-.764.499-1.636.558-2.912C23.986 15.668 24 15.259 24 12s-.014-3.668-.072-4.948c-.058-1.276-.261-2.148-.558-2.912a5.876 5.876 0 0 0-1.384-2.126A5.876 5.876 0 0 0 19.86.63c-.764-.297-1.636-.499-2.912-.558C15.668.014 15.259 0 12 0Zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324ZM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881Z"/>
    </svg>
  );
}

const SOCIAL_ICON_MAP: Record<string, (p: { className?: string }) => JSX.Element> = {
  "X (Twitter)": XIcon,
  "Instagram":   InstagramIcon,
};

/**
 * Shared footer for public marketing pages (/, /pricing, /terms,
 * /privacy, the guides and tools). Lives outside app/page.tsx because
 * Next.js refuses to tree-shake non-default exports from page files.
 *
 * Laid out as a brand column (wordmark, one-line tagline, community and
 * social links) and three labelled link columns, over a bottom bar with
 * the copyright and the legal links. Redesigned 2026-10-01: it was one
 * row of eleven items whose tagline wrapped onto three lines.
 *
 * Terms and Privacy are linked since 2026-10-01, when the owner published
 * them as written (they were held back pending a lawyer's review).
 */

const linkClass = "text-sm text-zinc-600 transition-colors hover:text-zinc-900";

function FooterColumn({
  title,
  className,
  children,
}: {
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <p className="text-xs font-semibold uppercase tracking-wider text-zinc-900">{title}</p>
      <ul className="mt-4 space-y-3">{children}</ul>
    </div>
  );
}

export function MarketingFooter({
  extensionPricing,
}: {
  /**
   * Set on the homepage and Guides while billing is off, where the footer
   * offers a Donate card instead of a Pricing link (nothing is charged
   * yet). Omitted once billing is on, and on every other page, for the
   * plain link to /pricing.
   */
  extensionPricing?: { signedIn: boolean; signInHref: string };
} = {}) {
  return (
    <footer className="border-t border-zinc-200 bg-zinc-50">
      <div className="mx-auto max-w-6xl px-6 py-12">
        {/* Phones: brand, then Product beside Tools, then Support on its
            own row so the email address never breaks mid-word. Tablets:
            brand above three columns. Desktop: all four in one row. */}
        <div className="grid grid-cols-2 gap-x-8 gap-y-10 md:grid-cols-[0.8fr_1fr_1.2fr] lg:grid-cols-[1.4fr_0.8fr_1.1fr_1.3fr]">
          {/* Brand */}
          <div className="col-span-2 md:col-span-3 lg:col-span-1">
            <Wordmark size={22} />
            <p className="mt-3 max-w-xs text-sm leading-relaxed text-zinc-500">
              Built for Jumia sellers. List products from WhatsApp or the Chrome extension.
            </p>
            <div className="mt-5 flex items-center gap-2">
              <a
                href={COMMUNITY_WHATSAPP_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-100"
              >
                <Users className="h-3.5 w-3.5" />
                Join our community
              </a>
              {/* Social channels — driven by SOCIAL_LINKS in
                  lib/constants/support.ts so JSON-LD `sameAs`, the footer
                  and any other surface stay in sync from one source. The
                  icon map above gates which glyph renders. */}
              {SOCIAL_LINKS.map((s) => {
                const Icon = SOCIAL_ICON_MAP[s.name];
                if (!Icon) return null;
                return (
                  <a
                    key={s.url}
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Follow PandaWorld on ${s.name}`}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-zinc-200 hover:text-zinc-900"
                    title={`${s.name} — ${s.handle}`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </a>
                );
              })}
            </div>
            {/* Jumia and PandaWorld as two puzzle pieces (owner's request,
                2026-10-05), with the line that keeps it from reading as a
                Jumia partnership. */}
            <JumiaPandaWorldPuzzle className="mt-6 block h-auto w-56" />
            <p className="mt-2 max-w-sm text-[11px] leading-snug text-zinc-400">
              An independent tool for Jumia sellers, not run or endorsed by Jumia.
            </p>
          </div>

          <FooterColumn title="Product">
            <li>
              {extensionPricing ? (
                <span className={linkClass}>
                  <FooterPricingTrigger signedIn={extensionPricing.signedIn} signInHref={extensionPricing.signInHref} />
                </span>
              ) : (
                <Link href="/pricing" className={linkClass}>Pricing</Link>
              )}
            </li>
            <li><Link href="/how-to" className={linkClass}>Guides</Link></li>
            <li><Link href="/faq" className={linkClass}>FAQ</Link></li>
          </FooterColumn>

          {/* Crawlable links to the public guides and tools on every
              marketing page, so search engines reach them from anywhere. */}
          <FooterColumn title="Tools for sellers">
            {/* A plain <a>: /calculator redirects to the visitor's own
                country's calculator, which next/link would prefetch and
                lose the #calculator fragment of. */}
            <li><a href={CALCULATOR_HREF} className={linkClass}>Jumia price calculator</a></li>
            <li><Link href={COMMISSION_RATES_HREF} className={linkClass}>Jumia commission rates</Link></li>
            <li><Link href="/sell-on-jumia" className={linkClass}>Sell on Jumia by country</Link></li>
          </FooterColumn>

          <FooterColumn title="Support" className="col-span-2 md:col-span-1">
            <li>
              <a href={SUPPORT_MAILTO} className={`${linkClass} inline-flex items-center gap-1.5 [overflow-wrap:anywhere]`}>
                <Mail className="h-3.5 w-3.5 shrink-0" />
                {SUPPORT_EMAIL}
              </a>
            </li>
            <li>
              <a href={COMMUNITY_WHATSAPP_URL} target="_blank" rel="noopener noreferrer" className={linkClass}>
                WhatsApp community
              </a>
            </li>
          </FooterColumn>
        </div>

        <div className="mt-10 flex flex-col-reverse items-center justify-between gap-3 border-t border-zinc-200 pt-6 text-xs text-zinc-500 sm:flex-row">
          <p>© {new Date().getFullYear()} PandaWorld</p>
          <div className="flex items-center gap-5">
            <Link href="/terms" className="transition-colors hover:text-zinc-900">Terms</Link>
            <Link href="/privacy" className="transition-colors hover:text-zinc-900">Privacy</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
