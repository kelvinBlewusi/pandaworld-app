import Link from "next/link";
import { Check, Sparkles, Zap, Rocket, Briefcase, ArrowRight } from "lucide-react";
import { MarketingFooter } from "@/components/marketing/footer";
import { Wordmark } from "@/components/marketing/wordmark";
import { getPublicPlans, type Plan } from "@/lib/billing/plans";

// ─── Public pricing ──────────────────────────────────────────────────────────
//
// Lives outside the (main) layout so logged-out visitors can read pricing
// without bouncing through Clerk. Every tier number comes from
// lib/billing/plans.ts — change a price/quota there and this page updates.
//
// SEO note: this page is intentionally text-heavy (rather than a
// React-only spec) so the GHS amounts get indexed by Google and surface
// in seller searches like "Jumia listing tool Ghana price".

// Per-page metadata — overrides the root layout's defaults for SEO.
// The title template `%s · PandaWorld` in app/layout.tsx renders this
// as "Pricing · PandaWorld" in the browser tab + SERP.
export const metadata: import("next").Metadata = {
  title:       "Pricing — Jumia Africa Listing Tool",
  description: "PandaWorld pricing for Jumia sellers across Africa. Free for 5 listings/month. Starter GHS 30, Pro GHS 65, Business GHS 120 per month. Pay with Mobile Money or card. Cancel any time.",
  keywords: [
    "PandaWorld pricing",
    "Jumia tool pricing",
    "AI listing tool cost",
    "Jumia seller subscription",
    "Jumia Africa pricing",
    "Jumia Nigeria tool cost",
    "Jumia Kenya pricing",
  ],
  openGraph: {
    title:       "Pricing — PandaWorld for Jumia Africa Sellers",
    description: "Free for 5 listings/month. Paid plans from GHS 30/month. Pay with Mobile Money or card. Cancel any time.",
    type:        "website",
  },
  alternates: {
    canonical: "/pricing",
  },
};

// Map each tier id to a Lucide icon. Kept here (not in plans.ts) because
// the icon set is React-only — plans.ts is consumed by server code that
// can't import lucide-react cleanly.
const TIER_ICON: Partial<Record<Plan, { Icon: React.ElementType; bg: string }>> = {
  free:     { Icon: Sparkles,  bg: "bg-zinc-100 text-zinc-600" },
  starter:  { Icon: Zap,       bg: "bg-emerald-50 text-emerald-600" },
  pro:      { Icon: Rocket,    bg: "bg-blue-50 text-blue-600" },
  business: { Icon: Briefcase, bg: "bg-purple-50 text-purple-600" },
};

export default function PricingPage() {
  const tiers = getPublicPlans();

  return (
    <div className="min-h-screen bg-white text-zinc-900">
      <MarketingNav />

      <section className="border-b border-zinc-100">
        <div className="mx-auto max-w-6xl px-6 py-20 text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-orange-500">
            Pricing
          </p>
          <h1 className="mt-3 text-3xl font-bold tracking-tight sm:text-5xl">
            Pick the plan that fits your store.
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-zinc-600 sm:text-base">
            5 free listings every month, no card needed. Move to a paid
            plan when you scale. Cancel any time.
          </p>
        </div>
      </section>

      {/* Pricing cards */}
      <section className="bg-zinc-50">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-4">
            {tiers.map((tier) => {
              const iconConfig = TIER_ICON[tier.id] ?? TIER_ICON.free!;
              return (
                <PricingCard
                  key={tier.id}
                  tier={tier.name}
                  price={tier.display_price}
                  period={tier.period === "month" ? "/ month" : "forever"}
                  tagline={tier.description}
                  icon={iconConfig.Icon}
                  iconBg={iconConfig.bg}
                  badge={tier.badge}
                  features={tier.features}
                  ctaLabel={tier.id === "free" ? "Start free" : `Choose ${tier.name}`}
                  ctaHref="/sign-up"
                />
              );
            })}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="border-t border-zinc-100 bg-white">
        <div className="mx-auto max-w-3xl px-6 py-20">
          <h2 className="text-2xl font-bold sm:text-3xl">
            Frequently asked
          </h2>
          <dl className="mt-8 space-y-6">
            <FAQ
              q="What counts as a listing?"
              a="A product you've created in PandaWorld, with AI-generated title, description, attributes, and images. You can edit a draft as many times as you like — only the act of CREATING a new draft uses up your monthly quota. Pushing the same listing to Jumia multiple times (e.g. after a QC fix) doesn't cost extra."
            />
            <FAQ
              q="What's the difference between a listing and an image polish?"
              a="A listing is the analysis pass (title, description, category, attributes). An image polish is when you ask us to clean up a product photo — remove the background, add a white studio look, or rebuild it with AI. They're metered separately so a seller who doesn't need polishing doesn't pay for it."
            />
            <FAQ
              q="What happens when I hit my monthly quota?"
              a="You'll see an upgrade prompt naming the next tier. Existing listings stay live; only NEW listing creation is paused until you upgrade or the next billing period starts (the quota resets automatically 30 days after your last payment)."
            />
            <FAQ
              q="Can I cancel any time?"
              a="Yes. Cancel from Settings → Billing. You keep your paid tier features until the end of the current billing period, then drop back to Free. No long-term contracts."
            />
            <FAQ
              q="What payment methods do you accept?"
              a="Paystack — local Ghana cards (Visa, Mastercard, Verve), mobile money (MTN, AirtelTigo, Vodafone), and bank transfer. International Visa and Mastercard accepted with the international transaction fee Paystack charges."
            />
            <FAQ
              q="Do I keep my listings if I cancel?"
              a="Yes. Existing listings stay in your dashboard and live on Jumia. You just can't create new ones above the Free-tier cap until you re-upgrade."
            />
            <FAQ
              q="Is there a free trial?"
              a="The Free plan IS the trial. You get 5 listings each month forever — enough to evaluate whether a paid plan is worth it for your volume."
            />
            <FAQ
              q="What about VAT / NHIL?"
              a="Pricing shown is the gross amount Paystack collects. If you need a VAT invoice for business expense reporting, email us at the contact on the support button."
            />
          </dl>
        </div>
      </section>

      {/* CTA */}
      <section className="bg-zinc-50">
        <div className="mx-auto max-w-3xl px-6 py-20 text-center">
          <h2 className="text-2xl font-bold sm:text-3xl">
            Ready when you are.
          </h2>
          <p className="mt-3 text-sm text-zinc-600">
            5 free listings every month. No card. Cancel any time.
          </p>
          <Link
            href="/sign-up"
            className="mt-8 inline-flex items-center justify-center gap-2 rounded-lg bg-orange-500 px-6 py-3 text-sm font-semibold text-white shadow-md shadow-orange-500/20 transition-all hover:bg-orange-600"
          >
            Get started
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}

// ─── Components ──────────────────────────────────────────────────────────────

function MarketingNav() {
  return (
    <header className="sticky top-0 z-20 border-b border-zinc-100 bg-white/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link href="/" aria-label="pandaworld home">
          <Wordmark size={28} />
        </Link>
        <nav className="flex items-center gap-1 sm:gap-4">
          <Link
            href="/pricing"
            className="rounded-md px-3 py-1.5 text-sm font-medium text-orange-600"
          >
            Pricing
          </Link>
          <Link
            href="/sign-in"
            className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900"
          >
            Sign in
          </Link>
          <Link
            href="/sign-up"
            className="rounded-md bg-orange-500 px-3 py-1.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-orange-600"
          >
            Get started
          </Link>
        </nav>
      </div>
    </header>
  );
}

interface PricingCardProps {
  tier:      string;
  price:     string;
  period:    string;
  tagline:   string;
  icon:      React.ElementType;
  iconBg:    string;
  features:  string[];
  ctaLabel:  string;
  ctaHref:   string;
  badge?:    string;
}

function PricingCard({
  tier,
  price,
  period,
  tagline,
  icon: Icon,
  iconBg,
  features,
  ctaLabel,
  ctaHref,
  badge,
}: PricingCardProps) {
  // May 2026 redesign — match the macOS-style toast aesthetic on
  // /settings/billing. All four tier cards are visually equal-weight
  // (no orange highlight on "Most popular"), with neutral text-only
  // badges. The hover lift is the only differentiation, and only when
  // the card is actually interactive.
  return (
    <div
      className="relative flex flex-col rounded-2xl border border-zinc-200/70 bg-white/95 p-6 shadow-sm transition-all duration-200 [backdrop-filter:saturate(1.5)_blur(16px)] hover:shadow-md hover:border-zinc-300"
    >
      {badge && (
        <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-zinc-200 bg-white px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-600 shadow-sm">
          {badge}
        </span>
      )}
      <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${iconBg}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="mt-5 flex items-baseline justify-between">
        <h3 className="text-lg font-bold">{tier}</h3>
      </div>
      <p className="mt-0.5 text-[11px] text-zinc-500">{tagline}</p>
      <div className="mt-3 flex items-baseline gap-1">
        <span className="text-3xl font-bold">{price}</span>
        <span className="text-sm text-zinc-500">{period}</span>
      </div>
      <ul className="mt-5 flex-1 space-y-2.5">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-2">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
            <span className="text-xs text-zinc-700">{f}</span>
          </li>
        ))}
      </ul>
      {/* CTA wrapper — mt-auto pins the button to the bottom of every
          card so all four CTAs sit on the same y-line, even when the
          feature lists differ in length. h-11 keeps button heights
          identical across cards (mobile + desktop). */}
      <div className="mt-6 pt-1">
        <Link
          href={ctaHref}
          className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-zinc-300 bg-white px-4 text-sm font-semibold text-zinc-700 transition-colors hover:bg-zinc-900 hover:text-white hover:border-zinc-900"
        >
          {ctaLabel}
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </div>
  );
}

function FAQ({ q, a }: { q: string; a: string }) {
  return (
    <div>
      <dt className="text-sm font-semibold text-zinc-900">{q}</dt>
      <dd className="mt-2 text-sm leading-relaxed text-zinc-600">{a}</dd>
    </div>
  );
}
