import Link from "next/link";
import { MarketingFooter } from "@/components/marketing/footer";
import { MarketingHeader } from "@/components/marketing/header";
import { MarketingButton } from "@/components/marketing/button";
import { LINE, MUTED, PAGE_BG, TEXT, MARKETING_FONT } from "@/components/marketing/palette";
import { CHROME_WEB_STORE_URL } from "@/lib/constants/support";

const PAGE_TITLE = "Chrome extension for Jumia Vendor Center | PandaWorld";
const PAGE_DESCRIPTION =
  "PandaWorld opens as a side panel next to Jumia Vendor Center. Add a photo and a category, click Autofill, review the form, and submit.";

export const metadata: import("next").Metadata = {
  title: PAGE_TITLE,
  description: PAGE_DESCRIPTION,
  openGraph: { title: PAGE_TITLE, description: PAGE_DESCRIPTION, type: "website" },
  twitter: { title: PAGE_TITLE, description: PAGE_DESCRIPTION },
  alternates: { canonical: "/jumia-vendor-center-extension" },
};

const STEPS = [
  "Install the extension and pin it — it opens as a side panel next to Jumia Vendor Center.",
  "Start a listing on Jumia like normal, add a product photo, and pick a category.",
  "Click Autofill. PandaWorld fills in the title, description, highlights, and attributes.",
  "Review the form, tweak anything that needs it, and submit.",
];

export default function JumiaVendorCenterExtensionPage() {
  return (
    <div className="min-h-screen" style={{ backgroundColor: PAGE_BG, color: TEXT, fontFamily: MARKETING_FONT }}>
      <MarketingHeader ctaHref="/sign-up" ctaLabel="Get Started" />

      <section className="mx-auto max-w-3xl px-6 py-16 sm:py-20">
        <h1 className="max-w-2xl text-3xl font-bold leading-tight sm:text-4xl">
          Autofill Jumia Vendor Center from Chrome
        </h1>
        <p className="mt-5 max-w-xl text-base leading-relaxed sm:text-lg" style={{ color: MUTED }}>
          The extension sits beside the Vendor Center &quot;Add Products&quot; form. Add a photo and a category, click Autofill, review, then submit. Free while we test.
        </p>
        <div className="mt-8">
          <MarketingButton href={CHROME_WEB_STORE_URL} external>
            Add to Chrome
          </MarketingButton>
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
            <Link href="/jumia-whatsapp-listings" className="underline hover:opacity-70" style={{ color: TEXT }}>
              Jumia listings from WhatsApp
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
