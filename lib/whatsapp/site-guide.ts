/**
 * PandaWorld's website, page by page, and how each thing a seller does on it
 * works, for the assistant (lib/whatsapp/assistant.ts) to explain where to
 * find something and walk a seller through it step by step (owner,
 * 2026-10-07: "let the chat know our site very well ... like connect
 * WhatsApp, use extension, regenerate key, the entire flow").
 *
 * Kept true to the pages: when a page, a button's words or a flow changes,
 * change it here too. The links named [like_this] are the assistant's link
 * names (assistantLinks), which it can send as a button.
 */

import { BOT_NUMBER_DISPLAY, SUPPORT_EMAIL } from "@/lib/constants/support";

export function siteGuide(): string {
  return [
    "The website (pandaworld's dashboard, after signing in; the left menu on a laptop, the ☰ menu on a phone):",
    "- Jumia Listing Assistant [assistant]: this same chat on the website. Upload photos with the Upload button (up to 8 at a time) or drag them in; everything the WhatsApp bot does works there, except shipping label PDFs and the alerts, which come on WhatsApp only.",
    "- Extension Dashboard [dashboard]: the credit balance (\"Remaining credit\"), autofills in the last 30 days, the API key card (Copy, show, Regenerate key) and the extension's setup steps. \"Buy credits\" is at the top of every dashboard page (next to the bell, which holds PandaWorld's notices).",
    "- List from WhatsApp [review]: every WhatsApp and Listing Assistant batch, by day, with each product as Drafts, Needs attention, Submitted or Live. Open a product to edit it (name, price, stock, brand, category, description, variations, images) and push it to Jumia with \"Push to Jumia\". A seller with no WhatsApp linked sees the Connect WhatsApp card here.",
    "- Calculator [calculator_app]: the Jumia fee calculator for their country.",
    "- Autofill Activity [listings]: the products the Chrome extension filled in, with how many fields each.",
    "- Guides [guides] and FAQ [faq]: step-by-step guides with videos, and the questions sellers ask most.",
    "- Settings [settings]: their details; the Jumia connection (connected or not, Re-authorise, Disconnect); WhatsApp (Connect WhatsApp, or the linked number with Disconnect); the API key (Regenerate key).",
    "- Public pages: credit packs [pricing], the Jumia price calculator [calculator], commission rates [commission], selling on Jumia in their country [country], terms [terms], privacy [privacy].",
    "",
    "How to do things (give the steps in order, short, with the page's own button words):",
    `- Link WhatsApp [guide_link_whatsapp]: Settings → WhatsApp → \"Connect WhatsApp\" (or the List from WhatsApp page). PandaWorld shows a one-time code like LINK-A1B2C3D4: tap \"Open WhatsApp to link\", or send the code to ${BOT_NUMBER_DISPLAY}. The bot confirms at once. The code lasts 15 minutes: make a new one if it runs out. To change number: Settings → WhatsApp → Disconnect, then connect the new one.`,
    "- Connect Jumia [guide_connect], once, to list from WhatsApp or the website (the extension doesn't need it): in Jumia Vendor Center [vendor_center], Settings → Applications → Create Application → \"Self Authorization\" (name it PandaWorld); tap the padlock to generate a token and copy it, and copy the application's Client ID; then in PandaWorld open Settings → Jumia (or the Connect Jumia page [connect_jumia]), pick the country, paste the Client ID and the token and click \"Connect Jumia\". Or paste both in this chat. Paste the token straight away: it only works for a short time. PandaWorld keeps the connection alive after that. If it says the token expired or Jumia stopped accepting it, generate a new token the same way and reconnect.",
    "- Use the Chrome extension [guide_extension] (on a laptop or desktop with Chrome, not a phone): install it from the Chrome Web Store [extension] and pin it; copy the API key from the Extension Dashboard (\"Copy\"); open the extension and paste the key where it says \"or sign in with API key\", then Connect; in Vendor Center go to Add Products, upload a photo and pick a category: the panel opens beside the form; optionally type details in \"About this listing\" (exact SKU, barcode, sizes, sale dates) and pick a writing style; click \"Autofill this listing\", check what it filled, and submit on Jumia's own form. Each autofill costs credits. In the panel, Pro and Business also have \"Polish images\" and \"Price calculator\".",
    "- Regenerate the API key (if it was shared, or the extension says the key was revoked): Extension Dashboard → API key card → \"Regenerate key\" (or Settings → API key), confirm. The old key stops at once and the extension signs out: copy the new key and paste it into the extension again.",
    "- List from WhatsApp or here [guide_whatsapp]: say how many products (1 to 10), pick how to send them (#I all at once, each product's photos then its number; #II one at a time with \"done\" after each), send each product's photos with its price and notes (colours, sizes, what's in the box, a sale price with dates, \"Category: …\") in the caption. The AI drafts them in a couple of minutes; fix anything in chat (\"2: price 150\") or on List from WhatsApp, then \"submit all\" or \"submit 2\".",
    "- Buy credits: \"Buy credits\" at the top of the dashboard, pick a pack, pay with Paystack (cards, mobile money: MTN, AirtelTigo, Telecel, or bank transfer). Credits arrive at once and never expire; one balance covers the chat, WhatsApp and the extension. Packs and what each unlocks: [pricing].",
    "- At 0 credits the chat says to top up once, then stays locked until the balance is above 0 again: a purchase, or a refund from Jumia's quality check, unlocks it.",
    "- A product Jumia rejected: the bot says why and offers Fix & resubmit; or edit it on List from WhatsApp and push it again. Products already live are changed here in chat (stock, price, sale, on/off, name, description) or in Vendor Center (photos, category).",
    "- Disconnect Jumia: Settings → Jumia → Disconnect, or type \"disconnect\" here.",
    `- A person to help: email ${SUPPORT_EMAIL}, or the community WhatsApp group [community].`,
  ].join("\n");
}
