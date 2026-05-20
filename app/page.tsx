import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import { ArrowRight } from "lucide-react";
import { MarketingFooter } from "@/components/marketing/footer";
import { Wordmark } from "@/components/marketing/wordmark";
import { ConnectTutorial } from "@/components/marketing/connect-tutorial";

// ─── Root route ──────────────────────────────────────────────────────────────
//
// Logged-out visitors see the marketing landing — hero with the
// rotating panda globe, value-prop, step-by-step Connect-to-Jumia
// tutorial. Authenticated users continue to be routed to dashboard /
// onboarding (unchanged from the prior redirect-only behaviour).
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

      {/* Hero — animated panda globe on the right, copy on the left */}
      <section className="relative overflow-hidden border-b border-zinc-100">
        <div className="absolute inset-0 -z-10 bg-gradient-to-b from-orange-50/60 via-white to-white" />
        <div className="mx-auto grid max-w-6xl grid-cols-1 gap-12 px-6 pb-20 pt-16 sm:pt-24 lg:grid-cols-[1.1fr_1fr] lg:gap-16 lg:pt-32">
          <div className="flex flex-col items-start text-left">
            <div className="inline-flex items-center gap-2 rounded-full border border-orange-200 bg-orange-50 px-3 py-1 text-xs font-medium text-orange-700">
              Built for Jumia sellers
            </div>
            <h1 className="mt-6 text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
              List your products to Vendor Center with{" "}
              <span className="bg-gradient-to-r from-orange-500 to-purple-600 bg-clip-text text-transparent">
                one click.
              </span>
            </h1>
            <p className="mt-6 text-base leading-relaxed text-zinc-600 sm:text-lg">
              Skip manual uploads. PandaworldAI generates the listing, picks
              the right Jumia category, fills every required attribute, and
              pushes straight to your store — no copy-pasting, no form-
              filling, no QC nightmares.
            </p>
            <div className="mt-8 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
              <Link
                href="/sign-up"
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-orange-500 px-6 py-3 text-sm font-semibold text-white shadow-md shadow-orange-500/20 transition-all hover:bg-orange-600 hover:shadow-lg"
              >
                Start free
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="#how-to-connect"
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-zinc-200 bg-white px-6 py-3 text-sm font-semibold text-zinc-700 transition-colors hover:bg-zinc-50"
              >
                See how it works
              </Link>
            </div>
            <p className="mt-4 text-xs text-zinc-400">
              2 free listings on signup. Credits from $4.99 thereafter — pay
              only for what you use.
            </p>
          </div>

          {/* Globe — iframe to the static loader HTML so we get the
              rotating panda-on-Earth animation for free. The same
              asset that powers the publishing loader after submit. */}
          <div className="relative hidden items-center justify-center lg:flex">
            <div className="absolute inset-0 -z-10 rounded-3xl bg-gradient-to-br from-purple-100/40 via-orange-100/40 to-transparent blur-2xl" />
            <iframe
              src="/loader/jumia-publishing.html"
              title="PandaWorld animated globe"
              aria-hidden="true"
              className="h-[420px] w-[420px] rounded-3xl border-0"
              sandbox="allow-scripts allow-same-origin"
            />
          </div>
        </div>
      </section>

      {/* Step-by-step "How to connect PandaWorld to Jumia" */}
      <ConnectTutorial />

      {/* Final CTA */}
      <section className="bg-white">
        <div className="mx-auto max-w-3xl px-6 py-20 text-center">
          <h2 className="text-2xl font-bold sm:text-3xl">
            Spend less time uploading products to Jumia.
          </h2>
          <p className="mt-3 text-sm text-zinc-600">
            Try PandaWorld free for your first 2 listings. No credit card.
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

// ─── Marketing nav ───────────────────────────────────────────────────────────

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
