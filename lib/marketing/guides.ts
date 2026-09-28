/**
 * The step-by-step guides: shown together on /how-to and one per page at
 * /how-to/<slug> (app/how-to/[slug]/page.tsx), each page written to be
 * found by the search a seller would type for it.
 *
 * Four guides, not five — "Connect Vendor Center" and "Link WhatsApp" are
 * each their own guide since they're one-time setup steps shared by both
 * products, and "list on a laptop" (Chrome extension) and "list from
 * WhatsApp" are the two actual day-to-day flows. The Chrome extension
 * doesn't run on a phone; sending photos on WhatsApp IS the phone-based
 * way to list.
 */

import { Link2, Laptop } from "lucide-react";
import { WhatsAppIcon } from "@/components/whatsapp/whatsapp-icon";

/** Any icon that takes a className — lucide's, or one of our own brand
 *  marks (WhatsAppIcon isn't a lucide ForwardRef). */
type IconComponent = (props: { className?: string }) => React.ReactNode;

export interface Guide {
  /** URL segment: /how-to/<slug>. Changing one breaks indexed links. */
  slug: string;
  Icon: IconComponent;
  title: string;
  /** The page's <title>, phrased the way sellers search. */
  metaTitle: string;
  /** Meta description: what the guide gets you, in a sentence or two. */
  description: string;
  intro: string;
  steps: string[];
  /** YouTube video ID once recorded. null renders the "coming soon" placeholder. */
  videoId: string | null;
  /** A recording we host ourselves, shown instead of the YouTube slot. */
  recording?: "whatsapp-flow";
}

export const GUIDES: Guide[] = [
  {
    slug: "connect-jumia-vendor-center",
    Icon: Link2,
    title: "Connect your Vendor Center to PandaWorld",
    metaTitle: "How to Connect Jumia Vendor Center to PandaWorld",
    description:
      "Create a Jumia Self Authorization application, generate a token and connect it to PandaWorld once. It stays connected, so listings drafted on WhatsApp go straight to Jumia.",
    intro:
      "Needed before you can push listings from WhatsApp (the Chrome extension doesn't need this — it fills in Jumia's own form directly in your browser). You do it once: PandaWorld keeps the connection alive after that, with no logins.",
    steps: [
      "Go to vendorcenter.jumia.com and sign in to your seller account.",
      "In Vendor Center, go to Settings → Applications → Create Application, and choose \"Self Authorization\". Name it PandaWorld.",
      "On the Manage Applications screen, click the orange lock icon (Generate Token) in the Actions column next to PandaWorld, and copy the token.",
      "Copy the application's Client ID too.",
      "In PandaWorld, open the Connect Jumia page, pick your country, paste the Client ID and the token, and click \"Connect Jumia\". Or paste both into the WhatsApp chat. Paste the token straight away: a generated token only works for a short time.",
    ],
    videoId: null,
  },
  {
    slug: "link-whatsapp",
    Icon: WhatsAppIcon,
    title: "Link your WhatsApp number to PandaWorld",
    metaTitle: "How to Link WhatsApp to PandaWorld for Jumia Listings",
    description:
      "Link your WhatsApp number to PandaWorld with a one-time code in under a minute, then list products on Jumia by sending photos in a chat.",
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
    slug: "chrome-extension-autofill",
    Icon: Laptop,
    title: "Auto-list to Jumia on a laptop",
    metaTitle: "How to Autofill Jumia Listings with the PandaWorld Chrome Extension",
    description:
      "Install the PandaWorld Chrome extension and let AI fill in the title, description, highlights and attributes on Jumia Vendor Center's Add Products form.",
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
    slug: "list-on-jumia-from-whatsapp",
    Icon: WhatsAppIcon,
    title: "Use the WhatsApp Chatbot",
    metaTitle: "How to List Products on Jumia from WhatsApp",
    description:
      "Send product photos to the PandaWorld WhatsApp bot, get complete Jumia listings drafted by AI, and submit them to Jumia from the chat. No laptop needed.",
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

export function getGuide(slug: string): Guide | undefined {
  return GUIDES.find((g) => g.slug === slug);
}
