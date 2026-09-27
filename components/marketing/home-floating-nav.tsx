"use client";

/**
 * Floating pill nav bar for the homepage hero (extension-hero-backdrop.tsx)
 * — modeled on a reference screenshot the seller sent (2026-09-24, the
 * ListsGenie homepage): a rounded, bordered bar containing the logo, a row
 * of nav links, and Login/Get started, staying reachable via `sticky` as
 * the page scrolls past the hero. Kept on our own white background rather
 * than the reference's black one — the hero was deliberately re-themed
 * light on 2026-09-24 for feeling less heavy on a first screen; the pill
 * shape carries the "top bar" look on its own via its border + shadow.
 *
 * A client component (unlike the rest of the hero) because the mobile
 * breakpoint collapses everything but the logo behind a hamburger button,
 * which needs open/close state — same pattern as
 * components/extension/shell.tsx's mobile drawer toggle.
 */

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { Inter_Tight } from "next/font/google";
import { Menu, X } from "lucide-react";

const inter = Inter_Tight({ subsets: ["latin"], weight: ["800"], display: "swap" });

// Matches extension-hero-backdrop.tsx's own ACCENT_FILL — the brand's
// orange used on every solid button. Duplicated rather than imported to
// keep this nav a standalone component; it's one hex value.
const ACCENT_FILL = "#f97316";

interface HomeFloatingNavProps {
  signInHref: string;
  signUpHref: string;
  calculatorHref: string;
}

export function HomeFloatingNav({ signInHref, signUpHref, calculatorHref }: HomeFloatingNavProps) {
  const [open, setOpen] = useState(false);

  const links: { href: string; label: string; disabled?: boolean }[] = [
    // Absolute path (not a bare "#how-it-works" fragment) — this nav is no
    // longer only rendered on the homepage (see app/how-to/page.tsx), and a
    // bare fragment resolves against whatever page it's clicked from.
    { href: "/#how-it-works", label: "How it Works" },
    { href: "/how-to", label: "Guides" },
    // Greyed out + non-clickable: /pricing shows the paid monthly tiers,
    // which don't apply while FREE_FOR_ALL_MODE is on (see
    // lib/billing/free-for-all.ts) — keeping it visible but disabled here
    // signals "coming later" rather than linking somewhere misleading.
    { href: "/pricing", label: "Pricing", disabled: true },
    { href: calculatorHref, label: "Jumia Pricing Calculator" },
  ];

  return (
    <div className="sticky top-3 z-30 px-4 sm:top-4 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 rounded-full border border-zinc-200 bg-white/95 px-4 py-2.5 shadow-[0_2px_24px_rgba(0,0,0,0.07)] backdrop-blur sm:px-5">
        <Link href="/extension" aria-label="pandaworld home" className="inline-flex shrink-0 items-center">
          <Image
            src="/brand/panda-p-logo-trimmed.png"
            alt=""
            width={634}
            height={562}
            className="h-7 w-auto"
            priority
          />
          <span className={`${inter.className} -ml-0.5 text-[21px] font-extrabold tracking-tight text-zinc-900`}>
            andaworld
          </span>
        </Link>

        <nav className="hidden items-center gap-6 text-base font-medium text-zinc-600 lg:flex">
          {links.map((link) =>
            link.disabled ? (
              <span
                key={link.label}
                className="cursor-not-allowed whitespace-nowrap text-zinc-300"
                aria-disabled="true"
                title="Coming soon"
              >
                {link.label}
              </span>
            ) : (
              <Link
                key={link.label}
                href={link.href}
                className="whitespace-nowrap transition-colors hover:text-zinc-900"
              >
                {link.label}
              </Link>
            )
          )}
        </nav>

        <div className="hidden items-center gap-1 lg:flex">
          <Link
            href={signInHref}
            className="whitespace-nowrap rounded-full px-4 py-2 text-base font-medium text-zinc-600 transition-colors hover:bg-zinc-100"
          >
            Login
          </Link>
          <Link
            href={signUpHref}
            className="whitespace-nowrap rounded-full px-4 py-2 text-base font-semibold text-white transition-colors hover:bg-orange-600"
            style={{ background: ACCENT_FILL }}
          >
            Get started
          </Link>
        </div>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-zinc-600 transition-colors hover:bg-zinc-100 lg:hidden"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {open && (
        <div className="mx-auto mt-2 max-w-5xl rounded-2xl border border-zinc-200 bg-white p-3 shadow-lg lg:hidden">
          <nav className="flex flex-col gap-1 text-base font-medium text-zinc-700">
            {links.map((link) =>
              link.disabled ? (
                <span
                  key={link.label}
                  className="cursor-not-allowed rounded-lg px-3 py-2.5 text-zinc-300"
                  aria-disabled="true"
                  title="Coming soon"
                >
                  {link.label}
                </span>
              ) : (
                <Link
                  key={link.label}
                  href={link.href}
                  onClick={() => setOpen(false)}
                  className="rounded-lg px-3 py-2.5 transition-colors hover:bg-zinc-50"
                >
                  {link.label}
                </Link>
              )
            )}
          </nav>
          <div className="mt-2 flex flex-col gap-2 border-t border-zinc-100 pt-3">
            <Link
              href={signInHref}
              onClick={() => setOpen(false)}
              className="rounded-full border border-zinc-200 px-4 py-2.5 text-center text-base font-medium text-zinc-700 transition-colors hover:bg-zinc-50"
            >
              Login
            </Link>
            <Link
              href={signUpHref}
              onClick={() => setOpen(false)}
              className="rounded-full px-4 py-2.5 text-center text-base font-semibold text-white transition-colors hover:bg-orange-600"
              style={{ background: ACCENT_FILL }}
            >
              Get started
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
