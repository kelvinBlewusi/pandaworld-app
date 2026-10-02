import { withSentryConfig } from "@sentry/nextjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "placehold.co",
      },
    ],
  },
  // Before middleware, so a signed-out visitor isn't asked to sign in
  // first: the FAQ was briefly at /extension/faq, now public at /faq.
  async redirects() {
    return [{ source: "/extension/faq", destination: "/faq", permanent: true }];
  },
};

// Sentry wraps the Next.js config to enable source-map upload (so
// stack traces in the dashboard point at our actual source, not the
// minified bundle) and the necessary build-time instrumentation.
//
// When SENTRY_AUTH_TOKEN is not set (local dev, preview branches
// before the token is configured), the wrapper degrades gracefully —
// source maps just don't upload, the app still builds.
export default withSentryConfig(nextConfig, {
  org:        process.env.SENTRY_ORG,
  project:    process.env.SENTRY_PROJECT,
  silent:     !process.env.CI,
  widenClientFileUpload: true,
  // Don't try to upload source maps when there's no auth token —
  // saves a confusing warning during local builds.
  disableLogger: true,
  // Hide source maps from browser DevTools — they're uploaded to
  // Sentry for our use, not for end users.
  hideSourceMaps: true,
});
