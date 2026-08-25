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

import { PLANS } from "@/lib/billing/plans";

const BRAND = "PandaWorld";

/**
 * The free plan's monthly listing allowance, read from the plan config
 * rather than written out — the welcome email used to claim "2 free
 * listings", which matched neither the plan (5/month) nor anything else
 * the site says. Deriving it means the email can't drift again when the
 * allowance changes.
 */
const FREE_MONTHLY_LISTINGS = PLANS.free.monthly_listings;

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
  const dashboardUrl = `${opts.appUrl}/dashboard`;
  const docsUrl      = `${opts.appUrl}/pricing`;

  return {
    subject: `Welcome to ${BRAND}`,
    html: layout({
      title: `Welcome to ${BRAND}`,
      body: `
        <p style="margin:0 0 16px;">${greeting}</p>
        <p style="margin:0 0 16px;">
          Welcome aboard. You can now upload a phone photo of a product and
          our AI will pick the right Jumia category, fill the required
          attributes, polish the image, and push the listing straight to
          Vendor Center.
        </p>
        <p style="margin:0 0 24px;">
          You&rsquo;ve got <strong>${FREE_MONTHLY_LISTINGS} free listings every
          month</strong> to try things out — no card needed.
        </p>
        ${ctaButton("Create your first listing", dashboardUrl)}
        <p style="margin:24px 0 8px; font-size:13px; color:#52525b;">
          A few things to know:
        </p>
        <ul style="margin:0 0 24px 16px; padding:0; font-size:13px; color:#52525b;">
          <li style="margin:0 0 6px;">Connect your Jumia Vendor Center first — we walk you through it.</li>
          <li style="margin:0 0 6px;">The AI&rsquo;s suggestions need a quick eyeball before submit. It can miss.</li>
          <li>Image polish + AI rebuild are credit-based after your free listings — see <a href="${docsUrl}" style="color:#ea580c;">pricing</a>.</li>
        </ul>
        <p style="margin:0; font-size:13px; color:#71717a;">
          Reply to this email if you get stuck. We read every message.
        </p>
      `,
    }),
    text: [
      greeting,
      "",
      "Welcome to PandaWorld.",
      "",
      "You can now upload a phone photo of a product and our AI will pick the right Jumia category, fill the required attributes, polish the image, and push the listing to Vendor Center.",
      "",
      `You've got ${FREE_MONTHLY_LISTINGS} free listings every month to try — no card needed.`,
      "",
      `Get started: ${dashboardUrl}`,
      "",
      "A few things to know:",
      "  - Connect your Jumia Vendor Center first — we walk you through it.",
      "  - The AI's suggestions need a quick eyeball before submit. It can miss.",
      "  - Image polish + AI rebuild are credit-based after your free listings.",
      "",
      "Reply to this email if you get stuck. We read every message.",
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
