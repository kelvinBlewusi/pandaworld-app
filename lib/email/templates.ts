/**
 * Transactional email templates — plain string-building so we don't
 * pull in @react-email/render or its tree of dependencies. Each
 * template returns { subject, html, text } and gets passed straight to
 * sendEmail().
 *
 * Inlined CSS because Gmail / Outlook / iOS Mail strip <style> blocks
 * inconsistently. Keep the styling skinny — typography + brand chip,
 * not a marketing site clone. Sellers reading these on a phone need
 * scan-ability over flourish.
 *
 * appUrl is required so links in the email work — pass
 * https://pandaworld.gh (or your prod URL) so the user goes to the
 * right place even when they open the email on a different device.
 */

import { CHROME_WEB_STORE_URL } from "@/lib/constants/support";
import { FREE_SIGNUP_CREDITS, LISTING_CREDIT_COST, LIVE_LISTING_CREDIT_COST } from "@/lib/billing/credit-packs";

const BRAND = "PandaWorld";

interface RenderResult {
  subject: string;
  html:    string;
  text:    string;
}

// ─── Welcome on signup ───────────────────────────────────────────────────────

export function welcomeEmail(opts: {
  firstName?: string | null;
  appUrl:     string;
}): RenderResult {
  const greeting = opts.firstName ? `Hi ${escapeHtml(opts.firstName)},` : "Hi,";
  // /extension/dashboard, NOT /dashboard. The latter lives in the (main)
  // route group, whose layout redirects to /onboarding/connect unless the
  // seller already has an ACTIVE Jumia OAuth connection — so this email
  // was walking every brand-new signup straight into the Jumia wall that
  // the WhatsApp and extension flows exist to let them skip. The extension
  // shell has no such gate.
  const dashboardUrl = `${opts.appUrl}/extension/dashboard`;
  const whatsappUrl  = `${opts.appUrl}/extension/whatsapp-listings`;
  const pricingUrl   = `${opts.appUrl}/pricing`;

  return {
    subject: `Welcome to ${BRAND}`,
    html: layout({
      title: `Welcome to ${BRAND}`,
      body: `
        <p style="margin:0 0 16px;">${greeting}</p>
        <p style="margin:0 0 16px;">
          Welcome aboard. PandaWorld writes your Jumia listings for you, sends
          them to your Jumia shop and saves you time — and there are two ways
          to use it, so pick whichever suits how you work.
        </p>
        <p style="margin:0 0 8px; font-size:15px;"><strong>1. From WhatsApp</strong></p>
        <p style="margin:0 0 16px; font-size:14px; color:#3f3f46;">
          Send the bot your product photos and a line about each one — the
          price, the colours, what&rsquo;s in the box. It writes the listing,
          picks the Jumia category, fills the attributes, and submits when
          you say so. You can connect your Jumia account right there in the
          chat; no forms.
        </p>
        <p style="margin:0 0 8px; font-size:15px;"><strong>2. The Chrome extension</strong></p>
        <p style="margin:0 0 24px; font-size:14px; color:#3f3f46;">
          Already filling in Jumia&rsquo;s own form? The extension fills it for
          you while you sit on the page.
        </p>
        <p style="margin:0 0 24px;">
          <strong>Start for free</strong> — no card needed.
        </p>
        ${ctaButtonPair(
          { label: "Start listing from WhatsApp", href: whatsappUrl },
          { label: "Start using Chrome extension", href: CHROME_WEB_STORE_URL },
        )}
        <p style="margin:24px 0 8px; font-size:13px; color:#52525b;">
          Two things worth knowing now:
        </p>
        <ul style="margin:0 0 24px 16px; padding:0; font-size:13px; color:#52525b;">
          <li style="margin:0 0 6px;"><strong>Always tell us the price.</strong> We never guess it, and a product without one can&rsquo;t be submitted to Jumia.</li>
          <li>The AI&rsquo;s suggestions need a quick eyeball before you submit. It can miss.</li>
        </ul>
        <p style="margin:0 0 16px; font-size:13px; color:#52525b;">
          Your <a href="${dashboardUrl}" style="color:#ea580c;">dashboard</a> shows
          everything you&rsquo;ve drafted, and
          <a href="${pricingUrl}" style="color:#ea580c;">pricing</a> covers what
          happens past the free listings.
        </p>
        <p style="margin:0; font-size:13px; color:#71717a;">
          Reply to this email if you get stuck. We read every message.
        </p>
      `,
    }),
    text: [
      greeting,
      "",
      "Welcome to PandaWorld. We write your Jumia listings for you, send them to your Jumia shop and save you time - and there are two ways to use it, so pick whichever suits how you work.",
      "",
      "1. From WhatsApp",
      "   Send the bot your product photos and a line about each one - the price,",
      "   the colours, what's in the box. It writes the listing, picks the Jumia",
      "   category, fills the attributes, and submits when you say so. You can",
      "   connect your Jumia account right there in the chat; no forms.",
      "",
      "2. The Chrome extension",
      "   Already filling in Jumia's own form? The extension fills it for you",
      "   while you sit on the page.",
      "",
      "Start for free - no card needed.",
      "",
      `Start listing from WhatsApp: ${whatsappUrl}`,
      `Start using the Chrome extension: ${CHROME_WEB_STORE_URL}`,
      "",
      "Two things worth knowing now:",
      "  - Always tell us the price. We never guess it, and a product without one",
      "    can't be submitted to Jumia.",
      "  - The AI's suggestions need a quick eyeball before you submit. It can miss.",
      "",
      `Your dashboard: ${dashboardUrl}`,
      `Pricing: ${pricingUrl}`,
      "",
      "Reply to this email if you get stuck. We read every message.",
    ].join("\n"),
  };
}

// ─── Announcement: WhatsApp bot number + Chrome extension ────────────────────
//
// One-off feature announcement, sent via app/api/admin/broadcast/
// whatsapp-extension-announcement/route.ts to every existing sign-up.
// Not a recurring transactional email — no unsubscribe link, since it's a
// one-time send to an existing account holder rather than a marketing
// list. Points "Connect WhatsApp" at the dashboard's connect-code flow
// (not a bare wa.me link) because the bot needs a LINK-XXXXXXXX code to
// link an account.

const WHATSAPP_BOT_NUMBER = "+233 54 853 4323";

export function whatsappExtensionAnnouncementEmail(opts: {
  firstName?: string | null;
  appUrl:     string;
}): RenderResult {
  const greeting = opts.firstName ? `Hi ${escapeHtml(opts.firstName)},` : "Hi there,";
  const whatsappUrl = `${opts.appUrl}/extension/whatsapp-listings`;
  const howToUrl    = `${opts.appUrl}/how-to`;

  return {
    subject: "Two faster ways to list on Jumia",
    html: layout({
      title: "Two faster ways to list on Jumia",
      body: `
        <p style="margin:0 0 16px;">${greeting}</p>
        <p style="margin:0 0 24px;">
          A quick update on how to get products onto Jumia faster with PandaWorld —
          whether you&rsquo;re on your phone or your laptop.
        </p>

        <p style="margin:0 0 8px; font-size:15px;"><strong>1. List straight from WhatsApp</strong></p>
        <p style="margin:0 0 12px; font-size:14px; color:#3f3f46;">
          Send product photos to our WhatsApp number and the AI drafts the listing for
          you — title, description, category, and every attribute Jumia asks for.
        </p>
        <p style="margin:0 0 16px; padding:12px 16px; background:#f0fdf4; border:1px solid #bbf7d0; border-radius:8px; font-size:16px; font-weight:700; color:#15803d; text-align:center;">
          ${WHATSAPP_BOT_NUMBER}
        </p>
        <ol style="margin:0 0 20px 16px; padding:0; font-size:14px; line-height:1.7; color:#3f3f46;">
          <li>Link your number from your dashboard (one WhatsApp message, takes a few seconds).</li>
          <li>Tell the bot how many products you're listing.</li>
          <li>Send each product's photos with a note — price, colour, what's in the box.</li>
          <li>Review the drafts and reply <strong>submit</strong> — it goes live on Jumia.</li>
        </ol>

        <p style="margin:0 0 8px; font-size:15px;"><strong>2. Autofill listings on your laptop</strong></p>
        <p style="margin:0 0 24px; font-size:14px; color:#3f3f46;">
          Already on Jumia Vendor Center? The PandaWorld Chrome extension opens right
          next to the &ldquo;Add Products&rdquo; form and fills it in for you — title,
          description, highlights, attributes, brand. You just review and submit.
        </p>

        ${ctaButtonPair(
          { label: "Connect WhatsApp", href: whatsappUrl },
          { label: "Add to Chrome", href: CHROME_WEB_STORE_URL },
        )}

        <p style="margin:24px 0 0; font-size:13px; color:#52525b;">
          Both are free while we're in our early-access period — no card needed. Full
          step-by-step guides (with video walkthroughs) are up at
          <a href="${howToUrl}" style="color:#ea580c;">${howToUrl.replace(/^https?:\/\//, "")}</a>.
        </p>
        <p style="margin:16px 0 0; font-size:13px; color:#71717a;">
          Reply to this email if you get stuck — we read every message.
        </p>
      `,
    }),
    text: [
      greeting,
      "",
      "A quick update on how to get products onto Jumia faster with PandaWorld - whether you're on your phone or your laptop.",
      "",
      "1. List straight from WhatsApp",
      `   Send product photos to ${WHATSAPP_BOT_NUMBER} and the AI drafts the listing`,
      "   for you - title, description, category, and every attribute Jumia asks for.",
      "     - Link your number from your dashboard (one WhatsApp message).",
      "     - Tell the bot how many products you're listing.",
      "     - Send each product's photos with a note - price, colour, what's in the box.",
      "     - Review the drafts and reply submit - it goes live on Jumia.",
      "",
      "2. Autofill listings on your laptop",
      "   Already on Jumia Vendor Center? The PandaWorld Chrome extension opens right",
      "   next to the \"Add Products\" form and fills it in for you.",
      "",
      `Connect WhatsApp: ${whatsappUrl}`,
      `Add to Chrome: ${CHROME_WEB_STORE_URL}`,
      "",
      "Both are free while we're in our early-access period - no card needed. Full",
      `step-by-step guides (with video walkthroughs): ${howToUrl}`,
      "",
      "Reply to this email if you get stuck - we read every message.",
    ].join("\n"),
  };
}

// ─── What's new + how-to videos (October 2026) ───────────────────────────────
//
// One-off broadcast to every sign-up (app/api/admin/broadcast/[campaign]):
// the improvements sellers will notice, and the five YouTube videos.
// Written for sellers reading on a phone, many in their second language:
// short sentences, one idea per line, every video a big tappable picture.
//
// Its own layout rather than layout(): the video pictures need the full
// width and two columns that fold to one on a phone. The columns are
// inline-block divs with Outlook-only tables around them (Outlook renders
// through Word, which ignores inline-block); everywhere else they wrap on
// their own when the screen is too narrow for two.
//
// The pictures live at /email/2026-10/ on the site: our YouTube thumbnails
// with a play button and the running time drawn on. YouTube's own copies
// have neither, and a picture that doesn't look playable doesn't get tapped.

const WHATSAPP_BOT_WA_ME = "https://wa.me/233548534323?text=Hi";

const UPDATE_VIDEOS = [
  { id: "XDoao0IO7RM", img: "01-link-whatsapp",          title: "Link your WhatsApp",         line: "One message links your number.",          mins: "1 min" },
  { id: "FTQmSdMNuNE", img: "02-connect-vendor-center",  title: "Connect your Vendor Center", line: "Do it once. It stays connected.",         mins: "2 min" },
  { id: "YRoahiccZdI", img: "03-list-from-whatsapp",     title: "List from WhatsApp",         line: "Send photos and the price. We do the rest.", mins: "2 min" },
  { id: "JKv7b81M7fE", img: "04-auto-fill-laptop",       title: "Auto-fill on a laptop",      line: "Fill Jumia's Add Product form in one click.", mins: "2 min" },
];

const UPDATE_NEWS: [title: string, line: string][] = [
  ["Connect Jumia once. It stays connected.", "Paste your Client ID and token one time. No more logging in to Jumia every day."],
  ["List up to 10 products at once on WhatsApp.", "Send them all together, or let the bot guide you one product at a time."],
  ["The bot asks instead of guessing.", "If a price, size or colour is missing, it asks you. Just reply."],
  ["Choose the category yourself.", "Not sure the bot picked the right one? Tap the right category, or write it in your notes, like \"category: wigs\"."],
  ["Fix and resubmit in the chat.", "If Jumia rejects a listing, tap Fix & resubmit and answer the bot's question."],
  ["We tell you when it's live.", "The bot messages you as each listing goes live on Jumia."],
  ["Pay only when your listing goes live.",
    (LISTING_CREDIT_COST === LIVE_LISTING_CREDIT_COST
      ? `A WhatsApp listing or an autofill is ${LIVE_LISTING_CREDIT_COST} credits. `
      : `A WhatsApp listing is ${LIVE_LISTING_CREDIT_COST} credits and an autofill is ${LISTING_CREDIT_COST}. `) +
    `Drafts, fixes and rejected listings are free. New accounts get ${FREE_SIGNUP_CREDITS} free credits, and credits never expire.`],
  ["Free price calculator for every Jumia country.", "See what you keep after Jumia's commission and fees, before you set your price."],
];

export function improvementsAndVideosEmail(opts: {
  firstName?: string | null;
  appUrl:     string;
}): RenderResult {
  const name     = opts.firstName?.trim();
  const greeting = name ? `Hi ${escapeHtml(name)},` : "Hi there,";
  const img      = (file: string) => `${opts.appUrl}/email/2026-10/${file}.jpg`;
  const yt       = (id: string) => `https://youtu.be/${id}`;
  const howTo    = `${opts.appUrl}/how-to`;
  const calc     = `${opts.appUrl}/calculator`;
  const subject  = "New on PandaWorld: easier listing, and videos that show you how";
  const preheader = "Five short videos. Watch one, then list your next product from WhatsApp.";

  const font = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;";
  const button = (label: string, href: string, filled: boolean) => `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;"><tr>
      <td align="center" style="border-radius:10px; ${filled ? "background:#f97316;" : "border:2px solid #f97316;"}">
        <a href="${href}" style="display:inline-block; padding:${filled ? "14px 26px" : "12px 24px"}; ${font} font-size:16px; font-weight:700; color:${filled ? "#ffffff" : "#c2410c"}; text-decoration:none; border-radius:10px;">${escapeHtml(label)}</a>
      </td>
    </tr></table>`;

  const card = (v: (typeof UPDATE_VIDEOS)[number], n: number) => `
    <div class="pw-col" style="display:inline-block; width:100%; max-width:276px; vertical-align:top;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="pw-cell" style="padding:8px 8px 16px;">
        <a href="${yt(v.id)}" style="text-decoration:none;"><img class="pw-img" src="${img(v.img)}" width="260" alt="Video: ${escapeHtml(v.title)} (${v.mins})" style="display:block; width:100%; max-width:260px; height:auto; border:0; border-radius:10px;" /></a>
        <p style="margin:10px 0 2px; ${font} font-size:16px; line-height:1.35; font-weight:700; color:#18181b;"><a href="${yt(v.id)}" style="color:#18181b; text-decoration:none;">${n}. ${escapeHtml(v.title)}</a></p>
        <p style="margin:0; ${font} font-size:14px; line-height:1.5; color:#52525b;">${escapeHtml(v.line)} <span style="color:#a1a1aa;">&middot; ${v.mins}</span></p>
      </td></tr></table>
    </div>`;

  const pairs = [UPDATE_VIDEOS.slice(0, 2), UPDATE_VIDEOS.slice(2, 4)].map((pair, row) => `
    <tr><td align="center" class="pw-pad" style="padding:0 16px; font-size:0;">
      <!--[if mso]><table role="presentation" width="552" cellpadding="0" cellspacing="0" border="0"><tr><td width="276" valign="top"><![endif]-->
      ${card(pair[0], row * 2 + 1)}
      <!--[if mso]></td><td width="276" valign="top"><![endif]-->
      ${card(pair[1], row * 2 + 2)}
      <!--[if mso]></td></tr></table><![endif]-->
    </td></tr>`).join("");

  const news = UPDATE_NEWS.map(([title, line]) => `
    <tr>
      <td width="34" valign="top" style="padding:2px 12px 18px 0;">
        <div style="width:24px; height:24px; line-height:24px; border-radius:12px; background:#fff1e6; color:#c2410c; ${font} font-size:14px; font-weight:700; text-align:center;">&#10003;</div>
      </td>
      <td valign="top" style="padding:0 0 18px; ${font}">
        <p style="margin:0 0 2px; font-size:16px; line-height:1.4; font-weight:700; color:#18181b;">${escapeHtml(title)}</p>
        <p style="margin:0; font-size:14px; line-height:1.55; color:#52525b;">${escapeHtml(line)}</p>
      </td>
    </tr>`).join("");

  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>${escapeHtml(subject)}</title>
<style>
  /* Phones: one video per row, as wide as the text. Clients that drop
     this block still get two columns that wrap, just a little narrower. */
  @media (max-width: 600px) {
    .pw-col { max-width: 100% !important; }
    .pw-img { max-width: 100% !important; }
    .pw-cell { padding: 8px 0 16px !important; }
    .pw-pad { padding-left: 24px !important; padding-right: 24px !important; }
  }
</style>
</head>
<body style="margin:0; padding:0; background:#f4f4f5;">
  <div style="display:none; max-height:0; overflow:hidden; mso-hide:all;">${escapeHtml(preheader)}${"&#847;&zwnj;&nbsp;".repeat(60)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f5;">
    <tr><td align="center" style="padding:24px 12px;">
      <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; background:#ffffff; border-radius:16px;">

        <tr><td style="padding:24px 24px 8px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="padding-right:10px;"><img src="${opts.appUrl}/brand/panda-p-logo-trimmed.png" width="36" height="32" alt="" style="display:block; border:0;" /></td>
            <td style="${font} font-size:18px; font-weight:800; color:#18181b; letter-spacing:-0.01em;">PandaWorld</td>
          </tr></table>
        </td></tr>

        <tr><td style="padding:16px 24px 4px; ${font}">
          <h1 style="margin:0 0 14px; font-size:26px; line-height:1.25; font-weight:800; color:#18181b;">List on Jumia faster, with videos that show you how</h1>
          <p style="margin:0 0 12px; font-size:16px; line-height:1.6; color:#27272a;">${greeting}</p>
          <p style="margin:0 0 20px; font-size:16px; line-height:1.6; color:#27272a;">We have made PandaWorld easier to use. Below are the biggest changes, and five short videos that show every step. Most take about a minute.</p>
        </td></tr>

        <tr><td style="padding:0 24px; ${font}">
          <p style="margin:0 0 10px; font-size:13px; font-weight:800; letter-spacing:0.08em; text-transform:uppercase; color:#c2410c;">Start here</p>
          <a href="${yt("kcmy3jnEFZk")}" style="text-decoration:none;"><img src="${img("00-walkthrough")}" width="552" alt="Video: the full PandaWorld walkthrough (4 min)" style="display:block; width:100%; max-width:552px; height:auto; border:0; border-radius:12px;" /></a>
          <p style="margin:14px 0 4px; font-size:18px; line-height:1.35; font-weight:800; color:#18181b;"><a href="${yt("kcmy3jnEFZk")}" style="color:#18181b; text-decoration:none;">The full walkthrough</a></p>
          <p style="margin:0 0 18px; font-size:15px; line-height:1.55; color:#52525b;">Both ways to list, in 4 minutes: on your laptop with the Chrome extension, and from your phone on WhatsApp.</p>
          ${button("Watch the walkthrough", yt("kcmy3jnEFZk"), true)}
        </td></tr>

        <tr><td style="padding:32px 24px 6px; ${font}">
          <h2 style="margin:0 0 4px; font-size:20px; line-height:1.3; font-weight:800; color:#18181b;">Step by step</h2>
          <p style="margin:0; font-size:15px; line-height:1.55; color:#52525b;">Watch them in order the first time. Videos 1 and 2 you only do once.</p>
        </td></tr>
        ${pairs}

        <tr><td style="padding:16px 24px 0;"><div style="height:1px; line-height:1px; background:#e4e4e7;">&nbsp;</div></td></tr>

        <tr><td style="padding:28px 24px 8px; ${font}">
          <h2 style="margin:0 0 18px; font-size:20px; line-height:1.3; font-weight:800; color:#18181b;">What's new</h2>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${news}</table>
          <p style="margin:0 0 4px; font-size:14px; line-height:1.55; color:#52525b;">Try the calculator: <a href="${calc}" style="color:#c2410c; font-weight:700;">${calc.replace(/^https?:\/\//, "")}</a></p>
        </td></tr>

        <tr><td style="padding:24px 24px 8px; ${font}">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fff7ed; border-radius:14px;"><tr><td align="center" style="padding:24px 20px;">
            <p style="margin:0 0 6px; ${font} font-size:20px; line-height:1.3; font-weight:800; color:#18181b;">Ready to list your next product?</p>
            <p style="margin:0 0 18px; ${font} font-size:15px; line-height:1.55; color:#52525b;">Message the bot on WhatsApp: <strong style="color:#18181b; white-space:nowrap;">+233 54 853 4323</strong></p>
            ${button("Start on WhatsApp", WHATSAPP_BOT_WA_ME, true)}
            <div style="height:12px; line-height:12px;">&nbsp;</div>
            ${button("Get the Chrome extension", CHROME_WEB_STORE_URL, false)}
          </td></tr></table>
        </td></tr>

        <tr><td style="padding:16px 24px 28px; ${font}">
          <p style="margin:0 0 6px; font-size:14px; line-height:1.6; color:#52525b;">Every guide, with its video: <a href="${howTo}" style="color:#c2410c; font-weight:700;">${howTo.replace(/^https?:\/\//, "")}</a></p>
          <p style="margin:0; font-size:14px; line-height:1.6; color:#52525b;">Stuck? Reply to this email. We read every message.</p>
        </td></tr>

        <tr><td style="padding:18px 24px 24px; border-top:1px solid #e4e4e7; ${font}">
          <p style="margin:0; font-size:12px; line-height:1.6; color:#a1a1aa;">You're getting this email because you have a PandaWorld account. Don't want updates like this? Reply "unsubscribe" and we'll take you off the list.</p>
        </td></tr>

      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    greeting,
    "",
    "We have made PandaWorld easier to use. Below are the biggest changes, and five short videos that show every step. Most take about a minute.",
    "",
    "START HERE",
    `The full walkthrough (4 min): ${yt("kcmy3jnEFZk")}`,
    "",
    "STEP BY STEP",
    ...UPDATE_VIDEOS.map((v, i) => `${i + 1}. ${v.title} (${v.mins}): ${yt(v.id)}`),
    "",
    "WHAT'S NEW",
    ...UPDATE_NEWS.map(([title, line]) => `- ${title} ${line}`),
    `Price calculator: ${calc}`,
    "",
    "READY TO LIST YOUR NEXT PRODUCT?",
    `Message the bot on WhatsApp, +233 54 853 4323: ${WHATSAPP_BOT_WA_ME}`,
    `Get the Chrome extension: ${CHROME_WEB_STORE_URL}`,
    "",
    `Every guide, with its video: ${howTo}`,
    "Stuck? Reply to this email. We read every message.",
    "",
    "Don't want updates like this? Reply \"unsubscribe\" and we'll take you off the list.",
  ].join("\n");

  return { subject, html, text };
}

// ─── Payment confirmation ────────────────────────────────────────────────────

export function paymentConfirmationEmail(opts: {
  firstName?: string | null;
  amount:     string;   // "GHS 50.00" pre-formatted
  reference:  string;
  plan:       string;   // "Pro" or credit pack name
  appUrl:     string;
}): RenderResult {
  const greeting = opts.firstName ? `Hi ${escapeHtml(opts.firstName)},` : "Hi,";
  const billingUrl = `${opts.appUrl}/settings/billing`;

  return {
    subject: `Payment received — ${escapeHtml(opts.amount)} for ${escapeHtml(opts.plan)}`,
    html: layout({
      title: "Payment received",
      body: `
        <p style="margin:0 0 16px;">${greeting}</p>
        <p style="margin:0 0 16px;">
          Thanks — we&rsquo;ve received your payment for{" "}
          <strong>${escapeHtml(opts.plan)}</strong>. You can keep on listing.
        </p>
        <table cellpadding="0" cellspacing="0" border="0" style="width:100%; margin:0 0 24px; border-collapse:collapse;">
          <tr>
            <td style="padding:12px 0; border-bottom:1px solid #e4e4e7; font-size:13px; color:#71717a;">Amount</td>
            <td style="padding:12px 0; border-bottom:1px solid #e4e4e7; font-size:13px; color:#18181b; text-align:right;"><strong>${escapeHtml(opts.amount)}</strong></td>
          </tr>
          <tr>
            <td style="padding:12px 0; border-bottom:1px solid #e4e4e7; font-size:13px; color:#71717a;">Plan</td>
            <td style="padding:12px 0; border-bottom:1px solid #e4e4e7; font-size:13px; color:#18181b; text-align:right;">${escapeHtml(opts.plan)}</td>
          </tr>
          <tr>
            <td style="padding:12px 0; font-size:13px; color:#71717a;">Reference</td>
            <td style="padding:12px 0; font-size:12px; color:#18181b; text-align:right; font-family:monospace;">${escapeHtml(opts.reference)}</td>
          </tr>
        </table>
        ${ctaButton("View billing", billingUrl)}
        <p style="margin:24px 0 0; font-size:12px; color:#71717a;">
          Keep this email for your records — it&rsquo;s your receipt.
          Need a formal VAT invoice? Reply and we&rsquo;ll send one over.
        </p>
      `,
    }),
    text: [
      greeting,
      "",
      `Thanks — we've received your payment for ${opts.plan}.`,
      "",
      `Amount:    ${opts.amount}`,
      `Plan:      ${opts.plan}`,
      `Reference: ${opts.reference}`,
      "",
      `Billing:   ${billingUrl}`,
      "",
      "Keep this email for your records — it's your receipt. Need a formal VAT invoice? Reply and we'll send one over.",
    ].join("\n"),
  };
}

// ─── Layout + helpers ────────────────────────────────────────────────────────

function layout({ title, body }: { title: string; body: string }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0; padding:0; background:#fafafa; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif; color:#18181b;">
  <table cellpadding="0" cellspacing="0" border="0" style="width:100%; background:#fafafa; padding:40px 16px;">
    <tr>
      <td align="center">
        <table cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:560px; background:#ffffff; border:1px solid #e4e4e7; border-radius:12px; overflow:hidden;">
          <tr>
            <td style="padding:32px 32px 24px 32px;">
              <div style="display:inline-flex; align-items:center; gap:8px; margin-bottom:24px;">
                <span style="display:inline-block; width:28px; height:28px; line-height:28px; text-align:center; background:linear-gradient(135deg,#3b82f6,#9333ea); border-radius:8px; font-size:14px;">🐼</span>
                <strong style="font-size:14px; letter-spacing:-0.01em;">${BRAND}</strong>
              </div>
              <h1 style="margin:0 0 16px; font-size:22px; line-height:1.3; font-weight:700;">${escapeHtml(title)}</h1>
              ${body}
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px 28px 32px; border-top:1px solid #e4e4e7; background:#fafafa;">
              <p style="margin:0; font-size:11px; color:#a1a1aa; line-height:1.6;">
                You received this email because you have an account at ${BRAND}. <br />
                Built for Jumia Ghana sellers. Reply directly to reach support.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Two buttons side by side.
 *
 * A table with two cells and a spacer, not flex or inline-block: Outlook
 * renders email HTML through Word, which ignores both. The cells stack
 * naturally on a narrow phone because the table has no fixed width.
 *
 * The second button is outlined rather than filled — they are not equal
 * choices. WhatsApp is the one most sellers should start with, and two
 * identical orange blocks would make the reader stop and compare instead
 * of just tapping.
 */
function ctaButtonPair(
  primary:   { label: string; href: string },
  secondary: { label: string; href: string },
): string {
  return `<table cellpadding="0" cellspacing="0" border="0"><tr>
    <td style="background:#f97316; border-radius:8px;">
      <a href="${primary.href}" style="display:inline-block; padding:12px 20px; font-size:14px; font-weight:600; color:#ffffff; text-decoration:none;">${escapeHtml(primary.label)}</a>
    </td>
    <td style="width:10px;">&nbsp;</td>
    <td style="border:1px solid #d4d4d8; border-radius:8px;">
      <a href="${secondary.href}" style="display:inline-block; padding:11px 19px; font-size:14px; font-weight:600; color:#3f3f46; text-decoration:none;">${escapeHtml(secondary.label)}</a>
    </td>
  </tr></table>`;
}

function ctaButton(label: string, href: string): string {
  return `<table cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td style="background:#f97316; border-radius:8px;">
        <a href="${href}" style="display:inline-block; padding:12px 20px; font-size:14px; font-weight:600; color:#ffffff; text-decoration:none;">${escapeHtml(label)}</a>
      </td>
    </tr>
  </table>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
