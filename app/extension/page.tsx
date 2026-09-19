import Link from "next/link";
import Script from "next/script";
import { WhatsAppIcon } from "@/components/whatsapp/whatsapp-icon";
import { Chrome } from "lucide-react";
import { auth } from "@clerk/nextjs/server";
import { MarketingFooter } from "@/components/marketing/footer";
import { MarketingHeader } from "@/components/marketing/header";
import { MarketingButton } from "@/components/marketing/button";
import { LINE, TEXT, MUTED, ACCENT, ACCENT_TEXT, PAGE_BG, MARKETING_FONT } from "@/components/marketing/palette";
import { CHROME_WEB_STORE_URL } from "@/lib/constants/support";

// ─── /extension — homepage for the Chrome extension + WhatsApp flows ────────
//
// Lives outside the (main) layout so logged-out visitors can read about
// either way to list without bouncing through Clerk. Also rendered directly
// at "/" (app/page.tsx re-exports this same component) — the two routes
// serve byte-identical content, with "/" as the canonical URL.
//
// Two products, same weight: the Chrome extension autofills the Jumia
// Vendor Center "Add Products" form from a product photo (auth is a
// PandaWorld-issued API key generated in the dashboard), and the WhatsApp
// bot drafts + submits listings from photos sent in chat (see
// lib/whatsapp/intake.ts). Both need a PandaWorld account first, so the
// WhatsApp CTA points at sign-up rather than a public wa.me link — there's
// no way to talk to the bot before the seller has an account to link.

const PAGE_TITLE = "Jumia listings from WhatsApp or Chrome | PandaWorld";
const PAGE_DESCRIPTION =
  "Send product photos and a price on WhatsApp, or autofill Jumia Vendor Center from Chrome. You review the draft before it goes live. Free while we test. For Jumia sellers across Africa.";

export const metadata: import("next").Metadata = {
  title: { absolute: PAGE_TITLE },
  description: PAGE_DESCRIPTION,
  openGraph: {
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
    type: "website",
  },
  twitter: {
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
  },
  // Points at root, not "/extension" itself — app/page.tsx renders this exact
  // same component for logged-out visitors, so both URLs serve byte-identical
  // content. Without this, each page self-declared as its own canonical,
  // which splits ranking signal across two URLs for Google instead of
  // consolidating it on the one people actually share (the root domain).
  alternates: { canonical: "/" },
};

// ─── JSON-LD structured data — homepage only ─────────────────────────────────
//
// Organization gets the knowledge-panel sidebar for "PandaWorld" branded
// searches. SoftwareApplication gets the rich "Application" card. No priced
// `offers` — pricing isn't set yet ("Free while we test").

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://pandaworldai.site";

const organizationLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "PandaWorld",
  url: APP_URL,
  logo: `${APP_URL}/opengraph-image`,
  description: "AI-powered product listing assistant for Jumia sellers across Africa.",
  sameAs: [
    "https://x.com/pandaworldai",
    "https://www.instagram.com/pandaworldai",
  ],
} as const;

const softwareApplicationLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "PandaWorld",
  operatingSystem: "Web",
  applicationCategory: "BusinessApplication",
  description: "AI-powered listing assistant for Jumia sellers across Africa. Draft listings from a WhatsApp photo or autofill Jumia Vendor Center from Chrome. Sellers review every draft before it goes live.",
  url: APP_URL,
  audience: {
    "@type": "Audience",
    audienceType: "Jumia sellers across Africa",
  },
} as const;

const CHECKS = [
  "Fashion brand is never “Generic” — we use the real brand, or “Fashion.”",
  "Capacities are whole numbers when Jumia requires it.",
  "Sale dates only show up when you gave a full start and end.",
  "Category is one Jumia will accept for that shop.",
  "Variants are separate, allowed options — never made up.",
  "One submit — no silent retry of the same payload.",
];

const WHATSAPP_LINES = [
  "Send a photo of the product.",
  "Add the price and any notes in the same message.",
  "We draft the Jumia listing and send it back.",
  "Reply “submit” and it goes live.",
];

const CHROME_LINES = [
  "Open the side panel next to Jumia Vendor Center.",
  "Add a photo and pick a category.",
  "Click Autofill to fill in the form.",
  "Review it, then submit.",
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
  const ctaHref  = userId ? DASHBOARD_REDIRECT : `/sign-up?redirect_url=${DASHBOARD_REDIRECT}`;
  const ctaLabel = userId ? "Open dashboard" : "Get Started";
  const signInHref = `/sign-in?redirect_url=${DASHBOARD_REDIRECT}`;
  const signUpHref = `/sign-up?redirect_url=${DASHBOARD_REDIRECT}`;

  return (
    <div
      className="min-h-screen"
      style={{ backgroundColor: PAGE_BG, color: TEXT, fontFamily: MARKETING_FONT }}
    >
      <Script
        id="ld-organization"
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationLd) }}
      />
      <Script
        id="ld-software-application"
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareApplicationLd) }}
      />

      <MarketingHeader ctaHref={ctaHref} ctaLabel={ctaLabel} signInHref={signInHref} />

      {/* Hero — left-aligned, no dark background, no gradients. */}
      <section className="mx-auto max-w-5xl px-6 py-16 sm:py-20">
        <h1 className="max-w-2xl text-3xl font-bold leading-tight sm:text-5xl">
          List on Jumia from WhatsApp, or from Chrome.
        </h1>
        <p className="mt-5 max-w-xl text-base leading-relaxed sm:text-lg" style={{ color: MUTED }}>
          Send photos and a price, or autofill the Vendor Center form. You review the draft, then it goes live. Free while we test.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <MarketingButton href={signUpHref}>List from WhatsApp</MarketingButton>
          <MarketingButton href={CHROME_WEB_STORE_URL} external variant="outline">
            Add to Chrome
          </MarketingButton>
        </div>
      </section>

      {/* Two equal columns — WhatsApp and Chrome, same weight, same border
          and type as the rest of the page. Each mock is plain HTML, not a
          screenshot. */}
      <section className="border-t" style={{ borderColor: LINE }}>
        <div className="mx-auto grid max-w-5xl grid-cols-1 gap-12 px-6 py-16 lg:grid-cols-2 lg:gap-10">
          <div>
            <h2 className="flex items-center gap-2 text-xl font-bold">
              <WhatsAppIcon className="h-5 w-5" />
              From WhatsApp
            </h2>

            <WhatsAppMock />

            <ol className="mt-6 space-y-2 text-sm" style={{ color: MUTED }}>
              {WHATSAPP_LINES.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ol>
          </div>

          <div>
            <h2 className="flex items-center gap-2 text-xl font-bold">
              <Chrome className="h-5 w-5" />
              From Chrome
            </h2>

            <ChromeMock />

            <ol className="mt-6 space-y-2 text-sm" style={{ color: MUTED }}>
              {CHROME_LINES.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      {/* Checks — plain sentences, not icon cards. */}
      <section className="border-t" style={{ borderColor: LINE }}>
        <div className="mx-auto max-w-5xl px-6 py-16">
          <h2 className="text-xl font-bold">What we check before it goes live</h2>
          <ul className="mt-5 max-w-2xl space-y-3 text-sm leading-relaxed" style={{ color: MUTED }}>
            {CHECKS.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <p className="mt-6 text-sm" style={{ color: MUTED }}>
            You review the draft before it goes live. We check category rules before submit.
          </p>
        </div>
      </section>

      {/* Related pages — internal links per the SEO brief. */}
      <section className="border-t" style={{ borderColor: LINE }}>
        <div className="mx-auto max-w-5xl px-6 py-10">
          <p className="text-sm font-semibold">Read more</p>
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <Link href="/jumia-whatsapp-listings" className="underline hover:opacity-70" style={{ color: TEXT }}>
              Jumia listings from WhatsApp
            </Link>
            <Link href="/jumia-vendor-center-extension" className="underline hover:opacity-70" style={{ color: TEXT }}>
              Chrome extension for Jumia Vendor Center
            </Link>
            <Link href="/jumia-listing-rejected" className="underline hover:opacity-70" style={{ color: TEXT }}>
              Why Jumia rejected your listing
            </Link>
            <Link href="/pricing" className="underline hover:opacity-70" style={{ color: TEXT }}>
              Pricing
            </Link>
          </div>
        </div>
      </section>

      <MarketingFooter extensionPricing={{ signedIn: Boolean(userId), signInHref }} />
    </div>
  );
}

/** Plain-HTML WhatsApp thread mock — photo, caption with a price, a short
 *  draft reply, and the "Reply submit" step. No screenshot, same border
 *  and type as the rest of the page. */
function WhatsAppMock() {
  return (
    <div className="mt-6 rounded-[6px] border p-4" style={{ borderColor: LINE }}>
      <div className="flex flex-col gap-3">
        <div className="ml-auto max-w-[85%] rounded-[6px] border p-2.5" style={{ borderColor: LINE }}>
          <div className="flex h-24 w-full items-center justify-center rounded-[6px] border text-xs" style={{ borderColor: LINE, color: MUTED }}>
            product photo
          </div>
          <p className="mt-2 text-sm">Blue ankara dress, size M, GHS 120</p>
        </div>

        <div className="max-w-[85%] rounded-[6px] border p-2.5 text-sm" style={{ borderColor: LINE, color: MUTED }}>
          Draft ready: Blue Ankara Wrap Dress — GHS 120, Fashion → Dresses. Reply <strong style={{ color: TEXT }}>submit</strong> to publish.
        </div>

        <div className="ml-auto max-w-[85%] rounded-[6px] border p-2.5 text-sm font-medium" style={{ borderColor: LINE }}>
          submit
        </div>
      </div>
      <p className="mt-3 text-xs" style={{ color: MUTED }}>Reply submit</p>
    </div>
  );
}

/** Plain-HTML mock of the Chrome side panel sitting next to the Jumia
 *  Vendor Center form it autofills. */
function ChromeMock() {
  return (
    <div className="mt-6 flex flex-col gap-3 rounded-[6px] border p-4 sm:flex-row" style={{ borderColor: LINE }}>
      <div className="flex-1 rounded-[6px] border p-3" style={{ borderColor: LINE }}>
        <p className="text-xs font-semibold" style={{ color: MUTED }}>Jumia Vendor Center</p>
        <div className="mt-3 space-y-2">
          <div className="h-8 rounded-[6px] border" style={{ borderColor: LINE }} />
          <div className="h-8 rounded-[6px] border" style={{ borderColor: LINE }} />
          <div className="h-16 rounded-[6px] border" style={{ borderColor: LINE }} />
        </div>
      </div>
      <div className="w-full rounded-[6px] border p-3 sm:w-40" style={{ borderColor: LINE, backgroundColor: "#fff" }}>
        <p className="text-xs font-semibold">PandaWorld</p>
        <div className="mt-2 flex h-14 items-center justify-center rounded-[6px] border text-[10px]" style={{ borderColor: LINE, color: MUTED }}>
          photo
        </div>
        <div className="mt-2 rounded-[6px] border px-2 py-1 text-[11px]" style={{ borderColor: LINE, color: MUTED }}>
          Category
        </div>
        <div className="mt-2 rounded-[6px] px-2 py-1 text-center text-[11px] font-semibold" style={{ backgroundColor: ACCENT, color: ACCENT_TEXT }}>
          Autofill
        </div>
      </div>
    </div>
  );
}

export default ExtensionPage;
