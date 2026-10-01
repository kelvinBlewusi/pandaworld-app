import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { ArrowRight } from "lucide-react";
import { HomeFloatingNav } from "@/components/marketing/home-floating-nav";
import { MarketingFooter } from "@/components/marketing/footer";
import { BreadcrumbLd } from "@/components/marketing/breadcrumb-ld";
import { PriceCalculator } from "@/components/tools/price-calculator";
import { CalculatorCountrySwitch } from "@/components/tools/calculator-country-switch";
import { isBillingEnabled } from "@/lib/billing/mode";
import { JUMIA_GH_CATEGORIES, commissionRange, listingPriceFor } from "@/lib/marketing/jumia-fees";
import { CALCULATOR_HREF, COMMISSION_RATES_HREF, GHANA_CALCULATOR_HREF, SIGN_IN_HREF, SIGN_UP_HREF } from "@/lib/marketing/links";
import { formatGHS } from "@/lib/utils";

// ─── /jumia-price-calculator — public, indexable ──────────────────────────────
//
// The same calculator signed-in sellers use (components/tools/price-
// calculator.tsx), open to everyone, with the formula written out so the
// page answers "how does Jumia work out my price" on its own. Aimed at
// searches like "Jumia price calculator" and "Jumia commission calculator
// Ghana"; links to the full rate table at /jumia-commission-rates.

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://pandaworldai.site";
const { min, max } = commissionRange();

export const metadata: import("next").Metadata = {
  title:       "Jumia Price Calculator for Ghana Sellers — Commission & Payout",
  description: `Free Jumia price calculator: find the price to list at on Jumia Ghana so you still receive what you want after commission (${min}–${max}%) and shipping contribution, or check what you'll be paid at a given price.`,
  keywords: [
    "Jumia price calculator",
    "Jumia commission calculator",
    "Jumia Ghana commission",
    "Jumia seller fees calculator",
    "Jumia listing price",
    "Jumia payout calculator",
  ],
  alternates: { canonical: GHANA_CALCULATOR_HREF },
  openGraph: {
    title:       "Jumia Price Calculator — what to list at, what you'll be paid",
    description: "Work out your Jumia Ghana listing price after commission and shipping contribution. Free, no sign-up.",
    type:        "website",
  },
};

export default async function JumiaPriceCalculatorPage() {
  const { userId } = await auth();
  const billingOn = await isBillingEnabled();

  // Worked example from the real Fashion rates, so the numbers on the page
  // always match the calculator.
  const fashion = JUMIA_GH_CATEGORIES.find((c) => c.name === "Fashion") ?? JUMIA_GH_CATEGORIES[0];
  const payout = 950;
  const listPrice = listingPriceFor(payout, fashion.shippingJE, fashion.commissionRate);
  const commission = listPrice * (fashion.commissionRate / 100);

  const appLd = {
    "@context":          "https://schema.org",
    "@type":             "WebApplication",
    name:                "Jumia Price Calculator",
    url:                 `${APP_URL}${GHANA_CALCULATOR_HREF}`,
    applicationCategory: "BusinessApplication",
    operatingSystem:     "Web",
    description:         "Works out the Jumia Ghana listing price for a payout you want, or the payout at a listing price, after commission and shipping contribution.",
    offers:              { "@type": "Offer", price: "0", priceCurrency: "GHS" },
  };

  return (
    <div className="min-h-screen bg-white text-zinc-900">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(appLd) }} />
      <BreadcrumbLd items={[["PandaWorld", "/"], ["Jumia price calculator", GHANA_CALCULATOR_HREF]]} />
      <HomeFloatingNav signInHref={SIGN_IN_HREF} signUpHref={SIGN_UP_HREF} calculatorHref={CALCULATOR_HREF} pricingLive={billingOn} />

      <div className="mx-auto max-w-3xl px-6 pb-16 pt-12 sm:pt-16">
        <p className="text-sm font-semibold uppercase tracking-widest text-orange-500">Free tool</p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight sm:text-5xl">Jumia price calculator</h1>
        <p className="mt-4 text-lg leading-relaxed text-zinc-600">
          Find the price to list at on Jumia Ghana so you still receive what you want after Jumia&apos;s commission
          and shipping contribution, or check what you&apos;ll be paid at a price you already have. Pick the
          category, enter a price, and see the breakdown.
        </p>

        <div className="mt-8">
          <PriceCalculator showHeader={false} />
        </div>
        <div className="mt-4">
          <CalculatorCountrySwitch current="GH" />
        </div>

        <section className="mt-14">
          <h2 className="text-2xl font-bold">How Jumia works out your listing price</h2>
          <p className="mt-3 text-base leading-relaxed text-zinc-600">
            Jumia takes a commission on the price the customer pays and deducts a shipping contribution for the
            category. To receive a set amount, list at:
          </p>
          <p className="mt-4 rounded-xl bg-zinc-50 px-5 py-4 font-medium">
            Listing price = (what you want to receive + shipping contribution) ÷ (1 − commission rate)
          </p>
          <p className="mt-4 text-base leading-relaxed text-zinc-600">
            Example: {fashion.name} has a {fashion.commissionRate}% commission and a{" "}
            {formatGHS(fashion.shippingJE)} shipping contribution on Jumia Express. To receive {formatGHS(payout)},
            list at ({formatGHS(payout)} + {formatGHS(fashion.shippingJE)}) ÷ (1 − {fashion.commissionRate / 100}) ={" "}
            <strong>{formatGHS(listPrice)}</strong>. Jumia keeps {formatGHS(commission)} in commission and{" "}
            {formatGHS(fashion.shippingJE)} for shipping, and you&apos;re paid {formatGHS(listPrice - commission - fashion.shippingJE)}.
          </p>
        </section>

        <section className="mt-12">
          <h2 className="text-2xl font-bold">What Jumia deducts</h2>
          <ul className="mt-4 space-y-3 text-base leading-relaxed text-zinc-600">
            <li>
              <strong className="text-zinc-900">Commission</strong>: a percentage of the listing price, from {min}% to{" "}
              {max}% depending on the category, VAT included.
            </li>
            <li>
              <strong className="text-zinc-900">Shipping contribution</strong>: a fixed amount per category, different
              for Jumia Express (JE) and Drop Shipping (DS).
            </li>
          </ul>
          <p className="mt-4 text-base text-zinc-600">
            See every category&apos;s commission and shipping contribution on the{" "}
            <Link href={COMMISSION_RATES_HREF} className="font-semibold text-orange-600 hover:underline">
              Jumia Ghana commission rates
            </Link>{" "}
            page.
          </p>
          <p className="mt-4 text-sm text-zinc-500">
            Rates are from Jumia VendorHub Ghana&apos;s commission schedule. Jumia changes them from time to time, so
            confirm in Vendor Center before you set prices.
          </p>
        </section>

        <section className="mt-12 rounded-2xl bg-orange-50 p-6">
          <h2 className="text-xl font-bold">List on Jumia in minutes, not hours</h2>
          <p className="mt-2 text-base text-zinc-600">
            PandaWorld writes the title, description, highlights and attributes for you, from WhatsApp or right inside
            Vendor Center.
          </p>
          <Link
            href={userId ? "/extension/dashboard" : SIGN_UP_HREF}
            className="mt-4 inline-flex items-center gap-2 rounded-full bg-orange-500 px-6 py-3 text-base font-medium text-white hover:bg-orange-600"
          >
            {userId ? "Open dashboard" : "Get started free"}
            <ArrowRight className="h-4 w-4" />
          </Link>
        </section>
      </div>

      <MarketingFooter extensionPricing={billingOn ? undefined : { signedIn: Boolean(userId), signInHref: SIGN_IN_HREF }} />
    </div>
  );
}
