/**
 * Sentry — client-side init.
 *
 * Captures unhandled errors and unhandled promise rejections from
 * Client Components. Without an event in DSN form (SENTRY_DSN env
 * var is empty), Sentry's SDK no-ops — safe to keep this file in
 * preview branches and forks without leaking real events.
 */

import * as Sentry from "@sentry/nextjs";

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

    // 10% tracing on prod, full in preview/dev — cheap because we don't
    // have user-facing performance-heavy flows worth deeper sampling.
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,

    // Replay is disabled by default — pricey, low value for a B2B
    // listing tool. Flip on when we have a recurring user-reported
    // bug we can't reproduce.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,

    // Strip the seller's optional context out of breadcrumbs before
    // sending — they're free-text from the user and could contain
    // anything they wrote in to nudge the AI.
    beforeBreadcrumb(breadcrumb) {
      if (breadcrumb.category === "fetch" && breadcrumb.data?.url) {
        const url = String(breadcrumb.data.url);
        if (url.includes("/auto-analyze") && breadcrumb.data?.request_body) {
          breadcrumb.data.request_body = "[redacted seller context]";
        }
      }
      return breadcrumb;
    },

    // Don't surface "errors" from canceled fetches (component
    // unmounted, browser closed) — they pollute the dashboard.
    ignoreErrors: [
      "AbortError",
      "The user aborted a request.",
      "ResizeObserver loop limit exceeded",
    ],
  });
}
