import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { HomeFloatingNav } from "@/components/marketing/home-floating-nav";
import { MarketingFooter } from "@/components/marketing/footer";
import { BreadcrumbLd } from "@/components/marketing/breadcrumb-ld";
import { FaqList } from "@/components/marketing/faq-list";
import { isBillingEnabled } from "@/lib/billing/mode";
import { faqSections } from "@/lib/marketing/faq";
import { CALCULATOR_HREF, SIGN_IN_HREF, SIGN_UP_HREF } from "@/lib/marketing/links";
import { COMMUNITY_WHATSAPP_URL, SUPPORT_EMAIL, SUPPORT_MAILTO } from "@/lib/constants/support";

// ─── /faq — public, indexable ─────────────────────────────────────────────────
//
// Open to everyone (the owner's call: a seller deciding whether to sign up
// has the same questions), and linked from the dashboard sidebar and the
// footer. Content lives in lib/marketing/faq.tsx. Rendered per request so
// the Credits answers follow the billing switch.

export const metadata: import("next").Metadata = {
  title:       "PandaWorld FAQ: Listing on Jumia from WhatsApp and Chrome",
  description: "How PandaWorld writes Jumia listings from your photos: connecting Vendor Center, the two ways to send products on WhatsApp, Held products, categories, and credits.",
  alternates:  { canonical: "/faq" },
  openGraph:   { title: "PandaWorld FAQ", description: "Answers about listing on Jumia with PandaWorld.", type: "website" },
};

const linkClass = "font-medium text-orange-600 hover:underline";

export default async function FaqPage() {
  const { userId } = await auth();
  const billingOn = await isBillingEnabled();
  const sections = faqSections(billingOn);

  const faqLd = {
    "@context": "https://schema.org",
    "@type":    "FAQPage",
    mainEntity: sections.flatMap((s) => s.items).map((item) => ({
      "@type": "Question",
      name:    item.q,
      acceptedAnswer: { "@type": "Answer", text: item.text },
    })),
  };

  return (
    <div className="min-h-screen bg-white text-zinc-900">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqLd) }} />
      <BreadcrumbLd items={[["PandaWorld", "/"], ["FAQ", "/faq"]]} />
      <HomeFloatingNav signInHref={SIGN_IN_HREF} signUpHref={SIGN_UP_HREF} calculatorHref={CALCULATOR_HREF} pricingLive={billingOn} />

      <div className="mx-auto max-w-3xl px-6 pb-16 pt-12 sm:pt-16">
        <p className="text-sm font-semibold uppercase tracking-widest text-orange-500">Help</p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight sm:text-5xl">Frequently asked questions</h1>
        <p className="mt-4 text-lg leading-relaxed text-zinc-600">
          Quick answers. For step-by-step help, see the <Link href="/how-to" className={linkClass}>guides</Link>.
        </p>

        <div className="mt-10">
          <FaqList sections={sections} />
        </div>

        <p className="mt-10 text-base text-zinc-600">
          Still stuck? Ask in the{" "}
          <a href={COMMUNITY_WHATSAPP_URL} target="_blank" rel="noopener noreferrer" className={linkClass}>WhatsApp community</a>{" "}
          or email <a href={SUPPORT_MAILTO} className={linkClass}>{SUPPORT_EMAIL}</a>.
        </p>
      </div>

      <MarketingFooter extensionPricing={billingOn ? undefined : { signedIn: Boolean(userId), signInHref: SIGN_IN_HREF }} />
    </div>
  );
}
