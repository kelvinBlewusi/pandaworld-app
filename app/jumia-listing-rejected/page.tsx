import Link from "next/link";
import { MarketingFooter } from "@/components/marketing/footer";
import { MarketingHeader } from "@/components/marketing/header";
import { LINE, MUTED, PAGE_BG, TEXT, MARKETING_FONT } from "@/components/marketing/palette";

const PAGE_TITLE = "Why Jumia rejected your listing | PandaWorld";
const PAGE_DESCRIPTION =
  "The real reasons Jumia rejects a listing — category too broad, Generic on fashion, decimal capacities, missing sale dates, invalid variations — and what to send instead.";

export const metadata: import("next").Metadata = {
  title: PAGE_TITLE,
  description: PAGE_DESCRIPTION,
  openGraph: { title: PAGE_TITLE, description: PAGE_DESCRIPTION, type: "website" },
  twitter: { title: PAGE_TITLE, description: PAGE_DESCRIPTION },
  alternates: { canonical: "/jumia-listing-rejected" },
};

const REASONS = [
  {
    q: "Category is too broad",
    a: "Jumia needs a specific, sellable category, not a top-level department. Putting a dress under “Fashion” instead of “Women's Dresses” gets it rejected. Send the most specific category the product actually fits.",
  },
  {
    q: "Brand set to “Generic” on a fashion item",
    a: "Jumia doesn't accept “Generic” as a brand for clothing and fashion accessories. Send the real brand name, or “Fashion” if the product genuinely has no brand.",
  },
  {
    q: "A capacity or size sent as a decimal",
    a: "Some attributes — like storage size or capacity — only accept whole numbers on Jumia. Sending “2.0 L” instead of “2 L” gets the listing rejected. Round to a whole number, or the closest option Jumia allows for that attribute.",
  },
  {
    q: "A sale price with no sale dates, or only one date",
    a: "A sale price needs both a start date and an end date — Jumia rejects a sale price with a missing or partial date range. Either give both dates, or leave the sale price off the listing.",
  },
  {
    q: "A color or variation value that isn't on Jumia's list",
    a: "Variation attributes (color, size) only accept values from Jumia's own list for that category. An invented or misspelled value gets rejected. Pick from the allowed options for that attribute instead.",
  },
];

export default function JumiaListingRejectedPage() {
  return (
    <div className="min-h-screen" style={{ backgroundColor: PAGE_BG, color: TEXT, fontFamily: MARKETING_FONT }}>
      <MarketingHeader ctaHref="/sign-up" ctaLabel="Get Started" />

      <section className="mx-auto max-w-3xl px-6 py-16 sm:py-20">
        <h1 className="max-w-2xl text-3xl font-bold leading-tight sm:text-4xl">
          Why Jumia rejected your listing
        </h1>
        <p className="mt-5 max-w-xl text-base leading-relaxed sm:text-lg" style={{ color: MUTED }}>
          The most common reasons a Jumia listing gets rejected, in plain language, and what to send instead. PandaWorld checks for these before you submit.
        </p>
      </section>

      <section className="border-t" style={{ borderColor: LINE }}>
        <div className="mx-auto max-w-3xl px-6 py-16">
          <h2 className="text-xl font-bold">Common reasons</h2>
          <dl className="mt-6 space-y-8">
            {REASONS.map((r) => (
              <div key={r.q}>
                <dt className="font-semibold">{r.q}</dt>
                <dd className="mt-2 text-sm leading-relaxed" style={{ color: MUTED }}>{r.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="border-t" style={{ borderColor: LINE }}>
        <div className="mx-auto max-w-3xl px-6 py-10">
          <p className="text-sm font-semibold">Related</p>
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <Link href="/" className="underline hover:opacity-70" style={{ color: TEXT }}>
              Homepage
            </Link>
            <Link href="/jumia-whatsapp-listings" className="underline hover:opacity-70" style={{ color: TEXT }}>
              Jumia listings from WhatsApp
            </Link>
            <Link href="/jumia-vendor-center-extension" className="underline hover:opacity-70" style={{ color: TEXT }}>
              Chrome extension for Jumia Vendor Center
            </Link>
            <Link href="/pricing" className="underline hover:opacity-70" style={{ color: TEXT }}>
              Pricing
            </Link>
          </div>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}
