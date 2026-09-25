import { Link2, Laptop, Smartphone, Bot, PlayCircle } from "lucide-react";
import { WhatsAppIcon } from "@/components/whatsapp/whatsapp-icon";

// ─── /extension/how-to — video walkthroughs for the five core flows ─────────
//
// Fills in the sidebar's "How to" nav item (components/extension/sidebar.tsx
// used to list this under comingSoonNav, inert — now a real link). Lives
// inside the shared (app) shell like calculator/listings/settings, so it's
// reachable by any signed-in seller regardless of which product (Chrome
// extension or WhatsApp) they use.
//
// Videos aren't recorded yet — each guide ships with a VideoPlaceholder.
// Once a real video exists for a topic, swap that guide's `videoId` in
// (from "coming soon") to a YouTube video ID and render an <iframe> embed
// instead; no other change needed.

export const metadata: import("next").Metadata = {
  title: "How To",
  robots: { index: false }, // logged-in tool, not a marketing surface
};

/** Any icon that takes a className — lucide's, or one of our own brand
 *  marks (WhatsAppIcon isn't a lucide ForwardRef, same reason this type
 *  exists in app/extension/page.tsx). */
type IconComponent = (props: { className?: string }) => React.ReactNode;

interface Guide {
  Icon: IconComponent;
  title: string;
  body: string;
  /** YouTube video ID once recorded. null renders the "coming soon" placeholder. */
  videoId: string | null;
}

const GUIDES: Guide[] = [
  {
    Icon: Link2,
    title: "Connect your Vendor Center to PandaWorld",
    body: "Link your Jumia Vendor Center account so PandaWorld can push listings straight to it.",
    videoId: null,
  },
  {
    Icon: WhatsAppIcon,
    title: "Link your WhatsApp number to PandaWorld",
    body: "Grab a connect code from your dashboard and send it to +233548534323 to link your account.",
    videoId: null,
  },
  {
    Icon: Laptop,
    title: "Auto list to Jumia on a laptop",
    body: "Install the Chrome extension, open a product on Jumia Vendor Center, and let AI autofill the whole listing.",
    videoId: null,
  },
  {
    Icon: Smartphone,
    title: "Auto list to Jumia on the phone",
    body: "Use the extension from your phone's browser to autofill listings wherever you are.",
    videoId: null,
  },
  {
    Icon: Bot,
    title: "Use the WhatsApp Chatbot",
    body: "Send product photos in a WhatsApp chat and the AI bot drafts and submits the listing for you.",
    videoId: null,
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
      <span className="text-xs font-medium uppercase tracking-wide">Video coming soon</span>
    </div>
  );
}

export default function ExtensionHowToPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">How To</h1>
      <p className="mt-2 text-sm text-zinc-500">
        Step-by-step guides for getting set up and listing on Jumia — from your laptop, your phone, or WhatsApp.
      </p>

      <div className="mt-8 space-y-6">
        {GUIDES.map((guide, i) => (
          <div key={guide.title} className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-orange-500 text-white">
                <guide.Icon className="h-4 w-4" />
              </div>
              <div>
                <p className="text-xs font-semibold text-zinc-400">{`0${i + 1}`}</p>
                <h2 className="text-base font-bold text-zinc-900">{guide.title}</h2>
              </div>
            </div>
            <p className="mt-3 text-sm text-zinc-600">{guide.body}</p>
            <div className="mt-4">
              <GuideVideo videoId={guide.videoId} title={guide.title} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
