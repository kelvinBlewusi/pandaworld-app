import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { ArrowRight } from "lucide-react";
import { HomeFloatingNav } from "@/components/marketing/home-floating-nav";
import { MarketingFooter } from "@/components/marketing/footer";
import { BreadcrumbLd } from "@/components/marketing/breadcrumb-ld";
import { isBillingEnabled } from "@/lib/billing/mode";
import { JUMIA_COUNTRIES } from "@/lib/marketing/countries";
import { CALCULATOR_HREF, SIGN_IN_HREF, SIGN_UP_HREF } from "@/lib/marketing/links";

// ─── /sell-on-jumia — every Jumia market, one link each ───────────────────────
//
// The index for app/sell-on-jumia/[country]: gives search engines (and
// sellers) one page that reaches every country page.

export const metadata: import("next").Metadata = {
  title:       "Sell on Jumia in Africa: Fees and AI Listings by Country",
  description: `Seller fees, a price calculator and AI-written listings for every Jumia market: ${JUMIA_COUNTRIES.map((c) => c.name).join(", ")}.`,
  alternates:  { canonical: "/sell-on-jumia" },
  openGraph: {
    title:       "Sell on Jumia in Africa, country by country",
    description: "Jumia seller fees, a price calculator and AI-written listings for every Jumia market.",
    type:        "website",
  },
};

export default async function SellOnJumiaIndexPage() {
  const { userId } = await auth();
  const billingOn = await isBillingEnabled();

  return (
    <div className="min-h-screen bg-white text-zinc-900">
      <BreadcrumbLd items={[["PandaWorld", "/"], ["Sell on Jumia", "/sell-on-jumia"]]} />
      <HomeFloatingNav signInHref={SIGN_IN_HREF} signUpHref={SIGN_UP_HREF} calculatorHref={CALCULATOR_HREF} pricingLive={billingOn} />

      <div className="mx-auto max-w-4xl px-6 pb-16 pt-12 sm:pt-16">
        <p className="text-sm font-semibold uppercase tracking-widest text-orange-500">Jumia markets</p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight sm:text-5xl">Sell on Jumia, country by country</h1>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-zinc-600">
          How seller fees work in each Jumia market, a price calculator in the local currency, and how to start
          listing there with PandaWorld.
        </p>

        <ul className="mt-10 grid gap-4 sm:grid-cols-2">
          {JUMIA_COUNTRIES.map((c) => (
            <li key={c.slug}>
              <Link
                href={`/sell-on-jumia/${c.slug}`}
                className="group flex h-full items-center justify-between rounded-2xl border border-zinc-200 p-5 hover:border-zinc-300"
              >
                <span>
                  <span className="block text-lg font-bold group-hover:underline">Sell on Jumia {c.name}</span>
                  <span className="mt-1 block text-sm text-zinc-500">{c.storefront} · prices in {c.currencyName}</span>
                </span>
                <ArrowRight className="h-5 w-5 shrink-0 text-zinc-400 group-hover:text-zinc-700" />
              </Link>
            </li>
          ))}
        </ul>

        <div className="mt-12 text-center">
          <Link
            href={userId ? "/extension/dashboard" : SIGN_UP_HREF}
            className="inline-flex items-center gap-2 rounded-full bg-orange-500 px-7 py-4 text-base font-medium text-white hover:bg-orange-600"
          >
            {userId ? "Open dashboard" : "Get started free"}
          </Link>
        </div>
      </div>

      <MarketingFooter extensionPricing={billingOn ? undefined : { signedIn: Boolean(userId), signInHref: SIGN_IN_HREF }} />
    </div>
  );
}
