# Staging

This branch exists to give Vercel a **stable** preview URL — unlike an
ordinary PR preview (a new random `*.vercel.app` URL every time), pushing
to `staging` redeploys the same branch-alias URL:

    https://pandaworldprogress-git-staging-kelvinblewusis-projects.vercel.app

That stability is what makes Jumia OAuth testable here at all:
`app/api/jumia/connect/route.ts` and `app/api/jumia/callback/route.ts`
both build `redirect_uri` from the incoming request's own origin, so
Jumia's OAuth server has to already know that origin as an allowed
redirect URI for whichever `app_id` you connect with — a URL that changes
on every deploy could never be registered in advance.

## What's already wired up

- `JUMIA_API_ENV=staging` is set for **all** Vercel Preview deployments
  (not just this branch), which points `lib/jumia/oauth.ts`'s
  `JUMIA_API_BASE` at `vendor-api-staging.jumia.com` instead of
  production. Production is untouched — it doesn't set this var, so it
  keeps the default (production).
- The redirect URI above needs to be added as an **additional allowed
  redirect URI** in Jumia Vendor Center, under whichever app (`app_id`)
  you're testing with — this is a one-time step on Jumia's side, not
  something this repo can configure.

## Open questions / things to verify by actually testing here

- `lib/jumia/oauth.ts`'s OAuth token exchange always goes to
  `auth-external.jumia.com` — there's no separate staging IdM in the
  code. Whether a token issued there is accepted by
  `vendor-api-staging.jumia.com` (or whether Jumia's staging environment
  needs its own registered OAuth app entirely) is unconfirmed; find out
  by actually connecting here.
- The database is **shared with production** — this branch talks to the
  same Supabase project as everything else. Test rows land in real
  tables. Not currently isolated; revisit if that turns out to matter.

## Usage

Keep this branch's PR open (do not merge it) so Vercel keeps building
it. Periodically merge `main` into `staging` to pick up new code:

    git fetch origin main
    git checkout staging
    git merge origin/main
    git push origin staging
