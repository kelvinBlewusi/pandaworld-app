/**
 * Sentry — server-side init (Node runtime).
 *
 * Catches errors thrown from Server Components and API routes. The
 * webhook + cron routes are the highest-priority because they fire
 * unattended — if they break we won't notice until a seller pings us.
 */

import * as Sentry from "@sentry/nextjs";

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,

    integrations: [
      // Capture console.error and console.warn as Sentry events.
      //
      // WHY THIS MATTERS MORE HERE THAN IN MOST APPS: almost nothing in
      // this codebase throws. The failures that cost real money are
      // deliberately caught and logged — a job that ran but could not be
      // marked done (which double-charges the seller), a PostgREST claim
      // that timed out, a Gemini quota rejection, a feed poll that listed
      // nothing because its own query failed. Sentry only ever saw the
      // handful of paths that threw, so the system's best diagnostics went
      // nowhere.
      //
      // Two bugs on 2026-09-15 make the case: the WhatsApp bot told a
      // seller "I can't read that kind of message" in the middle of their
      // album, and the Jumia feed poll returned 200 {checked: 0} every
      // minute while four listings sat pending. Both logged. Neither
      // raised anything. Both were found by a human reading a chat
      // transcript hours later.
      //
      // warn is included on purpose. In this codebase warn is where
      // "degraded but continuing" lives — the retried claim, the skipped
      // user, the release that did not record — and those are exactly the
      // lines that precede an outage.
      Sentry.captureConsoleIntegration({ levels: ["error", "warn"] }),
    ],

    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,

    // Auto-tag the environment so prod errors don't drown in
    // preview-branch noise.
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",

    beforeSend(event) {
      // Belt-and-braces redact: the SDK already strips authorization
      // headers by default, but our routes occasionally log the
      // seller's userPrompt + listing title in error.message. Strip
      // anything that smells like a secret out of the top-level
      // message so we don't accidentally see raw OAuth tokens in
      // Sentry.
      if (event.message) {
        event.message = event.message
          .replace(/Bearer\s+[A-Za-z0-9._\-]+/g, "Bearer [redacted]")
          .replace(/enc:v1:[^\s,)]+/g, "[encrypted token redacted]");
      }
      return event;
    },
  });
}
