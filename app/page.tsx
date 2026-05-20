import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import {
  Sparkles,
  Zap,
  ShieldCheck,
  ListChecks,
  ImageIcon,
  ArrowRight,
  Check,
} from "lucide-react";
import { MarketingFooter } from "@/components/marketing/footer";

// ─── Root route ──────────────────────────────────────────────────────────────
//
// Authenticated sellers continue to be routed to dashboard / onboarding.
// Logged-out visitors see the public landing — explains what PandaWorld
// is, who it's for, and pricing.
//
// Kept as a Server Component so the auth check + redirect run on the
// edge and visitors hit the landing with no client-side JS until they
// interact.

export default async function Home() {
  const { userId } = await auth();

  if (userId) {
    const db = createServerClient();
    const { data } = await db
      .from("jumia_connections")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle();

    if (!data) redirect("/onboarding/channel");
    redirect("/dashboard");
  }

  return <PublicLanding />;
}

// ─── Landing page ────────────────────────────────────────────────────────────

function PublicLanding() {
  return (
    <div className="min-h-screen bg-white text-zinc-900">
      <MarketingNav />

      {/* Hero */}
      <section className="relative overflow-hidden border-b border-zinc-100">
        <div className="absolute inset-0 -z-10 bg-gradient-to-b from-orange-50/60 via-white to-white" />
        <div className="mx-auto max-w-6xl px-6 pb-20 pt-16 sm:pt-24 lg:pt-32">
          <div className="mx-auto max-w-3xl text-center">
            <div className="inline-flex items-center gap-2 rounded-full border border-orange-200 bg-orange-50 px-3 py-1 text-xs font-medium text-orange-700">
              <Sparkles className="h-3 w-3" />
              Built for Jumia Ghana sellers
            </div>
            <h1 className="mt-6 text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
              Turn one phone photo into a Jumia listing in{" "}
              <span className="bg-gradient-to-r from-orange-500 to-purple-600 bg-clip-text text-transparent">
                30 seconds.
              </span>
            </h1>
            <p className="mt-6 text-base leading-relaxed text-zinc-600 sm:text-lg">
              Upload a product photo. Our AI picks the right Jumia category,
              fills every required attribute, polishes the image, and pushes
              the listing to Vendor Center. You review, click submit,
              you&apos;re live.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link
                href="/sign-up"
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-orange-500 px-6 py-3 text-sm font-semibold text-white shadow-md shadow-orange-500/20 transition-all hover:bg-orange-600 hover:shadow-lg sm:w-auto"
              >
                Start free
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/pricing"
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-200 bg-white px-6 py-3 text-sm font-semibold text-zinc-700 transition-colors hover:bg-zinc-50 sm:w-auto"
              >
                See pricing
              </Link>
            </div>
            <p className="mt-4 text-xs text-zinc-400">
              No credit card. 5 free listings, then GHS 50 / month for
              unlimited.
            </p>
          </div>
        </div>
      </section>

      {/* Three-feature row */}
      <section className="border-b border-zinc-100 bg-white">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <div className="text-center">
            <h2 className="text-2xl font-bold sm:text-3xl">
              What the AI does for you
            </h2>
            <p className="mx-auto mt-3 max-w-2xl text-sm text-zinc-600">
              Three jobs that used to take 15 minutes a listing, now happen
              in one click.
            </p>
          </div>
          <div className="mt-12 grid grid-cols-1 gap-6 md:grid-cols-3">
            <FeatureCard
              icon={ListChecks}
              title="Picks the right category"
              body="27,000+ Jumia GH categories. The AI reads your images, identifies the product, and routes it to the most specific listable category Jumia accepts."
            />
            <FeatureCard
              icon={Zap}
              title="Fills every attribute"
              body="Brand, color family, material, weight, capacity — whatever the category asks for. Pre-filled from your images, ready for you to review and tweak."
            />
            <FeatureCard
              icon={ImageIcon}
              title="Polishes or rebuilds images"
              body="Cluttered backgrounds, off-axis shots, harsh lighting — one click cleans them up to Jumia's white-background spec or generates a fresh studio render."
            />
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="border-b border-zinc-100 bg-zinc-50">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <div className="text-center">
            <h2 className="text-2xl font-bold sm:text-3xl">How it works</h2>
            <p className="mx-auto mt-3 max-w-2xl text-sm text-zinc-600">
              From phone snap to live listing on Vendor Center.
            </p>
          </div>
          <ol className="mx-auto mt-12 grid max-w-4xl grid-cols-1 gap-6 md:grid-cols-3">
            <Step
              n={1}
              title="Connect Jumia"
              body="One-time setup — log in with your Vendor Center account and authorise PandaWorld."
            />
            <Step
              n={2}
              title="Upload a product photo"
              body="Drop in up to 8 images per product, or batch up to 10 products at once."
            />
            <Step
              n={3}
              title="Review and submit"
              body="AI fills the form. You eyeball it, click submit, your listing is live within minutes."
            />
          </ol>
        </div>
      </section>

      {/* Trust strip */}
      <section className="border-b border-zinc-100 bg-white">
        <div className="mx-auto max-w-6xl px-6 py-14">
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
            <TrustItem
              icon={ShieldCheck}
              title="Your tokens stay encrypted"
              body="Jumia OAuth credentials are AES-256-GCM encrypted at rest. A database breach hands attackers nothing usable."
            />
            <TrustItem
              icon={Check}
              title="Jumia content rules baked in"
              body="The AI knows every rejection trigger — restricted words, brand-in-title, image specs — and avoids them before they cost you a listing."
            />
            <TrustItem
              icon={Sparkles}
              title="Built in Ghana, for Ghana"
              body="GHS pricing, Paystack billing, Ghana-tuned category catalogue. No friction translating someone else's marketplace."
            />
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="bg-white">
        <div className="mx-auto max-w-3xl px-6 py-20 text-center">
          <h2 className="text-2xl font-bold sm:text-3xl">
            Spend less time on forms.
          </h2>
          <p className="mt-3 text-sm text-zinc-600">
            Try PandaWorld free for your first 5 listings. No credit card.
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

// ─── Marketing shell components ──────────────────────────────────────────────

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
            className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900"
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

// ─── Small presentational pieces ─────────────────────────────────────────────

function FeatureCard({
  icon: Icon,
  title,
  body,
}: {
  icon: React.ElementType;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-2xl border border-zinc-100 bg-white p-6 transition-shadow hover:shadow-md">
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-orange-50 text-orange-600">
        <Icon className="h-5 w-5" />
      </div>
      <h3 className="mt-4 text-base font-semibold">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-zinc-600">{body}</p>
    </div>
  );
}

function Step({
  n,
  title,
  body,
}: {
  n: number;
  title: string;
  body: string;
}) {
  return (
    <li className="relative rounded-2xl border border-zinc-100 bg-white p-6">
      <div className="absolute -top-3 -left-3 flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-orange-500 to-purple-600 text-sm font-bold text-white shadow-md">
        {n}
      </div>
      <h3 className="mt-2 text-base font-semibold">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-zinc-600">{body}</p>
    </li>
  );
}

function TrustItem({
  icon: Icon,
  title,
  body,
}: {
  icon: React.ElementType;
  title: string;
  body: string;
}) {
  return (
    <div className="flex flex-col items-start gap-3">
      <div className="flex h-9 w-9 items-center justify-center rounded-md bg-zinc-100 text-zinc-700">
        <Icon className="h-4 w-4" />
      </div>
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="text-xs leading-relaxed text-zinc-600">{body}</p>
    </div>
  );
}
