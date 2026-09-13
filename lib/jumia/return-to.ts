/**
 * Where to send the seller back to once the Jumia connect/OAuth round trip
 * finishes — threaded through /api/jumia/connect → the OAuth `state` param
 * → /api/jumia/callback → /onboarding/done, so starting the flow from
 * /extension/settings ends there too instead of always dropping the seller
 * onto the old web dashboard (/dashboard), regardless of where they began.
 *
 * Only ever an internal path we ourselves pass in (a hardcoded string in
 * one of our own components) — validated anyway since it arrives back
 * through a query param and, for /api/jumia/connect, through the OAuth
 * `state` blob, both of which a request could otherwise forge into an
 * open redirect.
 */
export function sanitizeReturnTo(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  if (!value.startsWith("/") || value.startsWith("//")) return undefined;
  if (value.includes("://")) return undefined;
  return value;
}
