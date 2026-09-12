import {
  Chrome,
  KeyRound,
  UploadCloud,
  Wand2,
} from "lucide-react";
import { auth } from "@clerk/nextjs/server";
import { MarketingFooter } from "@/components/marketing/footer";
import { ExtensionHeroBackdrop } from "@/components/marketing/extension-hero-backdrop";
import { CHROME_WEB_STORE_URL } from "@/lib/constants/support";

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
  // Points at root, not "/extension" itself — app/page.tsx renders this exact
  // same component for logged-out visitors, so both URLs serve byte-identical
  // content. Without this, each page self-declared as its own canonical,
  // which splits ranking signal across two URLs for Google instead of
  // consolidating it on the one people actually share (the root domain).
  alternates: { canonical: "/" },
};

const STEPS = [
  {
    Icon: Chrome,
    title: "Install the extension",
    body: "Add PandaWorld to Chrome and pin it. It opens as a side panel next to Jumia Vendor Center",
    href: CHROME_WEB_STORE_URL,
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
// user straight into /onboarding/connect.
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
  const signInHref = `/sign-in?redirect_url=${DASHBOARD_REDIRECT}`;

  return (
    <div className="min-h-screen bg-white text-zinc-900">
      {/* Hero — dark, canvas-animated backdrop (components/marketing/extension-hero-backdrop.tsx).
          Carries its own nav (logo, Pricing, Sign in, Get Started) since
          it's visually a different world from the "How it works" section and
          footer below — no separate MarketingNav on this page. That means
          Pricing/Sign in aren't persistently reachable while scrolled past
          the hero; MarketingFooter below still offers a way through. */}
      <ExtensionHeroBackdrop
        signInHref={signInHref}
        signUpHref={`/sign-up?redirect_url=${DASHBOARD_REDIRECT}`}
        ctaHref={ctaHref}
        ctaLabel={ctaLabel}
        signedIn={Boolean(userId)}
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
            {STEPS.map((step, i) => {
              const cardClass =
                "group relative rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm transition-all duration-300 hover:-translate-y-1 hover:border-orange-200 hover:shadow-xl hover:shadow-orange-500/10";
              const cardContent = (
                <>
                  <span className="absolute right-4 top-4 text-sm font-bold text-zinc-200 transition-colors duration-300 group-hover:text-orange-200">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-orange-50 text-orange-600 transition-colors duration-300 group-hover:bg-orange-500 group-hover:text-white">
                    <step.Icon className="h-5 w-5" />
                  </div>
                  <h3 className="mt-4 text-base font-semibold">
                    {step.title}
                    {step.href && <span className="ml-2 text-xs font-medium text-orange-500">Open Chrome Web Store →</span>}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-zinc-600">{step.body}</p>
                </>
              );
              return step.href ? (
                <a key={step.title} href={step.href} target="_blank" rel="noopener noreferrer" className={cardClass}>
                  {cardContent}
                </a>
              ) : (
                <div key={step.title} className={cardClass}>
                  {cardContent}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <MarketingFooter extensionPricing={{ signedIn: Boolean(userId), signInHref }} />
    </div>
  );
}

export default ExtensionPage;
