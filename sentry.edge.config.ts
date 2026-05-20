/**
 * Sentry — Edge runtime init.
 *
 * Middleware (middleware.ts) and any route that runs on the Edge
 * funnel through this. We don't have many edge routes today, but
 * Sentry's Next.js integration wants the file present for full
 * coverage.
 */

import * as Sentry from "@sentry/nextjs";

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
  });
}
