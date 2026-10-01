import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { ArrowRight, ExternalLink } from "lucide-react";
import { HomeFloatingNav } from "@/components/marketing/home-floating-nav";
import { MarketingFooter } from "@/components/marketing/footer";
import { BreadcrumbLd } from "@/components/marketing/breadcrumb-ld";
import { CountryPriceCalculator } from "@/components/tools/country-price-calculator";
import { CalculatorCountrySwitch } from "@/components/tools/calculator-country-switch";
import { isBillingEnabled } from "@/lib/billing/mode";
import { JUMIA_COUNTRIES, getJumiaCountry } from "@/lib/marketing/countries";
import { COUNTRY_FEES, commissionSpan } from "@/lib/marketing/country-fees";
import { CALCULATOR_HREF, COMMISSION_RATES_HREF, SIGN_IN_HREF, SIGN_UP_HREF } from "@/lib/marketing/links";

// ─── /sell-on-jumia/<country> — one page per Jumia market ─────────────────────
//
// For sellers searching "sell on Jumia Nigeria", "Jumia Kenya seller fees"
// and the like: how fees work in that country (from its official VendorHub,
// linked), a calculator in the local currency, and how to start listing
// there with PandaWorld. Country facts live in lib/marketing/countries.ts.
// Rendered per request, like the other public pages, so the nav and footer
// follow the billing switch.

export function generateMetadata({ params }: { params: { country: string } }): import("next").Metadata {
  const c = getJumiaCountry(params.country);
  if (!c) return {};
  const title = `Sell on Jumia ${c.name}: Seller Fees, Price Calculator & AI Listings`;
  const description = `Jumia ${c.name} commission rates for every category, a free price calculator in ${c.currencyName}, and AI that writes your Jumia ${c.name} listings from WhatsApp or right inside Vendor Center.`;
  return {
    title,
    description,
    keywords: [
      `sell on Jumia ${c.name}`,
      `Jumia ${c.name} seller fees`,
      `Jumia ${c.name} commission`,
      `Jumia ${c.name} price calculator`,
      `Jumia ${c.name} commission rates`,
      `Jumia ${c.name} vendor`,
      `Jumia Vendor Center ${c.name}`,
    ],
    alternates: { canonical: `/sell-on-jumia/${c.slug}` },
    openGraph:  { title, description, type: "website" },
  };
}

export default async function SellOnJumiaCountryPage({ params }: { params: { country: string } }) {
  const c = getJumiaCountry(params.country);
  if (!c) notFound();

  const { userId } = await auth();
  const billingOn = await isBillingEnabled();
  const others = JUMIA_COUNTRIES.filter((o) => o.slug !== c.slug);
  const fees = COUNTRY_FEES[c.code];
  const span = commissionSpan(fees);
  const money = new Intl.NumberFormat("en", {
    style: "currency",
    currency: c.currency,
    minimumFractionDigits: c.wholeUnits ? 0 : 2,
    maximumFractionDigits: c.wholeUnits ? 0 : 2,
  });
  const startHref = userId ? "/extension/dashboard" : SIGN_UP_HREF;

  return (
    <div className="min-h-screen bg-white text-zinc-900">
      <BreadcrumbLd items={[["PandaWorld", "/"], ["Sell on Jumia", "/sell-on-jumia"], [`Jumia ${c.name}`, `/sell-on-jumia/${c.slug}`]]} />
      <HomeFloatingNav signInHref={SIGN_IN_HREF} signUpHref={SIGN_UP_HREF} calculatorHref={CALCULATOR_HREF} pricingLive={billingOn} />

      <div className="mx-auto max-w-3xl px-6 pb-16 pt-12 sm:pt-16">
        <nav aria-label="Breadcrumb" className="text-sm text-zinc-500">
          <Link href="/sell-on-jumia" className="hover:text-zinc-900">Sell on Jumia</Link>
          <span className="mx-2">›</span>
          <span className="text-zinc-700">{c.name}</span>
        </nav>

        <h1 className="mt-6 text-3xl font-bold tracking-tight sm:text-5xl">Sell on Jumia {c.name}</h1>
        <p className="mt-4 text-lg leading-relaxed text-zinc-600">
          PandaWorld writes complete Jumia {c.name} listings from your product photos (title, description,
          highlights and attributes) and submits them to your Vendor Center. Send the photos on WhatsApp, or let the
          Chrome extension fill in Vendor Center&apos;s Add Products form while you&apos;re on it.
        </p>
        {c.marketLanguage !== "English" && (
          <p className="mt-3 rounded-xl bg-zinc-50 px-4 py-3 text-sm text-zinc-600">
            PandaWorld writes listings in English today.
          </p>
        )}
        <Link
          href={startHref}
          className="mt-6 inline-flex items-center gap-2 rounded-full bg-orange-500 px-6 py-3 text-base font-medium text-white hover:bg-orange-600"
        >
          {userId ? "Open dashboard" : "Get started free"}
          <ArrowRight className="h-4 w-4" />
        </Link>

        <section className="mt-14">
          <h2 className="text-2xl font-bold">Jumia {c.name} seller fees</h2>
          <ul className="mt-4 list-disc space-y-2 pl-5 text-base leading-relaxed text-zinc-600">
            {c.feeFacts.map((fact) => <li key={fact}>{fact}</li>)}
          </ul>
          {c.example && <p className="mt-4 rounded-xl bg-orange-50 px-4 py-3 text-base text-zinc-700">{c.example}</p>}
          <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2 text-sm font-semibold">
            <a href={c.commissionsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-orange-600 hover:underline">
              Commission rates on Jumia VendorHub {c.name}
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
            {c.feesUrl && (
              <a href={c.feesUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-orange-600 hover:underline">
                Other fees
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
            {c.code === "GH" && (
              <Link href={COMMISSION_RATES_HREF} className="text-orange-600 hover:underline">
                Every Ghana category&apos;s rate in one table
              </Link>
            )}
          </div>
          <p className="mt-3 text-sm text-zinc-500">
            From Jumia VendorHub {c.name}&apos;s published fees (2026). Jumia updates them from time to time, so check
            there before you set prices.
          </p>
        </section>

        {/* The nav's calculator link lands here (app/calculator), below the sticky nav. */}
        <section id="calculator" className="mt-12 scroll-mt-24">
          <h2 className="text-2xl font-bold">Jumia {c.name} price calculator</h2>
          <p className="mt-3 text-base text-zinc-600">
            Pick your category and the calculator fills in Jumia {c.name}&apos;s commission
            {fees.itemFee.by === "manual" ? "" : ` and ${fees.feeName}`}, then works out what to list at so you receive
            the amount you want, or what you&apos;ll be paid at a price, in {c.currencyName}.
          </p>
          <div className="mt-5">
            <CountryPriceCalculator fees={fees} currency={c.currency} wholeUnits={c.wholeUnits} samplePrice={c.samplePrice} />
          </div>
          <div className="mt-4">
            <CalculatorCountrySwitch current={c.code} />
          </div>
        </section>

        <section className="mt-12">
          <h2 className="text-2xl font-bold">Jumia {c.name} commission rates by category</h2>
          <p className="mt-3 text-base text-zinc-600">
            From {span.min}% to {span.max}% of the price, VAT included, effective {fees.effective}.
            {fees.itemFee.by === "category" && ` The ${fees.feeName} per item is shown for drop shipping and Jumia Express.`}
          </p>
          <details className="group mt-5 rounded-2xl border border-zinc-200">
            <summary className="cursor-pointer list-none px-5 py-4 text-sm font-semibold text-zinc-900 [&::-webkit-details-marker]:hidden">
              <span className="group-open:hidden">Show all {fees.categories.length} categories</span>
              <span className="hidden group-open:inline">Hide the categories</span>
            </summary>
            <div className="overflow-x-auto border-t border-zinc-200">
              <table className="w-full text-left text-sm">
                <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th scope="col" className="px-5 py-2.5 font-semibold">Category</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-semibold">Commission</th>
                    {fees.itemFee.by === "category" && (
                      <>
                        <th scope="col" className="px-3 py-2.5 text-right font-semibold">Drop shipping</th>
                        <th scope="col" className="px-5 py-2.5 text-right font-semibold">Jumia Express</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {fees.categories.map((cat) => (
                    <tr key={cat.name}>
                      <td className="px-5 py-2.5 text-zinc-700">{cat.name}</td>
                      <td className="px-3 py-2.5 text-right font-medium text-zinc-900">{cat.commission}%</td>
                      {fees.itemFee.by === "category" && (
                        <>
                          <td className="px-3 py-2.5 text-right text-zinc-600">{cat.fee ? money.format(cat.fee.ds) : "–"}</td>
                          <td className="px-5 py-2.5 text-right text-zinc-600">{cat.fee ? money.format(cat.fee.je) : "–"}</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          {fees.itemFee.by === "size" && (
            <div className="mt-5 overflow-x-auto rounded-2xl border border-zinc-200">
              <table className="w-full text-left text-sm">
                <caption className="px-5 pt-4 text-left text-sm font-semibold text-zinc-900">
                  {fees.feeName.charAt(0).toUpperCase() + fees.feeName.slice(1)} per item, by size
                </caption>
                <thead className="text-xs uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th scope="col" className="px-5 py-2.5 font-semibold">Size</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-semibold">Drop shipping</th>
                    <th scope="col" className="px-5 py-2.5 text-right font-semibold">Jumia Express</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {fees.itemFee.sizes.map((s) => (
                    <tr key={s.id}>
                      <td className="px-5 py-2.5 text-zinc-700">{s.label}</td>
                      <td className="px-3 py-2.5 text-right text-zinc-600">{s.ds != null ? money.format(s.ds) : "–"}</td>
                      <td className="px-5 py-2.5 text-right text-zinc-600">{s.je != null ? money.format(s.je) : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-sm text-zinc-500">
            Copied from{" "}
            <a href={c.commissionsUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-orange-600 hover:underline">Jumia VendorHub {c.name}</a>
            {c.code === "GH" && (
              <>
                . Also as a <Link href={COMMISSION_RATES_HREF} className="font-medium text-orange-600 hover:underline">full Ghana rates page</Link>
              </>
            )}
            . Jumia changes these from time to time; Vendor Center shows the rate it will charge you.
          </p>
        </section>

        <section className="mt-12">
          <h2 className="text-2xl font-bold">Start listing faster in {c.name}</h2>
          <ol className="mt-4 space-y-3 text-base leading-relaxed text-zinc-600">
            <li>
              <strong className="text-zinc-900">1. Create a free PandaWorld account.</strong>
            </li>
            <li>
              <strong className="text-zinc-900">2. Connect your Vendor Center</strong> ({c.vendorCenter}): pick{" "}
              {c.name} on the Connect Jumia page.{" "}
              <Link href="/how-to/connect-jumia-vendor-center" className="font-semibold text-orange-600 hover:underline">How to connect</Link>
            </li>
            <li>
              <strong className="text-zinc-900">3. List from WhatsApp or your laptop.</strong> Send product photos to the
              PandaWorld WhatsApp bot, or install the Chrome extension and autofill Vendor Center&apos;s form.{" "}
              <Link href="/how-to/list-on-jumia-from-whatsapp" className="font-semibold text-orange-600 hover:underline">WhatsApp guide</Link>
              {" · "}
              <Link href="/how-to/chrome-extension-autofill" className="font-semibold text-orange-600 hover:underline">Extension guide</Link>
            </li>
          </ol>
        </section>

        <section className="mt-12">
          <h2 className="text-xl font-bold">Other Jumia countries</h2>
          <ul className="mt-4 flex flex-wrap gap-2">
            {others.map((o) => (
              <li key={o.slug}>
                <Link href={`/sell-on-jumia/${o.slug}`} className="inline-block rounded-full border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 hover:border-zinc-300 hover:text-zinc-900">
                  Jumia {o.name}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <MarketingFooter extensionPricing={billingOn ? undefined : { signedIn: Boolean(userId), signInHref: SIGN_IN_HREF }} />
    </div>
  );
}
