import Link from "next/link";
import {
  Chrome,
  KeyRound,
  UploadCloud,
  Wand2,
  ArrowRight,
} from "lucide-react";
import { auth } from "@clerk/nextjs/server";
import { MarketingFooter } from "@/components/marketing/footer";
import { ExtensionHeroBackdrop } from "@/components/marketing/extension-hero-backdrop";

// ─── /extension — public page for the Chrome extension flow ──────────────────
//
// Lives outside the (main) layout so logged-out visitors can read about the
// browser extension without bouncing through Clerk. Mirrors the structure of
// app/pricing/page.tsx (local MarketingNav + shared MarketingFooter) so the
// marketing surface stays consistent.
//
// The extension autofills the Jumia Vendor Center "Add Products" form from a
// product photo using PandaWorld's AI. Auth is a PandaWorld-issued API key the
// seller generates in the dashboard (see docs/chrome-extension-plan.md §9).

export const metadata: import("next").Metadata = {
  title:       "Chrome Extension — Autofill Jumia Listings",
  description:
    "The PandaWorld Chrome extension fills the Jumia Vendor Center product form for you. Upload a photo, pick a category, and AI writes the title, description, highlights, and attributes — SEO-optimised and QC-compliant. You review and submit. Works on any category.",
  keywords: [
    "Jumia autofill",
    "Jumia Vendor Center extension",
    "Jumia listing chrome extension",
    "AI product listing Jumia",
    "Jumia seller tool Ghana",
  ],
  openGraph: {
    title:       "PandaWorld Chrome Extension for Jumia Vendor Center",
    description:
      "Autofill the Jumia listing form from a product photo — SEO-optimised, QC-compliant. You review and submit.",
    type: "website",
  },
  alternates: { canonical: "/extension" },
};

const STEPS = [
  {
    Icon: Chrome,
    title: "Install the extension",
    body: "Add PandaWorld to Chrome and pin it. It opens as a side panel next to Jumia Vendor Center",
  },
  {
    Icon: KeyRound,
    title: "Sign in with your API key",
    body: "Generate a key in your PandaWorld dashboard and paste it into the panel.",
  },
  {
    Icon: UploadCloud,
    title: "Add a photo & pick a category",
    body: "Do your listing on Jumia as usual — upload the product image and choose a category to open the form.",
  },
  {
    Icon: Wand2,
    title: "Click Autofill, review, submit",
    body: "AI fills the title, description, highlights, and attributes. You check it, tweak anything, and submit",
  },
];

// Every auth link on this page carries this so a NEW sign-up lands directly on
// the extension dashboard — never the old Jumia-OAuth onboarding gate
// (app/page.tsx / (main)/layout.tsx), which is a separate flow for the main
// web app and structurally unreachable from /extension/dashboard anyway
// (that route lives outside the (main) group). Without redirect_url, Clerk's
// default post-auth destination is "/", whose own gate sends any brand-new
// user straight into /onboarding/channel.
const DASHBOARD_REDIRECT = "/extension/dashboard";

// Named export (in addition to the default below) so app/page.tsx can
// render the exact same component for logged-out root visitors — the root
// landing page is meant to be identical to /extension, not a second copy
// of this markup that could drift out of sync.
export async function ExtensionPage() {
  const { userId } = await auth();
  // Signed-in visitors skip straight to the real key-generation screen;
  // logged-out visitors sign up first (the dashboard requires an account).
  const ctaHref  = userId ? DASHBOARD_REDIRECT : `/sign-up?redirect_url=${DASHBOARD_REDIRECT}`;
  const ctaLabel = userId ? "Open your extension dashboard" : "Get Started";

  return (
    <div className="min-h-screen bg-white text-zinc-900">
      {/* Hero — dark, canvas-animated backdrop (components/marketing/extension-hero-backdrop.tsx).
          Carries its own nav (logo, Pricing, Sign in, Get Started) since
          it's visually a different world from the "How it works" section and
          footer below — no separate MarketingNav on this page. That means
          Pricing/Sign in aren't persistently reachable while scrolled past
          the hero; MarketingFooter below still offers a way through. */}
      <ExtensionHeroBackdrop
        signInHref={`/sign-in?redirect_url=${DASHBOARD_REDIRECT}`}
        signUpHref={`/sign-up?redirect_url=${DASHBOARD_REDIRECT}`}
        ctaHref={ctaHref}
        ctaLabel={ctaLabel}
      />

      {/* How it works */}
      <section id="how-it-works" className="bg-zinc-50">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <div className="text-center">
            <p className="text-xs font-semibold uppercase tracking-widest text-orange-500">
              How it works
            </p>
            <h2 className="mt-3 text-2xl font-bold sm:text-3xl">
              Follow these steps to reduce the time spent on listing products
            </h2>
          </div>
          <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((step, i) => (
              <div
                key={step.title}
                className="group relative rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm transition-all duration-300 hover:-translate-y-1 hover:border-orange-200 hover:shadow-xl hover:shadow-orange-500/10"
              >
                <span className="absolute right-4 top-4 text-sm font-bold text-zinc-200 transition-colors duration-300 group-hover:text-orange-200">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-orange-50 text-orange-600 transition-colors duration-300 group-hover:bg-orange-500 group-hover:text-white">
                  <step.Icon className="h-5 w-5" />
                </div>
                <h3 className="mt-4 text-base font-semibold">{step.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-zinc-600">{step.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Try for free banner */}
      <section className="bg-gradient-to-r from-orange-500 to-pink-500">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-6 px-6 py-12 text-center sm:flex-row sm:text-left">
          <div>
            <h2 className="text-2xl font-bold text-white sm:text-3xl">
              Start listing faster today
            </h2>
            <p className="mt-2 text-sm text-white/85">
              5 free credits on sign-up — no card required.
            </p>
          </div>
          <Link
            href={ctaHref}
            className="inline-flex shrink-0 items-center gap-2 rounded-full bg-white px-6 py-3.5 text-sm font-semibold text-orange-600 shadow-md transition-transform hover:scale-[1.03]"
          >
            Try for free <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}

export default ExtensionPage;
