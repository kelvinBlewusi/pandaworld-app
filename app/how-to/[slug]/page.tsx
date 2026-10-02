import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { ArrowRight } from "lucide-react";
import { HomeFloatingNav } from "@/components/marketing/home-floating-nav";
import { MarketingFooter } from "@/components/marketing/footer";
import { GuideMedia } from "@/components/marketing/guide-media";
import { GuideSteps } from "@/components/marketing/guide-steps";
import { WhatsAppSendingModes } from "@/components/marketing/whatsapp-sending-modes";
import { BreadcrumbLd } from "@/components/marketing/breadcrumb-ld";
import { isBillingEnabled } from "@/lib/billing/mode";
import { GUIDES, getGuide } from "@/lib/marketing/guides";
import { CALCULATOR_HREF, SIGN_IN_HREF, SIGN_UP_HREF } from "@/lib/marketing/links";

// ─── /how-to/<slug> — one guide per page ──────────────────────────────────────
//
// Each guide has its own URL, title and description so it can rank for the
// search it answers ("how to connect Jumia Vendor Center", "list on Jumia
// from WhatsApp"), where one /how-to page could only rank for one of them.
// Content lives in lib/marketing/guides.ts.

// Rendered per request, like the other public pages: the nav and footer
// follow the billing switch (lib/billing/mode.ts), which a build-time page
// would freeze. Unknown slugs 404 below.

export function generateMetadata({ params }: { params: { slug: string } }): import("next").Metadata {
  const guide = getGuide(params.slug);
  if (!guide) return {};
  return {
    title:       guide.metaTitle,
    description: guide.description,
    alternates:  { canonical: `/how-to/${guide.slug}` },
    openGraph:   { title: guide.metaTitle, description: guide.description, type: "article" },
  };
}

export default async function GuidePage({ params }: { params: { slug: string } }) {
  const guide = getGuide(params.slug);
  if (!guide) notFound();

  const { userId } = await auth();
  const billingOn = await isBillingEnabled();
  const others = GUIDES.filter((g) => g.slug !== guide.slug);

  return (
    <div className="min-h-screen bg-white text-zinc-900">
      <BreadcrumbLd items={[["PandaWorld", "/"], ["Guides", "/how-to"], [guide.metaTitle, `/how-to/${guide.slug}`]]} />
      <HomeFloatingNav signInHref={SIGN_IN_HREF} signUpHref={SIGN_UP_HREF} calculatorHref={CALCULATOR_HREF} pricingLive={billingOn} />

      <article className="mx-auto max-w-3xl px-6 pb-16 pt-12 sm:pt-16">
        <nav aria-label="Breadcrumb" className="text-sm text-zinc-500">
          <Link href="/how-to" className="hover:text-zinc-900">Guides</Link>
          <span className="mx-2">›</span>
          <span className="text-zinc-700">{guide.title}</span>
        </nav>

        <div className="mt-6 flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-orange-500 text-white">
            <guide.Icon className="h-5 w-5" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{guide.metaTitle}</h1>
        </div>
        <p className="mt-4 text-lg leading-relaxed text-zinc-600">{guide.intro}</p>

        <h2 className="mt-10 text-xl font-bold">Steps</h2>
        <div className="mt-4">
          <GuideSteps steps={guide.steps} />
        </div>

        {guide.sendingModes && (
          <div className="mt-10">
            <WhatsAppSendingModes />
          </div>
        )}

        <div className="mt-10">
          <GuideMedia guide={guide} />
        </div>

        <div className="mt-12 rounded-2xl bg-orange-50 p-6 text-center">
          <p className="text-lg font-semibold">Ready to list faster on Jumia?</p>
          <Link
            href={userId ? "/extension/dashboard" : SIGN_UP_HREF}
            className="mt-4 inline-flex items-center justify-center gap-2 rounded-full bg-orange-500 px-6 py-3 text-base font-medium text-white transition-colors hover:bg-orange-600"
          >
            {userId ? "Open dashboard" : "Get started free"}
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>

        <section className="mt-12">
          <h2 className="text-xl font-bold">More guides</h2>
          <ul className="mt-4 space-y-3">
            {others.map((g) => (
              <li key={g.slug}>
                <Link href={`/how-to/${g.slug}`} className="group flex items-start gap-3 rounded-xl border border-zinc-200 p-4 hover:border-zinc-300">
                  <g.Icon className="mt-0.5 h-5 w-5 shrink-0 text-orange-500" />
                  <span>
                    <span className="font-semibold text-zinc-900 group-hover:underline">{g.metaTitle}</span>
                    <span className="mt-1 block text-sm text-zinc-500">{g.description}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </article>

      <MarketingFooter extensionPricing={billingOn ? undefined : { signedIn: Boolean(userId), signInHref: SIGN_IN_HREF }} />
    </div>
  );
}
