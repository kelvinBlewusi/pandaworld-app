/**
 * Where a signed-in seller belongs.
 *
 * `/dashboard` is NOT it, and the difference has now bitten three separate
 * times: the welcome email's CTA, the Jumia OAuth error path, and the 404
 * page a seller reported after mistyping a URL.
 *
 * The reason is the same every time. `/dashboard` lives in the (main)
 * route group, and app/(main)/layout.tsx redirects to /onboarding/connect
 * unless the seller already holds an ACTIVE Jumia OAuth connection. That
 * connection is exactly what the WhatsApp and Chrome-extension flows exist
 * to let a seller skip — so pointing a general-purpose "go here" link at
 * /dashboard walks the newest users straight into the one wall the product
 * was built to avoid.
 *
 * The extension shell has no such gate, so it is the safe home for any
 * link that cannot know whether the seller has connected Jumia.
 *
 * The legacy web flow is still reachable, deliberately: /push-listings and
 * its own CTAs point at /dashboard because that IS the Jumia-OAuth
 * journey. Those are not mistakes and should stay.
 */
export const APP_HOME = "/extension/dashboard";
