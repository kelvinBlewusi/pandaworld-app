import Link from "next/link";
import {
  ArrowRight,
  Chrome,
  KeyRound,
  MousePointerClick,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  UploadCloud,
  Wand2,
  CheckCircle2,
  Lock,
} from "lucide-react";
import { MarketingFooter } from "@/components/marketing/footer";
import { Wordmark } from "@/components/marketing/wordmark";

// ─── /extension — public page for the Chrome extension flow ──────────────────
//
// Lives outside the (main) layout so logged-out visitors can read about the
// browser extension without bouncing through Clerk. Mirrors the structure of
// app/pricing/page.tsx (local MarketingNav + shared MarketingFooter) so the
// marketing surface stays consistent.
//
// The extension autofills the Jumia Vendor Center "Add Products" form from a
// product photo using PandaWorld's AI. Auth is a PandaWorld-issued API key the
// seller generates in the dashboard (see docs/chrome-extension-plan.md §9).

export const metadata: import("next").Metadata = {
  title:       "Chrome Extension — Autofill Jumia Listings",
  description:
    "The PandaWorld Chrome extension fills the Jumia Vendor Center product form for you. Upload a photo, pick a category, and AI writes the title, description, highlights, and attributes — SEO-optimised and QC-compliant. You review and submit. Works on any category.",
  keywords: [
    "Jumia autofill",
    "Jumia Vendor Center extension",
    "Jumia listing chrome extension",
    "AI product listing Jumia",
    "Jumia seller tool Ghana",
  ],
  openGraph: {
    title:       "PandaWorld Chrome Extension for Jumia Vendor Center",
    description:
      "Autofill the Jumia listing form from a product photo — SEO-optimised, QC-compliant. You review and submit.",
    type: "website",
  },
  alternates: { canonical: "/extension" },
};

const STEPS = [
  {
    Icon: Chrome,
    title: "Install the extension",
    body: "Add PandaWorld to Chrome. It opens as a side panel next to Jumia Vendor Center — nothing else to learn.",
  },
  {
    Icon: KeyRound,
    title: "Sign in with your API key",
    body: "Generate a key in your PandaWorld dashboard and paste it into the panel once. It stays on your device.",
  },
  {
    Icon: UploadCloud,
    title: "Add a photo & pick a category",
    body: "Do your listing on Jumia as usual — upload the product image and choose a category to open the form.",
  },
  {
    Icon: Wand2,
    title: "Click Autofill, review, submit",
    body: "AI fills the title, description, highlights, and attributes. You check it, tweak anything, and submit — always you.",
  },
];

const FEATURES = [
  {
    Icon: ScanSearch,
    title: "Reads whatever the form shows",
    body: "The form changes per category — Watches, Phones, Fashion all differ. The extension detects every field Jumia renders and fills what it can. No category is hardcoded.",
  },
  {
    Icon: ShieldCheck,
    title: "Built to pass Jumia QC",
    body: "Same compliance engine as the PandaWorld app: banned-word filtering, brand-in-title rules, and the exact \"what's in the box\" format Jumia expects — so listings clear QC the first time.",
  },
  {
    Icon: Sparkles,
    title: "SEO-optimised copy",
    body: "Titles and descriptions written to be found by buyers searching on Jumia — not generic filler, tuned for the Ghana market.",
  },
  {
    Icon: MousePointerClick,
    title: "You stay in control",
    body: "We fill; you review and press Submit. The extension never submits a listing on your behalf.",
  },
];

const AI_FILLS = [
  "Product name / title",
  "Brand (with safe fallback)",
  "Colour & colour family",
  "Weight",
  "Product description",
  "Highlights (bulleted)",
  "What's in the box",
  "From the Manufacturer",
  "Warranty text & address",
  "Category-specific attributes",
];

const YOU_SET = [
  "Price & sale price",
  "Stock quantity",
  "Category selection",
  "Seller SKU / barcode",
  "The final Submit",
];

export default function ExtensionPage() {
  return (
    <div className="min-h-screen bg-white text-zinc-900">
      <MarketingNav />

      {/* Hero */}
      <section className="border-b border-zinc-100">
        <div className="mx-auto max-w-6xl px-6 py-20 text-center">
          <p className="inline-flex items-center gap-2 rounded-full bg-orange-50 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-orange-600">
            <Chrome className="h-3.5 w-3.5" /> Chrome Extension · Beta
          </p>
          <h1 className="mx-auto mt-4 max-w-3xl text-3xl font-bold tracking-tight sm:text-5xl">
            Fill Jumia listings without leaving Jumia.
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-zinc-600 sm:text-base">
            Do your listing on Vendor Center like always. Upload a photo, pick a
            category, and PandaWorld's AI fills the whole form — SEO-optimised
            and built to pass QC. You review and submit.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href="/sign-up"
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-orange-500 px-6 py-3 text-sm font-semibold text-white shadow-md shadow-orange-500/20 transition-all hover:bg-orange-600"
            >
              Get your API key
              <ArrowRight className="h-4 w-4" />
            </Link>
            <a
              href="#how-it-works"
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-zinc-200 px-6 py-3 text-sm font-semibold text-zinc-700 transition-colors hover:bg-zinc-50"
            >
              See how it works
            </a>
          </div>
          <p className="mt-4 text-xs text-zinc-500">
            Works alongside your PandaWorld plan — one subscription, two ways to list.
          </p>
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="bg-zinc-50">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <div className="text-center">
            <p className="text-xs font-semibold uppercase tracking-widest text-orange-500">
              How it works
            </p>
            <h2 className="mt-3 text-2xl font-bold sm:text-3xl">
              Four steps, then you&apos;re listing faster.
            </h2>
          </div>
          <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((step, i) => (
              <div
                key={step.title}
                className="relative rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm"
              >
                <span className="absolute right-4 top-4 text-sm font-bold text-zinc-200">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-orange-50 text-orange-600">
                  <step.Icon className="h-5 w-5" />
                </div>
                <h3 className="mt-4 text-base font-semibold">{step.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-zinc-600">{step.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Works on any category */}
      <section className="border-t border-zinc-100 bg-white">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <div className="text-center">
            <p className="text-xs font-semibold uppercase tracking-widest text-orange-500">
              Why it&apos;s different
            </p>
            <h2 className="mt-3 text-2xl font-bold sm:text-3xl">
              It adapts to whatever Jumia shows you.
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-sm leading-relaxed text-zinc-600 sm:text-base">
              Jumia&apos;s form is different for every category. Instead of
              guessing, the extension reads the exact fields that appear and
              fills each one it can — so it works on Watches, Phones, Fashion,
              and everything in between.
            </p>
          </div>
          <div className="mt-12 grid grid-cols-1 gap-6 md:grid-cols-2">
            {FEATURES.map((f) => (
              <div
                key={f.title}
                className="flex gap-4 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm"
              >
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-orange-50 text-orange-600">
                  <f.Icon className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-semibold">{f.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-zinc-600">{f.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* AI fills vs you set */}
      <section className="bg-zinc-50">
        <div className="mx-auto max-w-5xl px-6 py-20">
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <div className="rounded-2xl border border-orange-100 bg-white p-8 shadow-sm">
              <div className="flex items-center gap-2 text-orange-600">
                <Wand2 className="h-5 w-5" />
                <h3 className="text-lg font-bold text-zinc-900">AI fills for you</h3>
              </div>
              <ul className="mt-6 space-y-3">
                {AI_FILLS.map((item) => (
                  <li key={item} className="flex items-start gap-3 text-sm text-zinc-700">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-orange-500" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm">
              <div className="flex items-center gap-2 text-zinc-700">
                <Lock className="h-5 w-5" />
                <h3 className="text-lg font-bold text-zinc-900">You stay in charge of</h3>
              </div>
              <ul className="mt-6 space-y-3">
                {YOU_SET.map((item) => (
                  <li key={item} className="flex items-start gap-3 text-sm text-zinc-700">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" />
                    {item}
                  </li>
                ))}
              </ul>
              <p className="mt-6 rounded-lg bg-zinc-50 p-3 text-xs leading-relaxed text-zinc-500">
                The seller always reviews the filled form and presses Submit. The
                extension assists — it never lists on your behalf.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Security */}
      <section className="border-t border-zinc-100 bg-white">
        <div className="mx-auto max-w-3xl px-6 py-20 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-orange-50 text-orange-600">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <h2 className="mt-5 text-2xl font-bold sm:text-3xl">Safe by design</h2>
          <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-zinc-600 sm:text-base">
            Your API key only lets the extension ask PandaWorld to write a
            listing — it can&apos;t touch your billing or account. It&apos;s
            stored on your device, and you can revoke or regenerate it any time
            from your dashboard. Your Jumia login stays entirely between you and
            Jumia.
          </p>
        </div>
      </section>

      {/* FAQ */}
      <section className="bg-zinc-50">
        <div className="mx-auto max-w-3xl px-6 py-20">
          <h2 className="text-2xl font-bold sm:text-3xl">Frequently asked</h2>
          <dl className="mt-8 space-y-6">
            <FAQ
              q="Does it submit the listing for me?"
              a="No. It fills the form; you review everything and press Submit yourself. You're always the one who publishes to Jumia."
            />
            <FAQ
              q="Which product categories does it work on?"
              a="Any of them. The extension reads whatever fields Jumia shows for the category you pick and fills what it can — it isn't limited to a fixed list."
            />
            <FAQ
              q="Do I need a separate subscription?"
              a="No. The extension uses the same plan and monthly quota as the PandaWorld web app — one autofill counts as one listing credit."
            />
            <FAQ
              q="Where do I get my API key?"
              a="Sign in to your PandaWorld dashboard and generate one under Settings → API Keys. Paste it into the extension panel once."
            />
            <FAQ
              q="Is my key safe in the browser?"
              a="The key is scoped to autofill only — it can't reach your billing or account — and it's stored on your device. Revoke or regenerate it any time from the dashboard."
            />
          </dl>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-zinc-100 bg-white">
        <div className="mx-auto max-w-3xl px-6 py-20 text-center">
          <h2 className="text-2xl font-bold sm:text-3xl">Ready to list faster?</h2>
          <p className="mt-3 text-sm text-zinc-600">
            Create a free account, grab your API key, and start autofilling on Jumia.
          </p>
          <Link
            href="/sign-up"
            className="mt-8 inline-flex items-center justify-center gap-2 rounded-lg bg-orange-500 px-6 py-3 text-sm font-semibold text-white shadow-md shadow-orange-500/20 transition-all hover:bg-orange-600"
          >
            Get started free
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
            href="/extension"
            className="rounded-md px-3 py-1.5 text-sm font-medium text-orange-600"
          >
            Extension
          </Link>
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

function FAQ({ q, a }: { q: string; a: string }) {
  return (
    <div>
      <dt className="text-base font-semibold text-zinc-900">{q}</dt>
      <dd className="mt-2 text-sm leading-relaxed text-zinc-600">{a}</dd>
    </div>
  );
}
