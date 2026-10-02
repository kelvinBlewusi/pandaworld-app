import Link from "next/link";
import { isBillingEnabled } from "@/lib/billing/mode";
import { FREE_SIGNUP_CREDITS, LISTING_CREDIT_COST, LIVE_LISTING_CREDIT_COST } from "@/lib/billing/credit-packs";
import { COMMUNITY_WHATSAPP_URL, SUPPORT_EMAIL, SUPPORT_MAILTO } from "@/lib/constants/support";

export const metadata: import("next").Metadata = {
  title: "FAQ — Extension",
  robots: { index: false },
};

// ─── /extension/faq — answers for signed-in sellers ──────────────────────────
//
// What sellers ask most, grouped the way they hit it: setting up, sending
// products on WhatsApp, after submitting, and credits. The credits answers
// only show while billing is on (lib/billing/mode.ts), so they can't
// describe charges that aren't being made. Numbers come from
// lib/billing/credit-packs.ts, never typed in here.

type Item = { q: string; a: React.ReactNode };

const linkClass = "font-medium text-orange-600 hover:underline";

const SETTING_UP: Item[] = [
  {
    q: "What does PandaWorld do?",
    a: "It writes complete Jumia listings from your product photos: title, description, highlights and the category's fields. Send the photos on WhatsApp and submit from the chat, or use the Chrome extension to fill in Vendor Center's Add Products form while you're on it.",
  },
  {
    q: "Do I need to connect my Jumia account?",
    a: (
      <>
        For WhatsApp, yes, once: a Self Authorization application in Vendor Center, connected with its Client ID and a
        token. It stays connected after that. The Chrome extension doesn&apos;t need it.{" "}
        <Link href="/how-to/connect-jumia-vendor-center" className={linkClass}>How to connect</Link>
      </>
    ),
  },
  {
    q: "How do I link my WhatsApp number?",
    a: (
      <>
        Open Settings and tap Connect WhatsApp. You get a one-time code to send to the bot, and it confirms straight
        away. The code lasts 15 minutes.{" "}
        <Link href="/how-to/link-whatsapp" className={linkClass}>How to link</Link>
      </>
    ),
  },
  {
    q: "Which Jumia countries does it work with?",
    a: "Any Jumia country with Vendor Center. Listings are written in English, and prices use your shop's currency.",
  },
];

const ON_WHATSAPP: Item[] = [
  {
    q: "What are the two ways to send products?",
    a: (
      <>
        After you say how many products you&apos;re listing, the bot offers two. <strong>I</strong>: send each
        product&apos;s photos with its price as the caption, then its number (1, 2, 3…); the bot stays quiet until the
        last one. <strong>II</strong>: the bot takes you through one product at a time, and you reply{" "}
        <strong>done</strong> after each.{" "}
        <Link href="/how-to/list-on-jumia-from-whatsapp" className={linkClass}>See both, with an example</Link>
      </>
    ),
  },
  {
    q: "What should I put in the caption?",
    a: "The price, which Jumia won't accept a product without, and anything the photos don't show: colours, sizes, what's in the box, a sale price with its dates. If you know the category, add it too, e.g. \"Category: Wigs\", and the bot uses it.",
  },
  {
    q: "How long does drafting take?",
    a: "Usually a couple of minutes for a batch. The bot messages you when every product is drafted, with each one marked Ready or Held.",
  },
  {
    q: "Why is a product \"Held\"?",
    a: "Something about it would make Jumia refuse it, such as a missing price or a field its category requires, like the weight. The bot asks you for it right there in the chat; answer, or tap Skip and fill it in later from List from WhatsApp.",
  },
  {
    q: "The bot picked the wrong category. How do I change it?",
    a: "Send the product number and the category, e.g. \"2 category: Drop & Dangle\". If Jumia has more than one category by that name, the bot shows them so you can tap the right one, then refills the product's fields for it.",
  },
  {
    q: "How do I change something in a draft?",
    a: (
      <>
        Tell the bot, e.g. &quot;2: change the price to 150&quot;, or open the product from{" "}
        <Link href="/extension/whatsapp-listings" className={linkClass}>List from WhatsApp</Link> and edit it there.
      </>
    ),
  },
  {
    q: "What can I type to the bot at any time?",
    a: (
      <>
        <strong>status</strong> to see where you are, <strong>restart</strong> to start a new batch,{" "}
        <strong>retry 3</strong> when product 3 couldn&apos;t be drafted, <strong>submit all</strong> or{" "}
        <strong>submit 2</strong>, and{" "}
        <strong>help</strong> for the full list.
      </>
    ),
  },
];

const AFTER_SUBMITTING: Item[] = [
  {
    q: "How do I know a product went live?",
    a: "The bot messages you when Jumia accepts it. Jumia's quality team then reviews it before it shows in the shop.",
  },
  {
    q: "What happens if Jumia rejects it?",
    a: "The bot tells you why and, where it can, offers to fix and resubmit it for you. A rejected listing costs nothing.",
  },
];

function creditItems(): Item[] {
  return [
    {
      q: "When am I charged for a WhatsApp listing?",
      a: `When Jumia accepts it: ${LIVE_LISTING_CREDIT_COST} credits. Drafting, redrafting and fixing are free, and a listing Jumia rejects costs nothing. While a listing waits for Jumia, its credits are set aside.`,
    },
    {
      q: "And for the Chrome extension?",
      a: `${LISTING_CREDIT_COST} credit per autofill. You submit the product on Vendor Center yourself, so we can't see whether it went live and charge per fill instead.`,
    },
    {
      q: "Do new accounts get free credits?",
      a: `Yes, ${FREE_SIGNUP_CREDITS} credits on your first use, enough for ${Math.floor(FREE_SIGNUP_CREDITS / LIVE_LISTING_CREDIT_COST)} WhatsApp listings.`,
    },
    {
      q: "Do credits expire?",
      a: "No. Credits you buy stay on your account until you use them, and one balance covers WhatsApp and the extension.",
    },
    {
      q: "How do I buy more?",
      a: (
        <>
          Tap Buy credits on your <Link href="/extension/dashboard" className={linkClass}>dashboard</Link>. Paystack
          takes Ghana cards, mobile money (MTN, AirtelTigo, Telecel) and bank transfer.{" "}
          <Link href="/pricing" className={linkClass}>See the packs</Link>
        </>
      ),
    },
  ];
}

function Section({ title, items }: { title: string; items: Item[] }) {
  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">{title}</h2>
      <div className="mt-3 divide-y divide-zinc-100 rounded-xl border border-zinc-200 bg-white">
        {items.map((item) => (
          <details key={item.q} className="group px-4 py-3">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium text-zinc-900 [&::-webkit-details-marker]:hidden">
              {item.q}
              <span className="shrink-0 text-zinc-400 transition-transform group-open:rotate-45" aria-hidden>+</span>
            </summary>
            <div className="mt-2 text-sm leading-relaxed text-zinc-600">{item.a}</div>
          </details>
        ))}
      </div>
    </section>
  );
}

export default async function ExtensionFaqPage() {
  const billingOn = await isBillingEnabled();

  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-zinc-900">FAQ</h1>
        <p className="mt-1 text-sm text-zinc-500">Quick answers. For step-by-step help, see the <Link href="/how-to" className={linkClass}>guides</Link>.</p>
      </div>

      <Section title="Setting up" items={SETTING_UP} />
      <Section title="Listing on WhatsApp" items={ON_WHATSAPP} />
      <Section title="After you submit" items={AFTER_SUBMITTING} />
      {billingOn && <Section title="Credits" items={creditItems()} />}

      <p className="text-sm text-zinc-500">
        Still stuck? Ask in the{" "}
        <a href={COMMUNITY_WHATSAPP_URL} target="_blank" rel="noopener noreferrer" className={linkClass}>WhatsApp community</a>{" "}
        or email <a href={SUPPORT_MAILTO} className={linkClass}>{SUPPORT_EMAIL}</a>.
      </p>
    </div>
  );
}
