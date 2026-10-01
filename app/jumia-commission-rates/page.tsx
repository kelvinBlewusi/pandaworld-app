import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { HomeFloatingNav } from "@/components/marketing/home-floating-nav";
import { MarketingFooter } from "@/components/marketing/footer";
import { BreadcrumbLd } from "@/components/marketing/breadcrumb-ld";
import { isBillingEnabled } from "@/lib/billing/mode";
import { JUMIA_GH_CATEGORIES, commissionRange, listingPriceFor } from "@/lib/marketing/jumia-fees";
import { CALCULATOR_HREF, COMMISSION_RATES_HREF, GHANA_CALCULATOR_HREF, SIGN_IN_HREF, SIGN_UP_HREF } from "@/lib/marketing/links";
import { formatGHS } from "@/lib/utils";

// ─── /jumia-commission-rates — public, indexable ──────────────────────────────
//
// Jumia Ghana's commission and shipping contribution for every category,
// server-rendered as a plain table so it's readable by search engines, with
// what to list at to receive GHS 100 as a worked column. Aimed at searches
// like "Jumia commission rates Ghana"; the calculator does the arithmetic.

const { min, max } = commissionRange();
const EXAMPLE_PAYOUT = 100;

export const metadata: import("next").Metadata = {
  title:       "Jumia Ghana Commission Rates by Category",
  description: `Jumia Ghana seller commission (${min}–${max}%, VAT included) and shipping contribution for Jumia Express and Drop Shipping, for all ${JUMIA_GH_CATEGORIES.length} categories, with the listing price that pays you GHS ${EXAMPLE_PAYOUT}.`,
  keywords: [
    "Jumia commission rates",
    "Jumia Ghana commission",
    "Jumia seller fees",
    "Jumia shipping contribution",
    "Jumia Express fees",
    "Jumia commission per category",
  ],
  alternates: { canonical: COMMISSION_RATES_HREF },
  openGraph: {
    title:       "Jumia Ghana Commission Rates by Category",
    description: "Commission and shipping contribution for every Jumia Ghana category, in one table.",
    type:        "website",
  },
};

export default async function JumiaCommissionRatesPage() {
  const { userId } = await auth();
  const billingOn = await isBillingEnabled();
  const categories = JUMIA_GH_CATEGORIES;

  return (
    <div className="min-h-screen bg-white text-zinc-900">
      <BreadcrumbLd items={[["PandaWorld", "/"], ["Jumia commission rates", COMMISSION_RATES_HREF]]} />
      <HomeFloatingNav signInHref={SIGN_IN_HREF} signUpHref={SIGN_UP_HREF} calculatorHref={CALCULATOR_HREF} pricingLive={billingOn} />

      <div className="mx-auto max-w-5xl px-6 pb-16 pt-12 sm:pt-16">
        <p className="text-sm font-semibold uppercase tracking-widest text-orange-500">Seller fees</p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight sm:text-5xl">Jumia Ghana commission rates</h1>
        <p className="mt-4 max-w-3xl text-lg leading-relaxed text-zinc-600">
          What Jumia Ghana charges sellers in each category: a commission of {min}% to {max}% of the listing price
          (VAT included), plus a shipping contribution that depends on whether the item ships through Jumia Express
          (JE) or Drop Shipping (DS). The last column is the price to list at so you receive{" "}
          {formatGHS(EXAMPLE_PAYOUT)} with Jumia Express.
        </p>
        <p className="mt-3 text-base text-zinc-600">
          For any other price, use the{" "}
          <Link href={GHANA_CALCULATOR_HREF} className="font-semibold text-orange-600 hover:underline">
            Jumia price calculator
          </Link>
          .
        </p>

        <div className="mt-8 overflow-x-auto rounded-2xl border border-zinc-200">
          <table className="w-full min-w-[640px] text-left text-sm">
            <caption className="sr-only">Jumia Ghana commission and shipping contribution by category</caption>
            <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">Category</th>
                <th scope="col" className="px-4 py-3 font-medium">Commission</th>
                <th scope="col" className="px-4 py-3 font-medium">Shipping (JE)</th>
                <th scope="col" className="px-4 py-3 font-medium">Shipping (DS)</th>
                <th scope="col" className="px-4 py-3 font-medium">List at to receive {formatGHS(EXAMPLE_PAYOUT)} (JE)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {categories.map((c) => (
                <tr key={c.id}>
                  <th scope="row" className="px-4 py-3 font-medium text-zinc-900">
                    {c.name}
                    {c.subcategories.length > 0 && (
                      <span className="block text-xs font-normal text-zinc-500">{c.subcategories.join(", ")}</span>
                    )}
                  </th>
                  <td className="px-4 py-3">{c.commissionRate}%</td>
                  <td className="px-4 py-3">{formatGHS(c.shippingJE)}</td>
                  <td className="px-4 py-3">{formatGHS(c.shippingDS)}</td>
                  <td className="px-4 py-3 font-semibold">
                    {formatGHS(listingPriceFor(EXAMPLE_PAYOUT, c.shippingJE, c.commissionRate))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <section className="mt-12 max-w-3xl">
          <h2 className="text-2xl font-bold">How to read this table</h2>
          <ul className="mt-4 space-y-3 text-base leading-relaxed text-zinc-600">
            <li>
              <strong className="text-zinc-900">Commission</strong> is taken from the price the customer pays and
              already includes VAT.
            </li>
            <li>
              <strong className="text-zinc-900">Shipping contribution</strong> is a fixed amount per item, lower for
              Jumia Express than for Drop Shipping in most categories.
            </li>
            <li>
              <strong className="text-zinc-900">Listing price</strong> = (what you want to receive + shipping
              contribution) ÷ (1 − commission rate), rounded up to the pesewa.
            </li>
          </ul>
          <p className="mt-4 text-sm text-zinc-500">
            From Jumia VendorHub Ghana&apos;s commission schedule. Jumia changes rates from time to time, so confirm
            in Vendor Center before you set prices.
          </p>
        </section>

        <section className="mt-12 max-w-3xl rounded-2xl bg-orange-50 p-6">
          <h2 className="text-xl font-bold">Spend less time on every listing</h2>
          <p className="mt-2 text-base text-zinc-600">
            PandaWorld drafts complete Jumia listings from your product photos, on WhatsApp or inside Vendor
            Center, and{" "}
            <Link href="/how-to" className="font-semibold text-orange-600 hover:underline">
              the guides
            </Link>{" "}
            show you how to set it up.
          </p>
          <Link
            href={userId ? "/extension/dashboard" : SIGN_UP_HREF}
            className="mt-4 inline-flex rounded-full bg-orange-500 px-6 py-3 text-base font-medium text-white hover:bg-orange-600"
          >
            {userId ? "Open dashboard" : "Get started free"}
          </Link>
        </section>
      </div>

      <MarketingFooter extensionPricing={billingOn ? undefined : { signedIn: Boolean(userId), signInHref: SIGN_IN_HREF }} />
    </div>
  );
}
