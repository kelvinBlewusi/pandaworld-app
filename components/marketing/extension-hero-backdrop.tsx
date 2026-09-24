/**
 * Hero for /extension — plain white, no animation, no Donate button.
 *
 * Was a full-viewport near-black (#050505) canvas animation (a fan of
 * drifting "ribbons" with a travelling specular highlight, film-grain
 * overlay) with a "Donate" link in the nav next to Sign in. Both removed
 * by direct request 2026-09-24: the animated dark backdrop read heavy for
 * a first screen, and Donate didn't belong beside the primary auth
 * actions. Same copy, same layout shape (centred content, pill nav, pill
 * CTAs) — just re-themed for a plain white background with dark,
 * accessible text instead of near-white-on-black.
 *
 * Not a client component any more either — nothing here needs browser
 * APIs now that the canvas is gone, so this renders on the server like
 * the rest of the page around it.
 */

import Link from "next/link";
import Image from "next/image";
import { Space_Grotesk, Inter } from "next/font/google";
import { ArrowRight } from "lucide-react";
import { CHROME_WEB_STORE_URL } from "@/lib/constants/support";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["300", "400", "500", "700"],
  display: "swap",
  variable: "--font-space-grotesk",
});

// Matches components/marketing/wordmark.tsx's own Inter 800 — the
// lettering weight used everywhere else "pandaworld" is spelled out, so
// this reads as the same brand mark, just with the real logo standing in
// for the "P" instead of a plain letterform.
const inter = Inter({ subsets: ["latin"], weight: ["800"], display: "swap" });

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
}

export function ExtensionHeroBackdrop({ signInHref, signUpHref, ctaHref, ctaLabel }: ExtensionHeroBackdropProps) {
  return (
    <section
      className={`${spaceGrotesk.variable} relative w-full bg-white`}
      style={{ fontFamily: "var(--font-space-grotesk), system-ui, sans-serif", color: "#1c1917" }}
    >
      <div className="relative z-10 box-border px-5 pb-16 pt-10 sm:px-12 lg:px-24">
        <header className="flex flex-wrap items-center justify-between gap-4 sm:gap-8">
          <Link href="/extension" aria-label="pandaworld home" className="inline-flex items-center">
            <Image
              src="/brand/panda-p-logo-trimmed.png"
              alt=""
              width={634}
              height={562}
              className="h-8 w-auto"
              priority
            />
            <span className={`${inter.className} -ml-0.5 text-[26px] font-extrabold tracking-tight text-zinc-900`}>
              andaworld
            </span>
          </Link>
          <nav className="flex items-center gap-2 text-[12px] uppercase tracking-[0.08em] sm:gap-3 sm:text-[13px]">
            <Link
              href={signInHref}
              className="whitespace-nowrap rounded-full px-3 py-2 text-zinc-700 transition-colors hover:bg-zinc-100 sm:px-4"
              style={{ border: "1px solid #e7e5e4" }}
            >
              Sign in
            </Link>
            <Link
              href={signUpHref}
              className="whitespace-nowrap rounded-full px-3 py-2 font-medium normal-case tracking-normal text-white transition-colors hover:bg-orange-600 sm:px-4"
              style={{ background: ACCENT_FILL }}
            >
              Get Started
            </Link>
          </nav>
        </header>

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
