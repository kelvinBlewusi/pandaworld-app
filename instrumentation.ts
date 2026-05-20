/**
 * Next.js instrumentation hook — loads Sentry on the appropriate
 * runtime. Sentry's Next.js SDK relies on this file existing at the
 * project root so the right config (server vs edge) is loaded per
 * request.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

// Forward unhandled request errors to Sentry — Next.js calls this
// hook when a request handler throws.
export { captureRequestError as onRequestError } from "@sentry/nextjs";
