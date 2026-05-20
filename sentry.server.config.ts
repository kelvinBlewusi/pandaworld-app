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
