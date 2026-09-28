import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { ArrowRight } from "lucide-react";
import { HomeFloatingNav } from "@/components/marketing/home-floating-nav";
import { MarketingFooter } from "@/components/marketing/footer";
import { GuideMedia } from "@/components/marketing/guide-media";
import { GuideSteps } from "@/components/marketing/guide-steps";
import { BreadcrumbLd } from "@/components/marketing/breadcrumb-ld";
import { isBillingEnabled } from "@/lib/billing/mode";
import { GUIDES } from "@/lib/marketing/guides";
import { CALCULATOR_HREF, SIGN_IN_HREF, SIGN_UP_HREF } from "@/lib/marketing/links";

// ─── /how-to — public, indexable step-by-step guides ─────────────────────────
//
// Lives outside any auth gate (unlike the old app/extension/(app)/how-to,
// now deleted) specifically so Google can index it — sellers searching
// "how to connect Jumia Vendor Center" or "list on Jumia from WhatsApp"
// should be able to land here directly. Reachable from the homepage's own
// nav (components/marketing/home-floating-nav.tsx) and from the extension
// sidebar's "Guides" link (components/extension/sidebar.tsx), which used to
// point at a signed-in-only duplicate of this same content.
//
// Every guide also has its own page, /how-to/<slug> (app/how-to/[slug]),
// which is what ranks for each guide's own search; this page lists them
// all. Content lives in lib/marketing/guides.ts.

export const metadata: import("next").Metadata = {
  title: "How To — Connect, List, and Push to Jumia",
  description:
    "Step-by-step guides for PandaWorld: connect your Jumia Vendor Center account, link WhatsApp, and list products on Jumia from your laptop with the Chrome extension or from your phone over WhatsApp.",
  keywords: [
    "how to connect Jumia Vendor Center",
    "Jumia WhatsApp bot setup",
    "Jumia Chrome extension guide",
    "list on Jumia from WhatsApp",
    "Jumia Vendor Center API application",
    "PandaWorld setup guide",
  ],
  openGraph: {
    title: "How To — PandaWorld guides for Jumia sellers",
    description:
      "Connect your Vendor Center, link WhatsApp, and list on Jumia from a laptop or from WhatsApp — step by step.",
    type: "website",
  },
  alternates: { canonical: "/how-to" },
};

export default async function HowToPage() {
  const { userId } = await auth();
  const billingOn = await isBillingEnabled();

  return (
    <div className="min-h-screen bg-white text-zinc-900">
      <BreadcrumbLd items={[["PandaWorld", "/"], ["Guides", "/how-to"]]} />
      <HomeFloatingNav signInHref={SIGN_IN_HREF} signUpHref={SIGN_UP_HREF} calculatorHref={CALCULATOR_HREF} pricingLive={billingOn} />

      <div className="mx-auto max-w-3xl px-6 pb-16 pt-16 sm:pt-20">
        <div className="text-center">
          <p className="text-sm font-semibold uppercase tracking-widest text-orange-500">Guides</p>
          <h1 className="mt-3 text-4xl font-bold tracking-tight sm:text-5xl">How To</h1>
          <p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-zinc-500 sm:text-lg">
            Step-by-step guides for getting set up and listing on Jumia — from your laptop with the Chrome
            extension, or from your phone over WhatsApp.
          </p>
        </div>

        <div className="mt-12 space-y-6">
          {GUIDES.map((guide, i) => (
            <div key={guide.title} className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-orange-500 text-white">
                  <guide.Icon className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-zinc-400">{`0${i + 1}`}</p>
                  <h2 className="text-lg font-bold text-zinc-900 sm:text-xl">
                    <Link href={`/how-to/${guide.slug}`} className="hover:underline">{guide.title}</Link>
                  </h2>
                </div>
              </div>
              <p className="mt-3 text-base text-zinc-600">{guide.intro}</p>

              <div className="mt-4">
                <GuideSteps steps={guide.steps} />
              </div>

              <div className="mt-5">
                <GuideMedia guide={guide} />
              </div>

              <Link
                href={`/how-to/${guide.slug}`}
                className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-orange-600 hover:text-orange-700"
              >
                Open this guide on its own page
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          ))}
        </div>

        <div className="mt-12 text-center">
          <Link
            href={SIGN_UP_HREF}
            className="inline-flex items-center justify-center gap-2 rounded-full bg-orange-500 px-7 py-4 text-base font-medium text-white transition-colors hover:bg-orange-600"
          >
            Get started free
          </Link>
        </div>
      </div>

      <MarketingFooter extensionPricing={billingOn ? undefined : { signedIn: Boolean(userId), signInHref: SIGN_IN_HREF }} />
    </div>
  );
}
