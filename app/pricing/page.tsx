import { MarketingFooter } from "@/components/marketing/footer";
import { MarketingHeader } from "@/components/marketing/header";
import { MarketingButton } from "@/components/marketing/button";
import { MUTED, PAGE_BG, TEXT, MARKETING_FONT } from "@/components/marketing/palette";

// ─── Public pricing ──────────────────────────────────────────────────────────
//
// Lives outside the (main) layout so logged-out visitors can read it without
// bouncing through Clerk. No pricing is set yet — everything is free while
// we test, so this page is a single sentence, not a plan grid.

const PAGE_TITLE = "Pricing — PandaWorld";
const PAGE_DESCRIPTION = "Free while we test. Pricing comes later.";

export const metadata: import("next").Metadata = {
  title: PAGE_TITLE,
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
  alternates: {
    canonical: "/pricing",
  },
};

export default function PricingPage() {
  return (
    <div
      className="min-h-screen"
      style={{ backgroundColor: PAGE_BG, color: TEXT, fontFamily: MARKETING_FONT }}
    >
      <MarketingHeader ctaHref="/sign-up" ctaLabel="Get Started" />

      <section className="mx-auto max-w-2xl px-6 py-24 text-center sm:py-32">
        <h1 className="text-3xl font-bold sm:text-4xl">Free while we test.</h1>
        <p className="mt-4 text-lg" style={{ color: MUTED }}>Pricing comes later.</p>
        <div className="mt-8">
          <MarketingButton href="/sign-up">Get started</MarketingButton>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}
