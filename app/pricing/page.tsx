import Link from "next/link";
import { Check, Sparkles, Zap, ArrowRight } from "lucide-react";
import { MarketingFooter } from "@/components/marketing/footer";

// ─── Public pricing ──────────────────────────────────────────────────────────
//
// Lives outside the (main) layout so logged-out visitors can read pricing
// without bouncing through Clerk. Mirrors the in-app /settings/billing
// numbers exactly — single source of truth in two files; if you change
// the price, change both.
//
// SEO note: this page is intentionally text-heavy (rather than a
// React-only spec) so the GHS 50 / Free terms get indexed by Google
// and surface in seller searches like "Jumia listing tool Ghana price".

export const metadata = {
  title:       "Pricing · PandaWorld",
  description: "Free for your first 5 listings. GHS 50 / month for unlimited AI-generated Jumia listings, image enhancement, and one-click push to Vendor Center.",
};

export default function PricingPage() {
  return (
    <div className="min-h-screen bg-white text-zinc-900">
      <MarketingNav />

      <section className="border-b border-zinc-100">
        <div className="mx-auto max-w-6xl px-6 py-20 text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-orange-500">
            Pricing
          </p>
          <h1 className="mt-3 text-3xl font-bold tracking-tight sm:text-5xl">
            Free until you scale. Then GHS 50 / month.
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-zinc-600 sm:text-base">
            Start with 5 free listings. Upgrade to Pro when you&apos;re ready
            for unlimited generations and priority support. Cancel any time.
          </p>
        </div>
      </section>

      {/* Pricing cards */}
      <section className="bg-zinc-50">
        <div className="mx-auto max-w-5xl px-6 py-16">
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <PricingCard
              tier="Free"
              price="GHS 0"
              period="forever"
              tagline="Try it out"
              icon={Sparkles}
              iconBg="bg-zinc-100 text-zinc-600"
              features={[
                "5 product listings",
                "AI listing generation",
                "Image polish (white background)",
                "Push to Jumia Vendor Center",
                "Price calculator",
                "Email support",
              ]}
              ctaLabel="Start free"
              ctaHref="/sign-up"
            />
            <PricingCard
              tier="Pro"
              price="GHS 50"
              period="/ month"
              tagline="For serious sellers"
              icon={Zap}
              iconBg="bg-blue-50 text-blue-600"
              badge="Most popular"
              features={[
                "Unlimited product listings",
                "AI listing generation",
                "Image polish + AI rebuild (studio shots)",
                "Push to Jumia Vendor Center",
                "Price calculator",
                "Priority support",
                "Early access to new features",
              ]}
              ctaLabel="Upgrade to Pro"
              ctaHref="/sign-up"
              highlight
            />
          </div>

          <p className="mt-8 text-center text-xs text-zinc-500">
            Prices in Ghana Cedis (GHS). Pro billing via Paystack — local
            cards 1.95%, international 3.9% + ₦100 processed by Paystack.
            Cancel any time from Settings → Billing.
          </p>
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
              q="Can I cancel any time?"
              a="Yes. Cancel from Settings → Billing. You keep Pro features until the end of the current billing period, then drop back to Free (5-listing cap). No long-term contracts."
            />
            <FAQ
              q="What payment methods do you accept?"
              a="Paystack — local Ghana cards (Visa, Mastercard, Verve), mobile money (MTN, AirtelTigo, Vodafone), and bank transfer. International Visa and Mastercard are accepted with the international transaction fee Paystack charges."
            />
            <FAQ
              q="Do I keep my listings if I cancel?"
              a="Yes. Your existing listings stay in your dashboard and stay live on Jumia. You just can't create new ones above the Free-tier cap until you re-upgrade."
            />
            <FAQ
              q="Is there a free trial of Pro?"
              a="Not separately — the Free plan IS the trial. You get to create 5 full listings and push them to Jumia before deciding whether Pro is worth GHS 50."
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
            5 free listings. No card. Cancel any time.
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
        <Link href="/" className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 text-base shadow-sm">
            🐼
          </div>
          <span className="text-base font-bold tracking-tight">
            PandaWorld
          </span>
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
  highlight?: boolean;
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
  highlight,
}: PricingCardProps) {
  return (
    <div
      className={`relative rounded-2xl border bg-white p-8 transition-shadow ${
        highlight
          ? "border-orange-200 shadow-md shadow-orange-100"
          : "border-zinc-100 hover:shadow-md"
      }`}
    >
      {badge && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-orange-500 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-white shadow-md">
          {badge}
        </span>
      )}
      <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${iconBg}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="mt-5 flex items-baseline justify-between">
        <h3 className="text-lg font-bold">{tier}</h3>
        <p className="text-xs text-zinc-500">{tagline}</p>
      </div>
      <div className="mt-2 flex items-baseline gap-1">
        <span className="text-3xl font-bold">{price}</span>
        <span className="text-sm text-zinc-500">{period}</span>
      </div>
      <ul className="mt-6 space-y-3">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-2">
            <Check className={`mt-0.5 h-4 w-4 shrink-0 ${highlight ? "text-orange-500" : "text-emerald-500"}`} />
            <span className="text-sm text-zinc-700">{f}</span>
          </li>
        ))}
      </ul>
      <Link
        href={ctaHref}
        className={`mt-8 inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors ${
          highlight
            ? "bg-orange-500 text-white shadow-sm hover:bg-orange-600"
            : "border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50"
        }`}
      >
        {ctaLabel}
        <ArrowRight className="h-4 w-4" />
      </Link>
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
