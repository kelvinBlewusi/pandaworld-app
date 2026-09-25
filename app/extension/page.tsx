import Image from "next/image";
import { WhatsAppIcon } from "@/components/whatsapp/whatsapp-icon";
import {Chrome, KeyRound, UploadCloud, Wand2, ListOrdered, Camera, CheckCircle2, Megaphone} from "lucide-react";
import { auth } from "@clerk/nextjs/server";
import { MarketingFooter } from "@/components/marketing/footer";
import { ExtensionHeroBackdrop } from "@/components/marketing/extension-hero-backdrop";
import { CHROME_WEB_STORE_URL } from "@/lib/constants/support";

// ─── /extension — public page for the Chrome extension + WhatsApp flows ──────
//
// Lives outside the (main) layout so logged-out visitors can read about
// either way to list without bouncing through Clerk. Mirrors the structure of
// app/pricing/page.tsx (local MarketingNav + shared MarketingFooter) so the
// marketing surface stays consistent.
//
// Two products live under this one page: the Chrome extension autofills the
// Jumia Vendor Center "Add Products" form from a product photo (auth is a
// PandaWorld-issued API key generated in the dashboard, see
// docs/chrome-extension-plan.md §9), and the WhatsApp bot drafts + submits
// listings from photos sent in chat (see lib/whatsapp/intake.ts). Both need
// a PandaWorld account first, so the WhatsApp steps below point back at the
// same sign-up CTA rather than a public wa.me link — there's no way to talk
// to the bot before the seller has an account to link.

export const metadata: import("next").Metadata = {
  title:       "AI Jumia Listings for Chrome and WhatsApp",
  description:
    "PandaWorld writes your Jumia listings for you. Upload a photo in the Chrome extension or send it on WhatsApp, and AI fills in the title, description, highlights, and every attribute Jumia asks for. You check it over, then submit.",
  keywords: [
    "Jumia autofill",
    "Jumia Vendor Center extension",
    "Jumia listing chrome extension",
    "AI product listing Jumia",
    "Jumia seller tool Ghana",
    "Jumia seller tool Nigeria",
    "Jumia seller tool Africa",
    "list on Jumia from WhatsApp",
    "Jumia WhatsApp bot",
  ],
  openGraph: {
    title:       "PandaWorld: AI Jumia Listings for Chrome and WhatsApp",
    description:
      "Upload a photo in the Chrome extension or send it on WhatsApp. AI writes the listing, you review and submit.",
    type: "website",
  },
  // Points at root, not "/extension" itself — app/page.tsx renders this exact
  // same component for logged-out visitors, so both URLs serve byte-identical
  // content. Without this, each page self-declared as its own canonical,
  // which splits ranking signal across two URLs for Google instead of
  // consolidating it on the one people actually share (the root domain).
  alternates: { canonical: "/" },
};

const STEPS = [
  {
    Icon: Chrome,
    title: "Install the extension",
    body: "Add PandaWorld to Chrome and pin it. It opens as a side panel next to Jumia Vendor Center.",
    href: CHROME_WEB_STORE_URL,
  },
  {
    Icon: KeyRound,
    title: "Sign in with your API key",
    body: "Generate a key in your PandaWorld dashboard and paste it into the panel.",
  },
  {
    Icon: UploadCloud,
    title: "Add a photo and pick a category",
    body: "Do your listing on Jumia like normal. Upload the product image and choose a category to open the form.",
  },
  {
    Icon: Wand2,
    title: "Click Autofill, review, submit",
    body: "AI fills the title, description, highlights, and attributes. Check it, tweak anything that needs it, and submit.",
  },
];

const WHATSAPP_STEPS = [
  {
    Icon: WhatsAppIcon,
    title: "Link your WhatsApp",
    body: "Grab a connect code from your PandaWorld dashboard and send it to our number. Takes a few seconds.",
  },
  {
    Icon: ListOrdered,
    title: "Say how many products",
    body: "Reply with a number, like 3, and we'll take you through them one by one.",
  },
  {
    Icon: Camera,
    title: "Send photos and a note",
    body: "Snap the product and send the photos. Mention anything that matters, like the price, the colour, or what's in the box.",
  },
  {
    Icon: CheckCircle2,
    title: "Review and submit",
    body: "We draft the listing and message it back to you. Check it over, reply submit, and it goes live on Jumia.",
  },
];

// Real screenshots from a real seller's chat (2026-09-24), not mockups —
// the same three-product batch from "Say how many products" through to
// "Submit all", in order.
const CONVERSATION_SHOTS = [
  { src: "/marketing/whatsapp-flow-1-start.jpg", alt: "WhatsApp chat: PandaWorld AI asks how many products, seller replies 3 products", caption: "Say how many you're listing" },
  { src: "/marketing/whatsapp-flow-4-ready.jpg", alt: "WhatsApp chat: PandaWorld AI reports all 3 products drafted and ready", caption: "AI drafts every product" },
  { src: "/marketing/whatsapp-flow-5-submit.jpg", alt: "WhatsApp chat: seller taps Submit all to push every listing to Jumia", caption: "Review, then submit" },
] as const;

// Real screenshots from a real seller's Jumia Vendor Center session
// (2026-09-25), not mockups — the same watch listing scrolled top to
// bottom after clicking Autofill, in order.
const EXTENSION_SHOTS = [
  { src: "/marketing/extension-flow-1-basics.png", alt: "Jumia Vendor Center listing form: PandaWorld extension has filled in the name, category, brand, color, and weight", caption: "AI fills the name, category, brand, color, and weight" },
  { src: "/marketing/extension-flow-2-highlights.png", alt: "Jumia Vendor Center listing form: PandaWorld extension has written the full product description and highlights", caption: "Description and highlights, fully written" },
  { src: "/marketing/extension-flow-3-manufacturer.png", alt: "Jumia Vendor Center listing form: PandaWorld extension has filled in manufacturer details, what's in the box, and warranty", caption: "Even manufacturer info and what's in the box" },
] as const;

/** Any icon that takes a className — lucide's, or one of our own brand
 *  marks. It was `typeof Chrome`, which pinned it to lucide's exact
 *  ForwardRef shape and rejected the WhatsApp glyph outright. */
type IconComponent = (props: { className?: string }) => React.ReactNode;

interface Step {
  Icon: IconComponent;
  title: string;
  body: string;
  href?: string;
}

/** One "How it works" column — a small icon + label heading over a
 *  vertical list of numbered steps. Used twice on this page (Chrome
 *  extension, WhatsApp) so both sit side by side instead of the single
 *  4-up card grid this section used to be, which only had room for one
 *  flow at a time. */
function HowItWorksTrack({ icon: TrackIcon, label, steps }: { icon: IconComponent; label: string; steps: Step[] }) {
  return (
    <div>
      <div className="flex items-center gap-2.5">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-orange-500 text-white">
          <TrackIcon className="h-4 w-4" />
        </div>
        <h3 className="text-lg font-bold text-zinc-900">{label}</h3>
      </div>
      <ol className="mt-6 space-y-6 border-l border-zinc-200 pl-6">
        {steps.map((step, i) => {
          const content = (
            <>
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-orange-50 text-xs font-bold text-orange-600">
                  {i + 1}
                </span>
                <h4 className="text-sm font-semibold text-zinc-900">{step.title}</h4>
                {step.href && (
                  <span className="text-xs font-medium text-orange-500">Open Chrome Web Store →</span>
                )}
              </div>
              <p className="mt-1.5 pl-8 text-sm leading-relaxed text-zinc-600">{step.body}</p>
            </>
          );
          return (
            <li key={step.title} className="-ml-[1px] pl-[1px]">
              {step.href ? (
                <a
                  href={step.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="-m-2 block rounded-lg p-2 transition-colors hover:bg-white"
                >
                  {content}
                </a>
              ) : (
                content
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// Every auth link on this page carries this so a NEW sign-up lands directly on
// the extension dashboard — never the old Jumia-OAuth onboarding gate
// (app/page.tsx / (main)/layout.tsx), which is a separate flow for the main
// web app and structurally unreachable from /extension/dashboard anyway
// (that route lives outside the (main) group). Without redirect_url, Clerk's
// default post-auth destination is "/", whose own gate sends any brand-new
// user straight into /onboarding/connect.
const DASHBOARD_REDIRECT = "/extension/dashboard";

// Named export (in addition to the default below) so app/page.tsx can
// render the exact same component for logged-out root visitors — the root
// landing page is meant to be identical to /extension, not a second copy
// of this markup that could drift out of sync.
export async function ExtensionPage() {
  const { userId } = await auth();
  // Signed-in visitors skip straight to the real key-generation screen;
  // logged-out visitors sign up first (the dashboard requires an account).
  const ctaHref  = userId ? DASHBOARD_REDIRECT : `/sign-up?redirect_url=${DASHBOARD_REDIRECT}`;
  const ctaLabel = userId ? "Open dashboard" : "Get Started";
  const signInHref = `/sign-in?redirect_url=${DASHBOARD_REDIRECT}`;
  const calculatorHref = userId ? "/extension/calculator" : "/sign-in?redirect_url=/extension/calculator";

  return (
    <div className="min-h-screen bg-white text-zinc-900">
      {/* "Use for free" announcement bar — a growth-phase callout (see
          lib/billing/free-for-all.ts) sitting above the hero so it's the
          very first thing a visitor sees. The diagonal highlight sweeping
          across it (Tailwind's `animate-shimmer`, added for this) is pure
          CSS — no client JS needed, so this stays a plain server-rendered
          element even though the hero right below it is a client
          component. Remove this whole block (and the `shimmer` keyframe/
          animation in tailwind.config.ts, if nothing else uses them by
          then) once free-for-all mode ends. */}
      <div
        className="relative flex items-center justify-center gap-2 overflow-hidden bg-orange-600 px-4 py-2.5 text-center text-sm font-semibold text-white animate-shimmer"
        style={{
          backgroundImage: "linear-gradient(115deg, transparent 30%, rgba(255,255,255,0.35) 50%, transparent 70%)",
          backgroundSize: "200% 100%",
        }}
      >
        <Megaphone className="h-4 w-4 shrink-0" />
        <span>Try PandaWorld for free — auto-push listings from WhatsApp chat to Jumia, or from the Chrome extension.</span>
      </div>

      {/* Hero — plain white (components/marketing/extension-hero-backdrop.tsx).
          Carries its own floating pill nav (HomeFloatingNav: logo, How it
          Works / Pricing / Jumia Pricing Calculator, Login, Get started),
          `sticky` so it stays reachable while scrolled past the hero —
          no separate MarketingNav on this page. */}
      <ExtensionHeroBackdrop
        signInHref={signInHref}
        signUpHref={`/sign-up?redirect_url=${DASHBOARD_REDIRECT}`}
        ctaHref={ctaHref}
        ctaLabel={ctaLabel}
        calculatorHref={calculatorHref}
      />

      {/* How it works — two tracks side by side (Chrome extension, WhatsApp),
          each its own vertical step list rather than the old single 4-up
          card grid, since that layout doesn't leave room for a second set
          of steps next to it. Stacks to one column on phones. */}
      <section id="how-it-works" className="bg-zinc-50">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <div className="text-center">
            <p className="text-xs font-semibold uppercase tracking-widest text-orange-500">
              How it works
            </p>
            <h2 className="mt-3 text-2xl font-bold sm:text-3xl">
              Two ways to get your products listed
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-sm text-zinc-500">
              Use the extension when you&apos;re at your laptop, or send photos on WhatsApp when
              you&apos;re not. Either way our AI writes the listing, and you have the final say
              before it goes live.
            </p>
          </div>

          <div className="mt-12 grid grid-cols-1 gap-12 lg:grid-cols-2 lg:gap-16">
            <HowItWorksTrack
              icon={Chrome}
              label="From your browser"
              steps={STEPS}
            />
            <HowItWorksTrack
              icon={WhatsAppIcon}
              label="From WhatsApp"
              steps={WHATSAPP_STEPS}
            />
          </div>
        </div>
      </section>

      {/* Real screenshots, not mockups — the Chrome extension autofilling an
          actual Jumia listing, and an actual seller's WhatsApp chat. Sits on
          white (the section above is zinc-50) so the two alternate and this
          doesn't blur into it. Two tracks, same icon+label pattern as the
          "How it works" section above. */}
      <section className="bg-white">
        <div className="mx-auto max-w-5xl px-6 py-16">
          <div className="text-center">
            <p className="text-xs font-semibold uppercase tracking-widest text-orange-500">
              See it happen
            </p>
            <h2 className="mt-3 text-2xl font-bold sm:text-3xl">
              Real listings, not mockups
            </h2>
          </div>

          <div className="mt-12">
            <div className="flex items-center justify-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-orange-500 text-white">
                <Chrome className="h-4 w-4" />
              </div>
              <h3 className="text-lg font-bold text-zinc-900">From the Chrome extension</h3>
            </div>
            {/* Stacked full-width, not a 3-up grid — these are dense
                desktop screenshots (small form labels and body text), and
                a WhatsApp-shot-sized thumbnail crushed them down to the
                point of illegibility. Cropped to just the form + extension
                panel (public/marketing/extension-flow-*.png), dropping the
                Vendor Center sidebar and browser chrome, so the remaining
                pixels all go to content that's actually worth reading. */}
            <div className="mx-auto mt-6 flex max-w-3xl flex-col gap-8">
              {EXTENSION_SHOTS.map((shot, i) => (
                <figure key={shot.src} className="flex flex-col items-center">
                  <div className="overflow-hidden rounded-2xl border border-zinc-200 shadow-sm">
                    <Image
                      src={shot.src}
                      alt={shot.alt}
                      width={1124}
                      height={811}
                      className="h-auto w-full"
                      sizes="(min-width: 768px) 768px, 100vw"
                    />
                  </div>
                  <figcaption className="mt-3 text-sm text-zinc-500">
                    <span className="font-semibold text-zinc-900">{i + 1}.</span> {shot.caption}
                  </figcaption>
                </figure>
              ))}
            </div>
          </div>

          <div className="mt-16">
            <div className="flex items-center justify-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-orange-500 text-white">
                <WhatsAppIcon className="h-4 w-4" />
              </div>
              <h3 className="text-lg font-bold text-zinc-900">From WhatsApp</h3>
            </div>
            <div className="mt-6 grid grid-cols-1 gap-8 sm:grid-cols-3">
              {CONVERSATION_SHOTS.map((shot, i) => (
                <figure key={shot.src} className="flex flex-col items-center">
                  <div className="overflow-hidden rounded-2xl border border-zinc-200 shadow-sm">
                    <Image
                      src={shot.src}
                      alt={shot.alt}
                      width={296}
                      height={640}
                      className="h-auto w-full max-w-[240px]"
                      sizes="(min-width: 640px) 240px, 80vw"
                    />
                  </div>
                  <figcaption className="mt-3 text-sm text-zinc-500">
                    <span className="font-semibold text-zinc-900">{i + 1}.</span> {shot.caption}
                  </figcaption>
                </figure>
              ))}
            </div>
          </div>
        </div>
      </section>

      <MarketingFooter extensionPricing={{ signedIn: Boolean(userId), signInHref }} />
    </div>
  );
}

export default ExtensionPage;
