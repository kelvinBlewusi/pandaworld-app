import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { ArrowRight, Check, Coins, Gift } from "lucide-react";
import { MarketingFooter } from "@/components/marketing/footer";
import { HomeFloatingNav } from "@/components/marketing/home-floating-nav";
import { BuyCreditsButton } from "@/components/billing/buy-credits-button";
import { isBillingEnabled } from "@/lib/billing/mode";
import { CALCULATOR_HREF } from "@/lib/marketing/links";
import {
  CREDIT_PACKS,
  FREE_SIGNUP_CREDITS,
  POLISH_CREDIT_COST,
  REPORT_CREDIT_COST,
  LABEL_CREDIT_COST,
  creditCosts,
  everyoneFeatures,
  LIVE_LISTING_CREDIT_COST,
  POPULAR_PACK_ID,
  packFeatures,
  packReach,
} from "@/lib/billing/credit-packs";
import { listingCreditCost } from "@/lib/billing/extension-credits";
import { sellerCountry } from "@/lib/jumia/unlistable-categories";
import { jumiaCountryByCode } from "@/lib/marketing/countries";

// ─── Public pricing: credit packs ─────────────────────────────────────────────
//
// Pay-as-you-go credits (lib/billing/credit-packs.ts) — the only pricing
// since the monthly plans were removed 2026-09-28. Every number on this
// page comes from that file, so a price change there updates it.
//
// Reads the billing switch (lib/billing/mode.ts): while billing is off,
// a note says nothing is charged yet and the packs can't be bought; once
// it's on, signed-in sellers can buy right here.
//
// Lives outside the (main) layout so logged-out visitors can read it.
// Text-heavy on purpose, so the GHS amounts get indexed.

export const metadata: import("next").Metadata = {
  title:       "Pricing — Jumia Africa Listing Tool",
  description: `PandaWorld pricing for Jumia sellers: pay only for listings that go live, no subscription. ${FREE_SIGNUP_CREDITS} free credits when you sign up. Credit packs from GHS ${Math.min(...CREDIT_PACKS.map((p) => p.amountGhs))}. Pay with Mobile Money or card.`,
  keywords: [
    "PandaWorld pricing",
    "Jumia tool pricing",
    "AI listing tool cost",
    "Jumia listing credits",
    "Jumia Africa pricing",
    "Jumia Nigeria tool cost",
    "Jumia Kenya pricing",
  ],
  openGraph: {
    title:       "Pricing — PandaWorld for Jumia Africa Sellers",
    description: `Pay only for listings that go live on Jumia. No subscription. ${FREE_SIGNUP_CREDITS} free credits to start. Pay with Mobile Money or card.`,
    type:        "website",
  },
  alternates: {
    canonical: "/pricing",
  },
};

const DASHBOARD_REDIRECT = "/extension/dashboard";


export default async function PricingPage() {
  const { userId } = await auth();
  const billingOn = await isBillingEnabled();
  // A seller connected from a country with its own listing price sees it
  // here; everyone else, and the page's metadata, the usual price (owner,
  // 2026-10-07: "the country pricing only visible to those connected from the country").
  const countryCode = userId ? (await sellerCountry(userId).catch(() => null))?.toUpperCase() ?? null : null;
  const listingCost = userId ? await listingCreditCost(userId).catch(() => LIVE_LISTING_CREDIT_COST) : LIVE_LISTING_CREDIT_COST;
  const ownCountry = listingCost !== LIVE_LISTING_CREDIT_COST ? jumiaCountryByCode(countryCode)?.name ?? null : null;

  const signInHref = `/sign-in?redirect_url=${DASHBOARD_REDIRECT}`;
  const signUpHref = `/sign-up?redirect_url=${DASHBOARD_REDIRECT}`;
  // The visitor's own country's calculator (app/calculator redirects).
  const calculatorHref = CALCULATOR_HREF;

  // Offers for search engines: the packs only while they're actually for sale.
  const pricingLd = {
    "@context": "https://schema.org",
    "@type":    "Product",
    name:       "PandaWorld listing credits",
    description: "Pay-as-you-go credits for AI-drafted Jumia listings.",
    offers: [
      { "@type": "Offer", name: "Free", price: "0", priceCurrency: "GHS", description: `${FREE_SIGNUP_CREDITS} free credits when you sign up` },
      ...(billingOn
        ? CREDIT_PACKS.map((p) => ({
            "@type": "Offer",
            name: `${p.credits} credits`,
            price: String(p.amountGhs),
            priceCurrency: "GHS",
          }))
        : []),
    ],
  };

  return (
    <div className="min-h-screen bg-white text-zinc-900">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(pricingLd) }} />

      <HomeFloatingNav
        signInHref={signInHref}
        signUpHref={signUpHref}
        calculatorHref={calculatorHref}
        pricingLive={billingOn}
      />

      <section className="border-b border-zinc-100">
        <div className="mx-auto max-w-4xl px-6 py-20 text-center">
          <p className="text-sm font-semibold uppercase tracking-widest text-orange-500">Pricing</p>
          <h1 className="mt-3 text-balance text-4xl font-bold tracking-tight sm:text-5xl">
            Pay only for listings that go live.
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-base leading-relaxed text-zinc-600 sm:text-lg">
            No subscription. Start with {FREE_SIGNUP_CREDITS} free credits, no card needed. Buy a pack when you
            need more. Credits never expire.
          </p>
          {!billingOn && (
            <p className="mx-auto mt-6 max-w-xl rounded-xl bg-orange-50 px-4 py-3 text-sm text-orange-800">
              PandaWorld is free while we&apos;re getting started: nothing is charged yet. These are the
              prices once billing begins.
            </p>
          )}
        </div>
      </section>

      {/* What costs credits */}
      <section className="bg-white">
        <div className="mx-auto max-w-4xl px-6 py-16">
          <h2 className="text-2xl font-bold sm:text-3xl">What costs credits</h2>
          {ownCountry && (
            <p className="mt-2 text-sm text-zinc-500">Prices for your shop in {ownCountry}.</p>
          )}
          <div className="mt-6 overflow-hidden rounded-2xl border border-zinc-200">
            <table className="w-full text-left">
              <tbody className="divide-y divide-zinc-100">
                {creditCosts(listingCost).map((c) => (
                  <tr key={c.what}>
                    <td className="px-5 py-4">
                      <p className="font-semibold text-zinc-900">{c.what}</p>
                      <p className="text-sm text-zinc-500">{c.detail}</p>
                    </td>
                    <td className="whitespace-nowrap px-5 py-4 text-right text-lg font-bold">
                      {c.credits} {c.credits === 1 ? "credit" : "credits"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-sm text-zinc-500">
            Drafts, redrafts and fixes are free. If Jumia rejects a listing, it costs nothing. Chatting with the bot is free.
          </p>
        </div>
      </section>

      {/* Packs */}
      <section className="bg-zinc-50">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <h2 className="text-2xl font-bold sm:text-3xl">Free credits and packs</h2>
          {/* What every plan has is on the Free card (owner, 2026-10-07). */}
          <p className="mt-3 max-w-3xl text-sm text-zinc-600">
            Every pack includes everything on the Free card. The bigger packs add what&apos;s listed on each card.
          </p>
          <div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-4">
            {/* The free credits as a card of their own, first (owner, 2026-10-07: "in pricing add the free price cards"). */}
            <FreeCard
              listingCost={listingCost}
              href={userId ? DASHBOARD_REDIRECT : signUpHref}
              signedIn={Boolean(userId)}
            />
            {CREDIT_PACKS.map((p) => {
              const { autofills, listings } = packReach(p.credits, listingCost);
              const popular = p.id === POPULAR_PACK_ID;
              return (
                <div
                  key={p.id}
                  className={`relative flex flex-col rounded-2xl border bg-white p-6 shadow-sm ${popular ? "border-orange-300" : "border-zinc-200"}`}
                >
                  {popular && (
                    <span className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-orange-500 px-3 py-0.5 text-xs font-semibold uppercase tracking-wide text-white">
                      Popular
                    </span>
                  )}
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-orange-50 text-orange-500">
                    <Coins className="h-5 w-5" />
                  </div>
                  <h3 className="mt-5 text-lg font-bold">{p.credits} credits</h3>
                  <p className="mt-1 text-3xl font-bold">GHS {p.amountGhs}</p>
                  <ul className="mt-5 flex-1 space-y-2.5 text-sm text-zinc-700">
                    <li className="flex items-start gap-2">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                      {listings === autofills ? `${listings} listings, on WhatsApp or the extension` : `${listings} live WhatsApp listings`}
                    </li>
                    {listings !== autofills && (
                      <li className="flex items-start gap-2">
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                        or {autofills} extension autofills
                      </li>
                    )}
                    <li className="flex items-start gap-2">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                      Never expires
                    </li>
                    {/* What the pack includes while it's the last one bought (lib/billing/features.ts). */}
                    {packFeatures(p.id).map((f) => (
                      <li key={f.id} className="flex items-start gap-2 font-medium">
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                        {f.label}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-6">
                    {billingOn && userId ? (
                      <BuyCreditsButton className="h-11 w-full rounded-lg" label="Buy credits" listingCost={listingCost} />
                    ) : (
                      <Link
                        href={userId ? DASHBOARD_REDIRECT : signUpHref}
                        className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-zinc-300 bg-white px-4 text-sm font-semibold text-zinc-700 transition-colors hover:border-zinc-900 hover:bg-zinc-900 hover:text-white"
                      >
                        {userId ? "Open dashboard" : "Start free"}
                        <ArrowRight className="h-4 w-4" />
                      </Link>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="border-t border-zinc-100 bg-white">
        <div className="mx-auto max-w-3xl px-6 py-20">
          <h2 className="text-2xl font-bold sm:text-3xl">Frequently asked</h2>
          <dl className="mt-8 space-y-6">
            <FAQ
              q="Is there a subscription?"
              a="No. You buy credits when you need them and spend them as you list. There's nothing to cancel."
            />
            <FAQ
              q="Do credits expire?"
              a="No. Credits you buy stay on your account until you use them."
            />
            <FAQ
              q="When is a WhatsApp listing charged?"
              a={`When Jumia accepts it. Drafting, redrafting and fixing are free, and a listing Jumia rejects costs nothing. While a listing waits for Jumia's review, its ${listingCost} credits are set aside so you can't submit more than your balance covers.`}
            />
            <FAQ
              q="What do the bigger packs unlock?"
              a={`Every pack, and your free credits, include listing on WhatsApp and the website, the Jumia Listing Assistant (chatting is free), your Jumia orders (packing, ready to ship, cancelling), reading your shop (products, stock, sales, reports, payouts, fees), the shop health report (${REPORT_CREDIT_COST} credits) and image polish, which turns your own photos into four product images in the chat or the Chrome extension (${POLISH_CREDIT_COST} credits an image). The Standard pack and bigger add changes to your live Jumia products from the chat, Jumia QC rejection alerts and guided fixes (when Jumia's quality check rejects a listing after accepting it, we tell you why, return its credits, and help you fix and resubmit it), and shipping labels on WhatsApp (${LABEL_CREDIT_COST} credits a label). Pro and Business add order alerts on WhatsApp and the Jumia fee calculator for your country in the Chrome extension. To buy a pack, link your WhatsApp and connect your Jumia account first. Your pack's features come from the last pack you bought, and everything works while you have credits: at 0 it pauses until you top up.`}
            />
            <FAQ
              q="Why is the Chrome extension charged per autofill?"
              a="With the extension you submit the product on Vendor Center yourself, so we can't see whether it went live. Each autofill is charged instead."
            />
            <FAQ
              q="Is chatting with the assistant charged?"
              a="No. Chatting is free and unlimited, on WhatsApp and in the Jumia Listing Assistant, on every pack and on free credits. Only what's listed above costs credits."
            />
            <FAQ
              q="Do the same credits work on WhatsApp and the Chrome extension?"
              a="Yes. One balance covers both."
            />
            <FAQ
              q="What payment methods do you accept?"
              a="Paystack: Ghana cards (Visa, Mastercard, Verve), mobile money (MTN, AirtelTigo, Telecel) and bank transfer. International Visa and Mastercard work too, with Paystack's international fee."
            />
            <FAQ
              q="What about VAT / NHIL?"
              a="Prices shown are the amount Paystack collects. If you need a VAT invoice for your business records, contact us through the support button."
            />
          </dl>
        </div>
      </section>

      <section className="bg-zinc-50">
        <div className="mx-auto max-w-3xl px-6 py-20 text-center">
          <h2 className="text-2xl font-bold sm:text-3xl">Ready when you are.</h2>
          <p className="mt-3 text-base text-zinc-600">{FREE_SIGNUP_CREDITS} free credits. No card. Pay only for what goes live.</p>
          <Link
            href={userId ? DASHBOARD_REDIRECT : signUpHref}
            className="mt-8 inline-flex items-center justify-center gap-2 rounded-lg bg-orange-500 px-6 py-3 text-sm font-semibold text-white shadow-md shadow-orange-500/20 transition-all hover:bg-orange-600"
          >
            {userId ? "Open dashboard" : "Get started"}
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}

/** Free: the sign-up credits, what they reach, and what every plan has. */
function FreeCard({ listingCost, href, signedIn }: { listingCost: number; href: string; signedIn: boolean }) {
  const { autofills, listings } = packReach(FREE_SIGNUP_CREDITS, listingCost);
  return (
    <div className="relative flex flex-col rounded-2xl border border-emerald-200 bg-white p-6 shadow-sm">
      <span className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-emerald-500 px-3 py-0.5 text-xs font-semibold uppercase tracking-wide text-white">
        Start here
      </span>
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600">
        <Gift className="h-5 w-5" />
      </div>
      <h3 className="mt-5 text-lg font-bold">Free</h3>
      <p className="mt-1 text-3xl font-bold">GHS 0</p>
      <ul className="mt-5 flex-1 space-y-2.5 text-sm text-zinc-700">
        <li className="flex items-start gap-2">
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
          {FREE_SIGNUP_CREDITS} credits when you sign up
        </li>
        <li className="flex items-start gap-2">
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
          {listings === autofills ? `${listings} listings, on WhatsApp or the extension` : `${listings} live WhatsApp listings, or ${autofills} extension autofills`}
        </li>
        <li className="flex items-start gap-2">
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
          No card, no subscription
        </li>
        <li className="flex items-start gap-2">
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
          Chatting with the Listing Assistant is free
        </li>
        {everyoneFeatures().map((f) => (
          <li key={f.id} className="flex items-start gap-2 font-medium">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
            {f.label}
          </li>
        ))}
      </ul>
      <div className="mt-6">
        <Link
          href={href}
          className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-emerald-700"
        >
          {signedIn ? "Open dashboard" : "Start free"}
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </div>
  );
}

function FAQ({ q, a }: { q: string; a: string }) {
  return (
    <div>
      <dt className="text-base font-semibold text-zinc-900">{q}</dt>
      <dd className="mt-2 text-base leading-relaxed text-zinc-600">{a}</dd>
    </div>
  );
}
