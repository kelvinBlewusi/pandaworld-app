/**
 * The FAQ: public at /faq (app/faq/page.tsx), linked from the extension
 * dashboard's sidebar and the site footer. Each answer has `text`, a plain
 * copy for the page's FAQPage structured data. The Credits answers only
 * appear while billing is on (lib/billing/mode.ts), so they can't describe
 * charges that aren't being made; their numbers come from
 * lib/billing/credit-packs.ts. Keep answers in step with what the bot does.
 */

import Link from "next/link";
import { FREE_SIGNUP_CREDITS, LISTING_CREDIT_COST, LIVE_LISTING_CREDIT_COST } from "@/lib/billing/credit-packs";

export interface FaqItem {
  q:    string;
  a:    React.ReactNode;
  /** The answer as plain text, for structured data. */
  text: string;
}
export interface FaqSection { title: string; items: FaqItem[] }

const linkClass = "font-medium text-orange-600 hover:underline";
const plain = (q: string, text: string): FaqItem => ({ q, a: text, text });

export function faqSections(billingOn: boolean): FaqSection[] {
  const sections: FaqSection[] = [
    {
      title: "Setting up",
      items: [
        plain(
          "What does PandaWorld do?",
          "It writes complete Jumia listings from your product photos: title, description, highlights and the category's fields. Send the photos on WhatsApp and submit from the chat, or use the Chrome extension to fill in Vendor Center's Add Products form while you're on it.",
        ),
        {
          q: "Do I need to connect my Jumia account?",
          text: "For WhatsApp, yes, once: a Self Authorization application in Vendor Center, connected with its Client ID and a token. It stays connected after that. The Chrome extension doesn't need it.",
          a: (
            <>
              For WhatsApp, yes, once: a Self Authorization application in Vendor Center, connected with its Client ID
              and a token. It stays connected after that. The Chrome extension doesn&apos;t need it.{" "}
              <Link href="/how-to/connect-jumia-vendor-center" className={linkClass}>How to connect</Link>
            </>
          ),
        },
        {
          q: "How do I link my WhatsApp number?",
          text: "Open Settings in your dashboard and tap Connect WhatsApp. You get a one-time code to send to the bot, and it confirms straight away. The code lasts 15 minutes.",
          a: (
            <>
              Open Settings in your dashboard and tap Connect WhatsApp. You get a one-time code to send to the bot, and
              it confirms straight away. The code lasts 15 minutes.{" "}
              <Link href="/how-to/link-whatsapp" className={linkClass}>How to link</Link>
            </>
          ),
        },
        plain(
          "Which Jumia countries does it work with?",
          "Any Jumia country with Vendor Center. Listings are written in English, and prices use your shop's currency.",
        ),
      ],
    },
    {
      title: "Listing on WhatsApp",
      items: [
        {
          q: "What are the two ways to send products?",
          text: "After you say how many products you're listing, the bot offers two. #I: send each product's photos with its price as the caption, then its number (1, 2, 3…); the bot stays quiet until the last one. #II: the bot takes you through one product at a time, and you reply done after each.",
          a: (
            <>
              After you say how many products you&apos;re listing, the bot offers two. <strong>#I</strong>: send each
              product&apos;s photos with its price as the caption, then its number (1, 2, 3…); the bot stays quiet
              until the last one. <strong>#II</strong>: the bot takes you through one product at a time, and you reply{" "}
              <strong>done</strong> after each.{" "}
              <Link href="/how-to/list-on-jumia-from-whatsapp" className={linkClass}>See both, with an example</Link>
            </>
          ),
        },
        plain(
          "What should I put in the caption?",
          "The price, which Jumia won't accept a product without, and anything the photos don't show: colours, sizes, what's in the box, a sale price with its dates. If you know the category, add it too, e.g. \"Category: Wigs\", and the bot uses it.",
        ),
        plain(
          "How long does drafting take?",
          "Usually a couple of minutes for a batch. The bot messages you when every product is drafted, with each one marked Ready or Held.",
        ),
        plain(
          "Why is a product \"Held\"?",
          "Something about it would make Jumia refuse it, such as a missing price or a field its category requires, like the weight. The bot asks you for it right there in the chat; answer, or tap Skip and fill it in later from List from WhatsApp in your dashboard.",
        ),
        plain(
          "The bot picked the wrong category. How do I change it?",
          "Send the product number and the category, e.g. \"2 category: Drop & Dangle\". If Jumia has more than one category by that name, the bot shows them so you can tap the right one, then refills the product's fields for it.",
        ),
        {
          q: "How do I change something in a draft?",
          text: "Tell the bot, e.g. \"2: change the price to 150\", or open the product from List from WhatsApp in your dashboard and edit it there.",
          a: (
            <>
              Tell the bot, e.g. &quot;2: change the price to 150&quot;, or open the product from{" "}
              <Link href="/extension/whatsapp-listings" className={linkClass}>List from WhatsApp</Link> in your
              dashboard and edit it there.
            </>
          ),
        },
        {
          q: "What can I type to the bot at any time?",
          text: "status to see where you are, restart to start a new batch, retry 3 when product 3 couldn't be drafted, submit all or submit 2, and help for the full list.",
          a: (
            <>
              <strong>status</strong> to see where you are, <strong>restart</strong> to start a new batch,{" "}
              <strong>retry 3</strong> when product 3 couldn&apos;t be drafted, <strong>submit all</strong> or{" "}
              <strong>submit 2</strong>, and <strong>help</strong> for the full list.
            </>
          ),
        },
      ],
    },
    {
      title: "After you submit",
      items: [
        plain(
          "How do I know a product went live?",
          "The bot messages you when Jumia accepts it. Jumia's quality team then reviews it before it shows in the shop.",
        ),
        plain(
          "What happens if Jumia rejects it?",
          "The bot tells you why and, where it can, offers to fix and resubmit it for you. A rejected listing costs nothing.",
        ),
      ],
    },
  ];

  if (billingOn) {
    const listings = Math.floor(FREE_SIGNUP_CREDITS / LIVE_LISTING_CREDIT_COST);
    sections.push({
      title: "Credits",
      items: [
        plain(
          "When am I charged for a WhatsApp listing?",
          `When Jumia accepts it: ${LIVE_LISTING_CREDIT_COST} credits. Drafting, redrafting and fixing are free, and a listing Jumia rejects costs nothing. While a listing waits for Jumia, its credits are set aside.`,
        ),
        plain(
          "And for the Chrome extension?",
          `${LISTING_CREDIT_COST} credit per autofill. You submit the product on Vendor Center yourself, so we can't see whether it went live and charge per fill instead.`,
        ),
        plain(
          "Do new accounts get free credits?",
          `Yes, ${FREE_SIGNUP_CREDITS} credits on your first use, enough for ${listings} WhatsApp listings.`,
        ),
        plain(
          "Do credits expire?",
          "No. Credits you buy stay on your account until you use them, and one balance covers WhatsApp and the extension.",
        ),
        {
          q: "How do I buy more?",
          text: "Tap Buy credits on your dashboard. Paystack takes Ghana cards, mobile money (MTN, AirtelTigo, Telecel) and bank transfer.",
          a: (
            <>
              Tap Buy credits on your <Link href="/extension/dashboard" className={linkClass}>dashboard</Link>.
              Paystack takes Ghana cards, mobile money (MTN, AirtelTigo, Telecel) and bank transfer.{" "}
              <Link href="/pricing" className={linkClass}>See the packs</Link>
            </>
          ),
        },
      ],
    });
  }
  return sections;
}
