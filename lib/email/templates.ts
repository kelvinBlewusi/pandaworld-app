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
