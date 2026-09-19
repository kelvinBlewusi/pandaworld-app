import Link from "next/link";
import { MarketingFooter } from "@/components/marketing/footer";
import { MarketingHeader } from "@/components/marketing/header";
import { MarketingButton } from "@/components/marketing/button";
import { LINE, MUTED, PAGE_BG, TEXT, MARKETING_FONT } from "@/components/marketing/palette";

const PAGE_TITLE = "Jumia listings from WhatsApp | PandaWorld";
const PAGE_DESCRIPTION =
  "Send product photos and a price on WhatsApp. PandaWorld drafts the Jumia listing and sends it back — you review it, reply submit, and it goes live.";

export const metadata: import("next").Metadata = {
  title: PAGE_TITLE,
  description: PAGE_DESCRIPTION,
  openGraph: { title: PAGE_TITLE, description: PAGE_DESCRIPTION, type: "website" },
  twitter: { title: PAGE_TITLE, description: PAGE_DESCRIPTION },
  alternates: { canonical: "/jumia-whatsapp-listings" },
};

const STEPS = [
  "Link your WhatsApp to your PandaWorld account.",
  "Send a photo of the product, with the price and any notes in the same message.",
  "PandaWorld drafts the Jumia listing — title, category, attributes — and sends it back to you.",
  "Reply “submit” and it goes to your Jumia Vendor Center.",
];

export default function JumiaWhatsAppListingsPage() {
  return (
    <div className="min-h-screen" style={{ backgroundColor: PAGE_BG, color: TEXT, fontFamily: MARKETING_FONT }}>
      <MarketingHeader ctaHref="/sign-up" ctaLabel="Get Started" />

      <section className="mx-auto max-w-3xl px-6 py-16 sm:py-20">
        <h1 className="max-w-2xl text-3xl font-bold leading-tight sm:text-4xl">
          List on Jumia from WhatsApp
        </h1>
        <p className="mt-5 max-w-xl text-base leading-relaxed sm:text-lg" style={{ color: MUTED }}>
          No app to open. Send a photo and a price on WhatsApp, review the draft PandaWorld sends back, and reply submit. Free while we test.
        </p>
        <div className="mt-8">
          <MarketingButton href="/sign-up">List from WhatsApp</MarketingButton>
        </div>
      </section>

      <section className="border-t" style={{ borderColor: LINE }}>
        <div className="mx-auto max-w-3xl px-6 py-16">
          <h2 className="text-xl font-bold">How it works</h2>
          <ol className="mt-5 max-w-2xl space-y-3 text-sm leading-relaxed" style={{ color: MUTED }}>
            {STEPS.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </div>
      </section>

      <section className="border-t" style={{ borderColor: LINE }}>
        <div className="mx-auto max-w-3xl px-6 py-10">
          <p className="text-sm font-semibold">Related</p>
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <Link href="/" className="underline hover:opacity-70" style={{ color: TEXT }}>
              Homepage
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

      <MarketingFooter />
    </div>
  );
}
