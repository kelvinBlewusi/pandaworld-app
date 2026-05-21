import Link from "next/link";
import { ArrowRight, LayoutDashboard } from "lucide-react";
import { MarketingFooter } from "@/components/marketing/footer";
import { Wordmark } from "@/components/marketing/wordmark";
import { ConnectTutorial } from "@/components/marketing/connect-tutorial";

// ─── Public landing — reusable across / (logged-out) and /landing ────────────
//
// Extracted from app/page.tsx so it can also render at /landing where
// logged-in sellers can review the marketing copy without losing their
// session. The only difference between the two render sites is the
// nav: visitors see Sign in / Get started CTAs; logged-in sellers see
// a "Back to dashboard" button.
//
// Kept as a Server Component (no "use client") — every section here is
// static prose + a Link + an iframe. No state, no hooks.

interface PublicLandingProps {
  /** True when the viewer is signed in. Switches the nav CTAs. */
  isAuthenticated?: boolean;
}

export function PublicLanding({ isAuthenticated = false }: PublicLandingProps) {
  return (
    <div className="min-h-screen bg-white text-zinc-900">
      <MarketingNav isAuthenticated={isAuthenticated} />

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
            <div className="mt-8 flex w-full flex-col items-stretch gap-3 sm:w-auto sm:flex-row sm:items-center">
              <Link
                href={isAuthenticated ? "/dashboard" : "/sign-up"}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-orange-500 px-6 py-3 text-sm font-semibold text-white shadow-md shadow-orange-500/20 transition-all hover:bg-orange-600 hover:shadow-lg sm:w-auto"
              >
                {isAuthenticated ? "Open dashboard" : "Start free"}
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="#how-to-connect"
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-200 bg-white px-6 py-3 text-sm font-semibold text-zinc-700 transition-colors hover:bg-zinc-50 sm:w-auto"
              >
                See how it works
              </Link>
            </div>
            <p className="mt-4 text-xs text-zinc-400">
              5 free listings every month. Paid plans from GHS 30/month — pick
              the tier that matches your volume, cancel any time.
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

      {/* What you get — feature highlights mapped to the new 4-tier model */}
      <section className="bg-zinc-50/60">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-2xl font-bold sm:text-3xl">
              Plans that grow with your store.
            </h2>
            <p className="mt-3 text-sm text-zinc-600">
              Start free, upgrade when you hit volume. Monthly quotas reset
              automatically — never get locked out of your listings.
            </p>
          </div>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <TierTile
              name="Free"
              price="GHS 0"
              line="5 listings every month"
              detail="Get a feel for it. No credit card."
            />
            <TierTile
              name="Starter"
              price="GHS 30"
              line="30 listings + 10 image polishes"
              detail="Casual sellers, 10–20 listings/mo."
              accent
            />
            <TierTile
              name="Pro"
              price="GHS 65"
              line="100 listings + 30 image polishes"
              detail="Serious sellers — bulk push, priority support."
              badge="Most popular"
            />
            <TierTile
              name="Business"
              price="GHS 120"
              line="500 listings + 150 image polishes"
              detail="Resellers + high-volume stores. Advanced analytics."
            />
          </div>
          <p className="mt-6 text-center text-xs text-zinc-500">
            See the full breakdown on the{" "}
            <Link href="/pricing" className="underline hover:text-zinc-700">
              pricing page
            </Link>.
          </p>
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
            5 free listings every month. No credit card. Cancel any time.
          </p>
          <Link
            href={isAuthenticated ? "/dashboard" : "/sign-up"}
            className="mt-8 inline-flex items-center justify-center gap-2 rounded-lg bg-orange-500 px-6 py-3 text-sm font-semibold text-white shadow-md shadow-orange-500/20 transition-all hover:bg-orange-600"
          >
            {isAuthenticated ? "Back to dashboard" : "Get started"}
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}

// ─── Tier tile — used in the landing's plan-preview row ──────────────────────

function TierTile({
  name,
  price,
  line,
  detail,
  accent,
  badge,
}: {
  name: string;
  price: string;
  line: string;
  detail: string;
  accent?: boolean;
  badge?: string;
}) {
  return (
    <div
      className={`relative flex flex-col rounded-2xl border bg-white p-5 shadow-sm ${
        accent ? "border-orange-200" : "border-zinc-100"
      }`}
    >
      {badge && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-orange-500 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-white shadow">
          {badge}
        </span>
      )}
      <p className="text-sm font-semibold text-zinc-900">{name}</p>
      <p className="mt-2 text-2xl font-bold tracking-tight text-zinc-900">{price}<span className="text-sm font-normal text-zinc-500"> / mo</span></p>
      <p className="mt-3 text-xs font-medium text-zinc-700">{line}</p>
      <p className="mt-1 text-[11px] text-zinc-500">{detail}</p>
    </div>
  );
}

// ─── Marketing nav — adapts to logged-in state ───────────────────────────────

function MarketingNav({ isAuthenticated }: { isAuthenticated: boolean }) {
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
          {isAuthenticated ? (
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-1.5 rounded-md bg-orange-500 px-3 py-1.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-orange-600"
            >
              <LayoutDashboard className="h-3.5 w-3.5" />
              Dashboard
            </Link>
          ) : (
            <>
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
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
