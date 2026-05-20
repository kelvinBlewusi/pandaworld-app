/**
 * Transactional email — Resend wrapper.
 *
 * Two goals:
 *   1. Single entry point. Every email the app sends goes through
 *      sendEmail() so we have one place to add logging, retry,
 *      provider swap, or compliance opt-outs later.
 *   2. Graceful no-op. When RESEND_API_KEY is unset (local dev, fresh
 *      deploy before secrets are configured), sendEmail logs a warning
 *      and returns success: false instead of crashing the caller.
 *      The actual user flow (signup, payment) must complete even when
 *      email fails — getting the message is a nice-to-have, missing
 *      the email shouldn't lock the seller out of their account.
 *
 * Required env vars when emails should actually send:
 *   - RESEND_API_KEY      — your Resend API key (resend.com)
 *   - EMAIL_FROM          — the From address (e.g.
 *                            "PandaWorld <hello@pandaworld.gh>"). The
 *                            domain must be verified in Resend or sends
 *                            will fail.
 */

import { Resend } from "resend";
import * as Sentry from "@sentry/nextjs";

let resendClient: Resend | null = null;

function getResend(): Resend | null {
  if (!process.env.RESEND_API_KEY) return null;
  // Lazily instantiate so a missing key in module-load time doesn't
  // throw — and so we can reload after env var changes between tests.
  if (!resendClient) {
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }
  return resendClient;
}

const DEFAULT_FROM = "PandaWorld <hello@pandaworld.gh>";

export interface SendEmailOptions {
  to:        string;
  subject:   string;
  html:      string;
  /** Optional plain-text fallback for clients that don't render HTML. */
  text?:     string;
  /**
   * Tag added to logs + Sentry breadcrumbs so we can filter "show me
   * all the welcome emails" or "all the payment-confirmation emails".
   * Doesn't show up in the email itself.
   */
  category?: string;
}

export interface SendEmailResult {
  success: boolean;
  /** Resend's message ID on success — useful for support lookups. */
  id?:     string;
  error?:  string;
}

export async function sendEmail(opts: SendEmailOptions): Promise<SendEmailResult> {
  const resend = getResend();
  const tag = opts.category ?? "transactional";

  if (!resend) {
    console.warn(`[email/${tag}] RESEND_API_KEY missing — would have sent to ${opts.to}`);
    return { success: false, error: "Email service not configured" };
  }

  try {
    const result = await resend.emails.send({
      from:    process.env.EMAIL_FROM ?? DEFAULT_FROM,
      to:      opts.to,
      subject: opts.subject,
      html:    opts.html,
      text:    opts.text,
    });

    if (result.error) {
      console.error(`[email/${tag}] resend rejected: ${result.error.message}`);
      Sentry.captureMessage(`Email send failed: ${tag}`, {
        level: "warning",
        extra: { error: result.error.message, to: redact(opts.to) },
      });
      return { success: false, error: result.error.message };
    }

    console.info(`[email/${tag}] sent ${result.data?.id} to ${redact(opts.to)}`);
    return { success: true, id: result.data?.id };
  } catch (e) {
    const msg = (e as Error).message;
    console.error(`[email/${tag}] threw: ${msg}`);
    Sentry.captureException(e, {
      tags:  { category: "email-send" },
      extra: { to: redact(opts.to), subject: opts.subject },
    });
    return { success: false, error: msg };
  }
}

/** Lightly redact email addresses in logs so they don't sit in plain text. */
function redact(email: string): string {
  const at = email.indexOf("@");
  if (at < 0) return "(invalid)";
  const local  = email.slice(0, at);
  const domain = email.slice(at);
  const head   = local.slice(0, 2);
  return `${head}${"*".repeat(Math.max(1, local.length - 2))}${domain}`;
}
