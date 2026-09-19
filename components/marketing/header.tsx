import Link from "next/link";
import { Wordmark } from "./wordmark";
import { MarketingButton } from "./button";
import { LINE, MUTED } from "./palette";

/** Shared header for the public marketing pages — wordmark, Pricing, Sign
 *  in, and one primary CTA. Left-aligned, no pill nav, single accent. */
export function MarketingHeader({
  ctaHref,
  ctaLabel,
  signInHref = "/sign-in",
}: {
  ctaHref: string;
  ctaLabel: string;
  signInHref?: string;
}) {
  return (
    <header className="border-b" style={{ borderColor: LINE }}>
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-5">
        <Link href="/" aria-label="PandaWorld home">
          <Wordmark size={24} />
        </Link>
        <nav className="flex items-center gap-5 text-sm font-medium">
          <Link href="/pricing" className="hover:opacity-70" style={{ color: MUTED }}>
            Pricing
          </Link>
          <Link href={signInHref} className="hover:opacity-70" style={{ color: MUTED }}>
            Sign in
          </Link>
          <MarketingButton href={ctaHref}>{ctaLabel}</MarketingButton>
        </nav>
      </div>
    </header>
  );
}
