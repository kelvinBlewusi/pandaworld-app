import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'

// Public routes — accessible to logged-out visitors AND search-engine
// crawlers. Anything NOT in this list goes through `auth.protect()` and
// gets redirected to /sign-in for unauthenticated requests.
//
// Why each entry matters:
//   /             — marketing landing
//   /landing      — public landing reachable by logged-in users too
//   /pricing      — pricing comparison (must be indexable)
//   /terms        — legal page (must be indexable)
//   /privacy      — legal page (must be indexable)
//   /sign-in(.*)  — Clerk hosted UI
//   /sign-up(.*)  — Clerk hosted UI
//   /api/paystack/webhook — incoming webhook signed by Paystack HMAC
//   /api/webhooks/clerk    — incoming Clerk webhook
//   /api/jumia/connect     — Jumia OAuth kickoff. Normally requires a Clerk
//                            session (reads it itself via auth() below), but
//                            the WhatsApp connect-from-chat flow calls it with
//                            a one-time ?wa_token= instead (see
//                            lib/jumia/connect-token.ts) — a seller tapping
//                            that link from WhatsApp has no browser Clerk
//                            session at all. Leaving this off the allowlist
//                            meant auth.protect() redirected every such tap
//                            to /sign-in before the route's own wa_token
//                            handling ever ran, so "Connect Jumia" from
//                            WhatsApp always dead-ended on a Clerk sign-in
//                            card instead of Jumia's authorize page. Same
//                            shape as /api/jumia/callback below, which
//                            already had to be public for the same reason.
//   /api/jumia/callback    — Jumia OAuth post-redirect
//   /onboarding/done       — the success page /api/jumia/callback redirects
//                            to once OAuth finishes. Reached by the SAME
//                            no-Clerk-session browser as /api/jumia/connect
//                            above — gating this too would mean a WhatsApp
//                            seller's Jumia connection succeeds server-side
//                            (and the bot already messaged them to continue
//                            in chat) while their browser tab still dead-
//                            ends on a sign-in wall instead of the success
//                            card. Pure client component, no server data
//                            fetch — reads store name from its own URL
//                            params, nothing sensitive to gate.
//   /api/cron/(.*)         — Vercel cron, bearer-token authorised
//   /api/worker/(.*)       — the background job worker, called by pg_cron via
//                            pg_net (and by the WhatsApp webhook's own nudge),
//                            neither of which carries a Clerk session. Same
//                            bearer-CRON_SECRET contract as /api/cron above,
//                            checked inside the route, which refuses to run at
//                            all when the secret isn't configured. Omitting
//                            this is not a soft failure: Clerk answers an
//                            unauthenticated API route with a 404, so the
//                            worker silently looked like it didn't exist and
//                            queued batches never drained.
//   /extension              — Chrome extension marketing/onboarding page
//   /how-to                 — public step-by-step guides (app/how-to/page.tsx).
//                            Exists specifically to be indexed by Google;
//                            leaving it off this list meant Googlebot and
//                            every logged-out visitor got bounced to /sign-in.
//   /how-to/(.*)            — one page per guide (app/how-to/[slug]), same reason.
//   /faq                    — the FAQ (app/faq/page.tsx), public on purpose.
//   /jumia-price-calculator — the public price calculator and
//   /jumia-commission-rates   Jumia Ghana rate table, both written to be found
//                            by sellers searching for Jumia fees.
//   /calculator             — the nav's calculator link, which redirects to
//                            the visitor's own country's calculator. Behind
//                            auth.protect() it would send logged-out
//                            visitors to /sign-in instead.
//   /sell-on-jumia(/.*)     — one page per Jumia country (app/sell-on-jumia),
//                            for "sell on Jumia Nigeria" and the like.
//   /api/extension/fill     — the extension's autofill call. The extension has
//                            no Clerk browser session (it runs from Jumia's
//                            origin) — it authenticates itself with a
//                            PandaWorld API key checked inside the route (see
//                            lib/security/extension-keys.ts), not Clerk.
//   /api/extension/account   — same story: the panel's status row (plan +
//                            credits), authed by the same API key.
//   /api/extension/polish-images — the panel's Polish images (admin-only,
//                            checked inside the route), same API key.
//   /api/extension/notices/(.*) — the panel's "Got it" on a notice from us
//                            (lib/notices.ts), same API key.
//   /api/whatsapp/webhook    — incoming WhatsApp Business Cloud API webhook,
//                            called directly by Meta's servers with no Clerk
//                            session. Verifies its own X-Hub-Signature-256
//                            HMAC (see lib/whatsapp/webhook-verify.ts) and the
//                            GET handshake's hub.verify_token, same pattern as
//                            /api/paystack/webhook above.
//   NOTE: /extension/dashboard, /api/extension/keys, and the other
//   /api/whatsapp/* routes (status/generate-link/disconnect) are
//   intentionally NOT listed here — they're the logged-in dashboard + its
//   API, called by the browser with a real Clerk session, so they go through
//   the normal auth.protect() gate below like any other app route.
//
// SEO convention routes — Next.js renders these as dynamic server
// routes (NOT static files), so they're caught by the matcher below
// and need explicit allow-list entries. Without these Google Search
// Console reports "Couldn't fetch" for /sitemap.xml because Clerk
// redirects the crawler to /sign-in.
//   /sitemap.xml       — generated by app/sitemap.ts
//   /robots.txt        — generated by app/robots.ts
//   /opengraph-image   — generated by app/opengraph-image.tsx
//   /favicon.ico       — usually static but defensive include
const isPublicRoute = createRouteMatcher([
  '/',
  '/landing',
  '/pricing',
  '/terms',
  '/privacy',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/paystack/webhook',
  '/api/webhooks/clerk',
  '/api/jumia/connect',
  '/api/jumia/callback',
  '/onboarding/done',
  '/api/cron/(.*)',
  '/api/worker/(.*)',
  '/extension',
  '/how-to',
  '/how-to/(.*)',
  '/faq',
  '/jumia-price-calculator',
  '/embed/(.*)',
  '/calculator',
  '/jumia-commission-rates',
  '/sell-on-jumia',
  '/sell-on-jumia/(.*)',
  // The public category picker a category rejection links to (owner, 2026-10-10).
  '/categories',
  '/api/categories',
  '/api/extension/fill',
  '/api/extension/account',
  '/api/extension/polish-images',
  '/api/extension/notices/(.*)',
  '/api/whatsapp/webhook',
  // SEO + crawler routes — keep these PUBLIC or Google rejects the
  // sitemap and the OG link previews render as broken images.
  '/sitemap.xml',
  '/robots.txt',
  '/opengraph-image',
  '/opengraph-image(.*)',
  '/twitter-image',
  '/twitter-image(.*)',
  '/favicon.ico',
])

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    await auth.protect()
  }
})

export const config = {
  matcher: [
    // `_vercel` is excluded so Vercel Analytics' event beacon
    // (/_vercel/insights/event — no file extension, so the extension rule
    // below doesn't skip it) never hits auth.protect(). Otherwise every
    // page view from a logged-out visitor — i.e. all marketing traffic —
    // would be rejected before reaching Vercel.
    // mp4/webm: public/marketing/whatsapp-flow.mp4 plays on the homepage
    // and /how-to for logged-out visitors; without these it hit
    // auth.protect() and redirected to sign-in like any unknown route.
    '/((?!_next|_vercel|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest|mp4|webm)).*)',
    '/(api|trpc)(.*)',
  ],
}
