import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { Link2, Laptop, PlayCircle } from "lucide-react";
import { WhatsAppIcon } from "@/components/whatsapp/whatsapp-icon";
import { HomeFloatingNav } from "@/components/marketing/home-floating-nav";
import { MarketingFooter } from "@/components/marketing/footer";
import { isBillingEnabled } from "@/lib/billing/mode";
import { WhatsAppFlowVideo } from "@/components/marketing/whatsapp-flow-video";

// ─── /how-to — public, indexable step-by-step guides ─────────────────────────
//
// Lives outside any auth gate (unlike the old app/extension/(app)/how-to,
// now deleted) specifically so Google can index it — sellers searching
// "how to connect Jumia Vendor Center" or "list on Jumia from WhatsApp"
// should be able to land here directly. Reachable from the homepage's own
// nav (components/marketing/home-floating-nav.tsx) and from the extension
// sidebar's "Guides" link (components/extension/sidebar.tsx), which used to
// point at a signed-in-only duplicate of this same content.
//
// Four guides, not five — "Connect Vendor Center" and "Link WhatsApp" are
// each their own guide since they're one-time setup steps shared by both
// products, and "list on a laptop" (Chrome extension) and "list from
// WhatsApp" are the two actual day-to-day flows. An earlier draft had a
// separate "on the phone" guide, but the Chrome extension doesn't run on a
// phone — sending photos on WhatsApp already IS the phone-based way to
// list, so it isn't a distinct fifth flow.

export const metadata: import("next").Metadata = {
  title: "How To — Connect, List, and Push to Jumia",
  description:
    "Step-by-step guides for PandaWorld: connect your Jumia Vendor Center account, link WhatsApp, and list products on Jumia from your laptop with the Chrome extension or from your phone over WhatsApp.",
  keywords: [
    "how to connect Jumia Vendor Center",
    "Jumia WhatsApp bot setup",
    "Jumia Chrome extension guide",
    "list on Jumia from WhatsApp",
    "Jumia Vendor Center API application",
    "PandaWorld setup guide",
  ],
  openGraph: {
    title: "How To — PandaWorld guides for Jumia sellers",
    description:
      "Connect your Vendor Center, link WhatsApp, and list on Jumia from a laptop or from WhatsApp — step by step.",
    type: "website",
  },
  alternates: { canonical: "/how-to" },
};

/** Any icon that takes a className — lucide's, or one of our own brand
 *  marks (WhatsAppIcon isn't a lucide ForwardRef). */
type IconComponent = (props: { className?: string }) => React.ReactNode;

interface Guide {
  Icon: IconComponent;
  title: string;
  intro: string;
  steps: string[];
  /** YouTube video ID once recorded. null renders the "coming soon" placeholder. */
  videoId: string | null;
  /** A recording we host ourselves, shown instead of the YouTube slot. */
  recording?: "whatsapp-flow";
}

const GUIDES: Guide[] = [
  {
    Icon: Link2,
    title: "Connect your Vendor Center to PandaWorld",
    intro:
      "Needed before you can push listings from WhatsApp (the Chrome extension doesn't need this — it fills in Jumia's own form directly in your browser).",
    steps: [
      "Go to vendorcenter.jumia.com and sign in to your seller account.",
      "In Vendor Center, go to Settings → Applications → Create Application, and choose \"Web Application (OAuth)\".",
      "Set the Redirect URI to https://pandaworldai.site/api/jumia/callback.",
      "Copy the Client ID and Client Secret from the application you just created.",
      "In your PandaWorld dashboard, open the Connect Jumia page, pick your country, paste in the Client ID and Client Secret, click \"Test Connection\", then \"Connect Jumia\".",
    ],
    videoId: null,
  },
  {
    Icon: WhatsAppIcon,
    title: "Link your WhatsApp number to PandaWorld",
    intro: "Takes under a minute — no app to install, just one WhatsApp message.",
    steps: [
      "In your PandaWorld dashboard, open Settings → Integrations (or the \"List from WhatsApp\" screen) and click \"Connect WhatsApp\".",
      "PandaWorld gives you a one-time code, like LINK-A1B2C3D4, and a ready-to-tap WhatsApp link.",
      "Tap \"Open WhatsApp to link\" — or send the code yourself to +233548534323. The message is pre-filled for you either way.",
      "PandaWorld confirms the link right away. The code expires after 15 minutes, so generate a new one if it lapses before you send it.",
    ],
    videoId: null,
  },
  {
    Icon: Laptop,
    title: "Auto-list to Jumia on a laptop",
    intro: "The Chrome extension autofills Jumia's own \"Add Products\" form while you're on it.",
    steps: [
      "Install the PandaWorld extension from the Chrome Web Store and pin it to your toolbar.",
      "Generate an API key in your PandaWorld dashboard, then paste it into the extension when it asks you to sign in.",
      "Go to Jumia Vendor Center and start adding a product like normal — upload a photo and pick a category. The extension opens as a side panel next to the form.",
      "Click \"Autofill this listing\". AI fills in the title, description, highlights, attributes, brand, and more.",
      "Review what's been filled in, tweak anything that needs it, and submit on Jumia's own form.",
    ],
    videoId: null,
  },
  {
    Icon: WhatsAppIcon,
    title: "Use the WhatsApp Chatbot",
    intro: "List products by sending photos in a chat — no laptop needed. Requires both guides above done first.",
    steps: [
      "Message +233548534323 and tell the bot how many products you're listing — reply with a number, like 3.",
      "For each product, send its photos together with a note about anything that matters: price, colour, what's in the box.",
      "The AI drafts every listing and messages you back once they're ready — usually within a couple of minutes.",
      "Review each draft, then reply submit for one product, or submit all to push everything to Jumia at once.",
    ],
    videoId: null,
    recording: "whatsapp-flow",
  },
];

function GuideVideo({ videoId, title }: { videoId: string | null; title: string }) {
  if (videoId) {
    return (
      <div className="aspect-video overflow-hidden rounded-xl border border-zinc-200">
        <iframe
          src={`https://www.youtube.com/embed/${videoId}`}
          title={title}
          className="h-full w-full"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
        />
      </div>
    );
  }
  return (
    <div className="flex aspect-video flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-200 bg-zinc-50 text-zinc-400">
      <PlayCircle className="h-9 w-9" />
      <span className="text-sm font-medium uppercase tracking-wide">Video coming soon</span>
    </div>
  );
}

const DASHBOARD_REDIRECT = "/extension/dashboard";

export default async function HowToPage() {
  const { userId } = await auth();
  const signInHref = `/sign-in?redirect_url=${DASHBOARD_REDIRECT}`;
  const signUpHref = `/sign-up?redirect_url=${DASHBOARD_REDIRECT}`;
  const calculatorHref = userId ? "/extension/calculator" : "/sign-in?redirect_url=/extension/calculator";
  const billingOn = await isBillingEnabled();

  return (
    <div className="min-h-screen bg-white text-zinc-900">
      <HomeFloatingNav signInHref={signInHref} signUpHref={signUpHref} calculatorHref={calculatorHref} pricingLive={billingOn} />

      <div className="mx-auto max-w-3xl px-6 pb-16 pt-16 sm:pt-20">
        <div className="text-center">
          <p className="text-sm font-semibold uppercase tracking-widest text-orange-500">Guides</p>
          <h1 className="mt-3 text-4xl font-bold tracking-tight sm:text-5xl">How To</h1>
          <p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-zinc-500 sm:text-lg">
            Step-by-step guides for getting set up and listing on Jumia — from your laptop with the Chrome
            extension, or from your phone over WhatsApp.
          </p>
        </div>

        <div className="mt-12 space-y-6">
          {GUIDES.map((guide, i) => (
            <div key={guide.title} className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-orange-500 text-white">
                  <guide.Icon className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-zinc-400">{`0${i + 1}`}</p>
                  <h2 className="text-lg font-bold text-zinc-900 sm:text-xl">{guide.title}</h2>
                </div>
              </div>
              <p className="mt-3 text-base text-zinc-600">{guide.intro}</p>

              <ol className="mt-4 space-y-2.5 border-l border-zinc-200 pl-5">
                {guide.steps.map((step, j) => (
                  <li key={j} className="flex gap-3 text-base text-zinc-600">
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-orange-50 text-sm font-bold text-orange-600">
                      {j + 1}
                    </span>
                    <span className="min-w-0 leading-relaxed [overflow-wrap:anywhere]">{step}</span>
                  </li>
                ))}
              </ol>

              <div className="mt-5">
                {guide.recording === "whatsapp-flow" ? (
                  // Portrait phone recording: phone width, not the 16:9 slot.
                  <div className="mx-auto max-w-[280px]">
                    <WhatsAppFlowVideo />
                  </div>
                ) : (
                  <GuideVideo videoId={guide.videoId} title={guide.title} />
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-12 text-center">
          <Link
            href={signUpHref}
            className="inline-flex items-center justify-center gap-2 rounded-full bg-orange-500 px-7 py-4 text-base font-medium text-white transition-colors hover:bg-orange-600"
          >
            Get started free
          </Link>
        </div>
      </div>

      <MarketingFooter extensionPricing={billingOn ? undefined : { signedIn: Boolean(userId), signInHref }} />
    </div>
  );
}
