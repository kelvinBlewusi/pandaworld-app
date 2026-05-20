import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'

// Public routes — accessible to logged-out visitors.
//
// The root `/` is now the marketing landing (was a redirect-only page).
// `/pricing`, `/terms`, `/privacy` are static marketing/legal pages
// that need to be visible without an account, both for visitors and so
// Google can index the GHS pricing and the ToS / privacy commitments.
//
// Webhook routes (Paystack, etc.) need their own bypass because they
// arrive with no Clerk session — they're signed externally.
const isPublicRoute = createRouteMatcher([
  '/',
  '/pricing',
  '/terms',
  '/privacy',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/paystack/webhook',
  '/api/jumia/callback',
  '/api/cron/(.*)',
])

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    await auth.protect()
  }
})

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
}
