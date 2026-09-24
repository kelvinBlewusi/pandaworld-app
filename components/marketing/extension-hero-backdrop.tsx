/**
 * Hero for /extension — plain white, no animation, no Donate button.
 *
 * Was a full-viewport near-black (#050505) canvas animation (a fan of
 * drifting "ribbons" with a travelling specular highlight, film-grain
 * overlay) with a "Donate" link in the nav next to Sign in. Both removed
 * by direct request 2026-09-24: the animated dark backdrop read heavy for
 * a first screen, and Donate didn't belong beside the primary auth
 * actions. Same copy, same layout shape (centred content, pill CTAs) —
 * just re-themed for a plain white background with dark, accessible text
 * instead of near-white-on-black.
 *
 * The top nav itself is HomeFloatingNav (a separate client component, for
 * its mobile hamburger state) — this component stays server-rendered,
 * nothing else here needs browser APIs.
 */

import Link from "next/link";
import { Space_Grotesk } from "next/font/google";
import { ArrowRight } from "lucide-react";
import { CHROME_WEB_STORE_URL } from "@/lib/constants/support";
import { HomeFloatingNav } from "@/components/marketing/home-floating-nav";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["300", "400", "500", "700"],
  display: "swap",
  variable: "--font-space-grotesk",
});

// text-orange-600 in Tailwind terms — darkened one step from the brand's
// bg-orange-500 (#f97316, used on buttons and the eyebrow dot) so inline
// text set in it clears WCAG AA's 4.5:1 body-text contrast against white;
// #f97316 itself only clears AA at large/bold sizes. Matches the
// text-orange-600 already used in this same page's "How it works" section.
const ACCENT_TEXT = "#ea580c";
// The solid fill used on the eyebrow dot and every button — safe at any
// size since it's never rendered as text on white.
const ACCENT_FILL = "#f97316";
// PandaWorld's own "Jumia orange" — matches extension/panel/panel.css's
// --accent. Used only on the word "Jumia"/"Vendor Center" so it reads as
// their brand, not ours. Fine at the headline's large/bold size; the two
// body-text uses below use ACCENT_TEXT instead for the same AA reason.
const JUMIA_COLOR = "#c2660a";

interface ExtensionHeroBackdropProps {
  signInHref: string;
  signUpHref: string;
  ctaHref: string;
  ctaLabel: string;
  calculatorHref: string;
}

export function ExtensionHeroBackdrop({ signInHref, signUpHref, ctaHref, ctaLabel, calculatorHref }: ExtensionHeroBackdropProps) {
  return (
    <section
      className={`${spaceGrotesk.variable} relative w-full bg-white`}
      style={{ fontFamily: "var(--font-space-grotesk), system-ui, sans-serif", color: "#1c1917" }}
    >
      <HomeFloatingNav signInHref={signInHref} signUpHref={signUpHref} calculatorHref={calculatorHref} />

      <div className="relative z-10 box-border px-5 pb-16 pt-10 sm:px-12 lg:px-24">
        <div className="flex items-center justify-center pt-16 text-center sm:pt-20">
          <div className="flex max-w-[760px] flex-col items-center">
            <div
              className="inline-flex items-center gap-2.5 rounded-full border px-3.5 py-[7px] text-[12px] uppercase tracking-[0.1em] text-zinc-600"
              style={{ borderColor: "#e7e5e4" }}
            >
              <span className="h-[5px] w-[5px] rounded-full" style={{ background: ACCENT_FILL }} />
              Chrome Extension &amp; WhatsApp
            </div>
            <h1
              className="mt-6 font-bold"
              style={{
                fontFamily: "var(--font-space-grotesk), system-ui, sans-serif",
                fontSize: "clamp(32px, 6vw, 72px)",
                lineHeight: 1.08,
                letterSpacing: "-0.02em",
                color: "#1c1917",
              }}
            >
              Automate your <span style={{ color: JUMIA_COLOR }}>Jumia</span> Listings with AI
            </h1>
            <p className="mt-6 max-w-[500px] text-balance text-[17px] font-light leading-relaxed text-zinc-600">
              PandaWorld&apos;s AI automates your Jumia listings and helps sellers spend less
              time listing products to{" "}
              <span style={{ color: JUMIA_COLOR, fontWeight: 500 }}>Jumia</span>. The listing
              tool works in two ways; the first is automating listings by uploading products
              on{" "}
              <Link
                href={signUpHref}
                className="font-medium transition-colors hover:text-orange-700"
                style={{ color: ACCENT_TEXT }}
              >
                WhatsApp
              </Link>{" "}
              and second, a dedicated{" "}
              <a
                href={CHROME_WEB_STORE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium transition-colors hover:text-orange-700"
                style={{ color: ACCENT_TEXT }}
              >
                Chrome extension
              </a>
              .
            </p>
            <div className="mt-9 flex w-full flex-col items-stretch gap-3 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center sm:justify-center sm:gap-3.5">
              <Link
                href={ctaHref}
                className="inline-flex items-center justify-center gap-2 rounded-full px-6 py-3.5 text-sm font-medium text-white transition-colors hover:bg-orange-600"
                style={{ background: ACCENT_FILL }}
              >
                {ctaLabel}
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href={signUpHref}
                className="inline-flex items-center justify-center gap-2 rounded-full border px-6 py-3.5 text-sm text-zinc-700 transition-colors hover:border-zinc-400 hover:bg-zinc-50"
                style={{ borderColor: "#e7e5e4" }}
              >
                List from WhatsApp
              </Link>
              <a
                href={CHROME_WEB_STORE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-2 rounded-full border px-6 py-3.5 text-sm text-zinc-700 transition-colors hover:border-zinc-400 hover:bg-zinc-50"
                style={{ borderColor: "#e7e5e4" }}
              >
                Add to Chrome
              </a>
              <a
                href="#how-it-works"
                className="inline-flex items-center justify-center gap-2 rounded-full border px-6 py-3.5 text-sm text-zinc-700 transition-colors hover:border-zinc-400 hover:bg-zinc-50"
                style={{ borderColor: "#e7e5e4" }}
              >
                See how it works
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
