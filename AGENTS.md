# AGENTS.md — Context for any AI assistant working on PandaWorld

> Read this entire file before making changes. It's the single source of truth for
> "what's been decided" on this project. Standard convention file readable by
> Claude Code, Claude Dev/Cline, Google Antigravity, Cursor (as fallback to
> `.cursorrules`), Aider (as fallback to `CONVENTIONS.md`), and others.

---

## What PandaWorld is

A B2B SaaS for **Ghanaian Jumia sellers** that auto-generates Jumia-compliant
product listings from one or more product photos. The seller uploads a photo →
the AI pipeline produces title, description, highlights, category, every required
attribute, and a "what's in the box" item list → one click pushes the listing to
Jumia Vendor Center.

**Goal of the current design phase:** "user enters price → submits". Every other
field should be AI-filled to a sensible default that passes Jumia QC.

**Markets**: launching in Ghana first (`pandaworldai.site`). Codebase is
multi-market-aware (Jumia has 9 markets); expansion to Côte d'Ivoire / Senegal /
Cameroon (French markets) is planned but not active.

**Pricing**: 4 tiers — Free (5 listings/mo), Starter (GHS 30 / 30 listings),
Pro (GHS 65 / 70 listings), Business (GHS 120 / 100 listings). Quota
enforcement is per-period (30-day rolling) via `lib/billing/quota.ts`.

**Founder/operator**: Kelvin (single-person operation). Communication style is
concise, direct, file-path-specific. Prefers small focused commits over big
refactors. Hates Lorem-ipsum-style placeholder code.

---

## Tech stack

- **Framework**: Next.js 14 (App Router) on Vercel
- **Auth**: Clerk (production instance live at `pandaworldai.site`, see DNS records under `clerk.pandaworldai.site` etc.)
- **Database**: Supabase Postgres + pgvector extension + Supabase Storage
- **Payments**: Paystack (Payment Pages flow, NOT API/initialize — see `lib/billing/plans.ts`)
- **AI**: Google AI Studio API key (`GOOGLE_API_KEY`) for:
  - Gemini 3.1 Flash Lite (vision + text) — listing analyze, gap-fill, description-expand
  - Gemini 2.5 Flash Image — text-to-image + image polish/rebuild
  - text-embedding (gemini-embedding-001 with `outputDimensionality: 768`) — not currently called by the analyze pipeline (see Operational gotchas); still available via lib/ai/embeddings.ts
  - Custom Search API (added 2026-05-28, CSE ID `05213a7d53c7a498e`) — web search ground truth for gap-fill
- **External integrations**: Jumia Vendor Center (OAuth), PhotoRoom (background removal, legacy), Resend (transactional email, optional)
- **Observability**: Vercel logs, Sentry (`app/error.tsx`)

---

## Critical state as of last session (2026-05-28)

### ✅ Production-ready
- Code compiles clean (`npx tsc --noEmit` returns 0)
- Git on `origin/main` at `c38bb1f` (Custom Search wire-up)
- Auth boundary tight (middleware allowlist in `middleware.ts`)
- Paystack webhook idempotent + HMAC verified
- Jumia push with token refresh + SKU collision retry
- Rate limiting per-user on all AI endpoints (`lib/rate-limit.ts`)
- No client-side secrets leaked
- Error boundary + 404 pages present
- SEO setup complete (robots.ts, sitemap.ts, JSON-LD, Search Console verified)
- DNS for `clerk.pandaworldai.site` etc. live and verified

### ⚠️ Operational — must verify before public launch
1. Vercel env vars: all 24 from `process.env.*` references must be set in Production scope
2. Clerk production keys (`pk_live_...` / `sk_live_...`) swapped into Vercel + redeployed
3. `CLERK_WEBHOOK_SECRET` configured (webhook endpoint at `/api/webhooks/clerk`)
4. `ADMIN_USER_IDS` updated with production Clerk userId (different from dev userId!)
5. Paystack on **Live mode** (`sk_live_`) with Ghana entity + KYC approved + 3 plan pages in GHS
6. Mobile Money channel rendering on Paystack checkout (long-pending issue)
7. Supabase migrations all run (see "Pending migrations" below)

### ❌ Hard blockers before public launch
- **Legal review** of `app/terms/page.tsx` + `app/privacy/page.tsx` by a Ghana-qualified lawyer (both contain draft notices). Substantive content is there — needs a sign-off, not a rewrite.

---

## The AI listing pipeline (the heart of the product)

Orchestrated by `lib/actions/auto-analyze.ts` → `runAutoAnalyze()` (extracted
from the route so the WhatsApp webhook can run the exact same pipeline
without a Clerk session). `app/api/listings/[id]/auto-analyze/route.ts` is
now a thin wrapper: authenticate, rate-limit, call it, map the result to JSON.

```
1. Pass A (vision): images + optional seller hint → ProductDescription JSON
   File: lib/actions/ai.ts → aiPassA_describeProduct()
   Model: gemini-3.1-flash-lite (forced via opts.forceBestModel)
   Output: title, brand, description, highlights, color, weight, model,
           warranty defaults, production country, use case, environment,
           variations, keywords

2. Category resolution — department-first, then narrow within it
   (redesigned 2026-09-13; see below for why the old approach was replaced):
   a) aiPassB0_pickDepartment() — small, cheap Gemini call: pick the best
      top-level department (~20-40 broad options, e.g. "Fashion", "Home
      Improvement") for this product. No retrieval involved.
      File: lib/actions/ai.ts
   b) Fuzzy lexical search (Fuse.js, local, no network) scoped to ONLY
      that department's subtree (getSubtreeCategories()) → up to 8
      candidates. If that comes up empty, retry with the department
      pick's next-best alternate before giving up.
      File: lib/jumia/category-search.ts → searchCategoriesByText(),
      getTopLevelDepartments(), getSubtreeCategories()
   c) Absolute last resort: fuzzy search the FULL ~27k-row catalog (only
      reached if department picking itself threw). If even that finds
      nothing, the analyze returns ok:false/no_category_picked rather
      than guessing — the listing keeps no category and the seller picks
      one manually via the category drawer / focused editor.
   Replaced the old 3-source retrieval (fuzzy + pgvector embedding +
   Jumia catalog API search, merged, with a "grab the first 200
   categories alphabetically" fallback when all three came up empty).
   That fallback is how a safety helmet and a canvas easel both got
   filed under "Laptops" in production — a blind alphabetical slice of
   the whole catalog has nothing to do with the actual product. The two
   external retrieval sources (Google's embedding endpoint, Jumia's
   catalog search) were also the confirmed source of 4s/6s timeouts
   stacking up toward Vercel's 60s ceiling; department-scoped fuzzy
   search needs neither, so both are gone from this path entirely.
   searchCategoriesByEmbedding() and searchJumiaProductsByTitle() still
   exist (unused by this pipeline now) in case something else needs them.

3. Combined Pass B+C (vision): one Gemini call that picks the category
   AND fills its attributes. Replaces what used to be two serial calls.
   File: lib/actions/ai.ts → aiPassBC_pickAndFill()
   Pre-fetches schemas for top-3 candidates in parallel.
   Safety fallback: if combined returns ok:false, falls back to separate
   aiPassB_rankCategory + extractAttributesForCategory.

4. Post-hoc enrichment (in the route, after Pass C):
   a) Schema-aware default-fill — resolves intent names (product_note,
      what_is_in_the_box, from_the_manufacturer) to the category's actual
      schema attribute names via keyword patterns.
   b) Pattern-based defaults — for required attrs the AI left empty,
      match name/label against AI_DYNAMIC_ATTR_PATTERN_DEFAULTS (in
      lib/ai/policy.ts) and pick best-fit value from allowed_values.
      Covers skin_type / season / gender / size / style / etc.
   c) Numeric scrub — for any attr typed `number` in schema, ensure value
      is actually numeric. Skips text-named attrs (description,
      what_is_in_the_box, manufacturer_txt) via allowlist + prose
      heuristic (value contains letters AND spaces).
   d) Gap-fill AI pass — if any required attr is STILL empty, focused
      Gemini call to fill them with confident defaults. Includes Google
      Custom Search snippets when GOOGLE_CSE_ID is set (Tier 1.1).
      File: lib/actions/ai.ts → aiFillGaps()
   e) Description auto-expand — if description < 150 chars and seller
      hasn't edited, focused Gemini text call rewrites to 150-400 words.
      File: lib/actions/ai.ts → aiExpandDescription()
```

**Category-detection hardening (2026-09-13)**, on top of the department-first
pipeline above:
- **Catalog freshness check**: `/api/cron/check-category-freshness` (daily,
  00:15 UTC) compares our cached `jumia_categories` row count against a
  live re-fetch and records the result in `jumia_category_sync_health`
  (single row) — surfaced as a warning banner on `/admin/categories`.
  Sync itself is still admin-triggered; this only flags drift so it's
  never silently unbounded. Needs the first `ADMIN_USER_IDS` account to
  have an active Jumia connection (uses its token for the read-only
  catalog call).
- **One-action correction**: picking a category (drawer, focused editor,
  or a WhatsApp alternate-category button) now always runs the AI refill
  immediately instead of requiring a separate "Fill with AI" click.
  Shared logic: `lib/jumia/refill-attributes.ts` → `refillAttributesForCategory()`,
  used by both `/api/listings/[id]/refill-attributes` and
  `lib/whatsapp/intake.ts`'s `handleCategoryCorrection()`.
- **WhatsApp confidence surfacing**: when `runAutoAnalyze` returns
  `needsUserConfirmation`, `startBatchAnalysis` sends a dedicated
  reply-buttons message with up to 3 alternate categories
  (id `category:<listingId>:<code>`) right in chat — previously this only
  showed on the web review page's `AIConfidenceBanner`, which a
  WhatsApp-only seller would never see.

**Total cost**: ~$0.003 (happy path) to ~$0.007 (with web search + expand).
**Total wall clock**: ~10-20s warm cache, ~25-35s cold start.
**Vercel timeout**: 60s (`export const maxDuration = 60` in route).

### Listing creation flow (UI side)

```
1. /listings/new (mode picker) — only "own images" mode is ACTIVE.
   Rebuild + text-to-image cards are visible but disabled with
   "Maintenance" badges. (Disabled May 2026 pending image model upgrade.)

2. /listings/new/batch?count=N&mode=own — multi-product upload.
   Parallelized with concurrency cap of 3 — see batch/page.tsx.
   Pre-allocates listingIds array to preserve seller's tab order.
   Auto-retries failed analyze once with 1s backoff.
   Listings whose analyze fails after retry are passed to review page
   via ?retry=id1,id2 for a future banner.

3. /listings/[id]/review — the seller verifies + edits + submits.
   Rich-text editor: components/jumia/RichTextField.tsx
   IMPORTANT: useEditor uses `[]` deps array to prevent Tiptap v3 from
   recreating the editor on every parent render. onChange + initial
   content are held in refs.

4. POST /api/jumia/push — pushes to Jumia Vendor Center.
   Token refresh handled by getValidJumiaCredentials().
   SKU duplicate-collision retry appends -RXXXX suffix.
```

---

## File map (critical paths)

### Routes (app/)
- `app/api/listings/[id]/auto-analyze/route.ts` — THE main AI pipeline (~850 lines)
- `app/api/listings/[id]/resolve-rejection/route.ts` — "Resolve with AI" button handler
- `app/api/jumia/push/route.ts` — sends listing to Jumia
- `app/api/jumia/callback/route.ts` — OAuth callback (PUBLIC route)
- `app/api/paystack/initialize/route.ts` — redirects to Payment Page
- `app/api/paystack/verify/route.ts` — confirms payment via Paystack API
- `app/api/paystack/webhook/route.ts` — async webhook handler (PUBLIC, HMAC verified)
- `app/api/webhooks/clerk/route.ts` — Clerk user sync (svix verified)
- `app/api/admin/embed-categories/route.ts` — backfill pgvector embeddings (admin only)
- `app/api/generate-product-image/route.ts` — Imagen 3 text-to-image (Business tier)
- `app/api/enhance-images/route.ts` — Gemini image rebuild (legacy, currently maintenance)
- `app/api/polish-images/route.ts` — PhotoRoom polish (legacy)
- `app/(main)/listings/new/page.tsx` — mode picker UI
- `app/(main)/listings/new/batch/page.tsx` — multi-product upload (parallel worker pool)
- `app/(main)/listings/[id]/review/review-client.tsx` — review form (~3000 lines, the biggest file)
- `app/sign-up/[[...sign-up]]/page.tsx` — Clerk hosted SignUp
- `app/sign-in/[[...sign-in]]/page.tsx` — Clerk hosted SignIn
- `app/terms/page.tsx`, `app/privacy/page.tsx` — legal pages (need lawyer review)
- `app/robots.ts`, `app/sitemap.ts` — SEO
- `app/layout.tsx` — root metadata, JSON-LD, Clerk provider

### Library code (lib/)
- `lib/actions/ai.ts` — ALL Gemini calls (~2100 lines). Read this first if changing AI behaviour.
- `lib/ai/policy.ts` — AI defaults map (AI_DYNAMIC_ATTR_DEFAULTS) + AI_DYNAMIC_ATTR_PATTERN_DEFAULTS
- `lib/ai/jumia-content-policy.ts` — the prose policy block prepended to every Gemini prompt
- `lib/ai/restricted-words.ts` — banned-word list scraped from Jumia GH guides
- `lib/ai/embeddings.ts` — embedding API client with fallback chain
- `lib/ai/web-search.ts` — Google Custom Search wrapper (added 2026-05-28)
- `lib/billing/plans.ts` — single source of truth for tier prices + quotas + Paystack page URLs
- `lib/billing/quota.ts` — checkQuota / incrementUsage / getEffectivePlan
- `lib/billing/ai-models.ts` — tier → Gemini model mapping (pickModelForPlan)
- `lib/jumia/categories.ts` — category schema fetch + cache
- `lib/jumia/category-search.ts` — fuzzy search + department-tree helpers (getTopLevelDepartments/getSubtreeCategories); embedding/Jumia-catalog search functions still live here but are unused by the analyze pipeline as of 2026-09-13
- `lib/jumia/api.ts` — Jumia Vendor Center API client + OAuth token refresh
- `lib/actions/listings.ts` — createListing / updateListing server actions (quota-gated)
- `lib/actions/upload.ts` — image upload with magic-byte MIME validation (JPEG/PNG only)
- `lib/rate-limit.ts` — in-memory sliding-window rate limiter per Clerk userId
- `lib/supabase/server.ts` — service-role client (server-only)
- `middleware.ts` — Clerk middleware with public-route allowlist

### Components (components/)
- `components/jumia/RichTextField.tsx` — Tiptap editor (read for the empty-deps `useEditor` fix)
- `components/jumia/SchemaField.tsx` — dynamic_attributes form renderer
- `components/marketing/public-landing.tsx` — landing page

### Supabase migrations (supabase/migrations/)
Run in order. All applied through Supabase Dashboard → SQL Editor (NOT auto-applied):
- `2026-05-21_plan_quotas.sql` — subscriptions / quota tracking
- `2026-05-26_category-embeddings.sql` — pgvector(768) column + ivfflat index + search RPC
- `2026-05-26_listing-user-prompt.sql` — listings.user_prompt column (persists "what do you want in the listing" hint)
- `2026-09-13_category-sync-health.sql` — single-row `jumia_category_sync_health` table for the nightly catalog freshness check

---

## Environment variables (24 referenced — all from process.env.*)

### Required for any deploy
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` — Clerk (`pk_live_...` in prod)
- `CLERK_SECRET_KEY` — Clerk (`sk_live_...` in prod)
- `CLERK_WEBHOOK_SECRET` — from Clerk → Webhooks (`whsec_...`)
- `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` + `SUPABASE_SERVICE_ROLE_KEY`
- `GOOGLE_API_KEY` — single key for Gemini + Imagen + embeddings + Custom Search
- `GOOGLE_CSE_ID` — Programmable Search Engine ID (set 2026-05-28 to `05213a7d53c7a498e`)
- `JUMIA_CLIENT_ID` + `JUMIA_CLIENT_SECRET` + `JUMIA_REDIRECT_URI` + `JUMIA_API_ENV` (`sandbox` | `production`)
- `NEXT_PUBLIC_APP_URL` — `https://pandaworldai.site` in prod
- `ADMIN_USER_IDS` — comma-separated Clerk userIds with admin bypass
- `CRON_SECRET` — random string for `/api/cron/*` bearer auth

### Optional
- `PAYSTACK_SECRET_KEY` — only needed for `/verify` and `/webhook` (initialize uses Page URLs)
- `PAYSTACK_STARTER_PAGE_URL`, `PAYSTACK_PRO_PAGE_URL`, `PAYSTACK_BUSINESS_PAGE_URL` — 3 Paystack-hosted Payment Pages, currency MUST be GHS
- `PHOTOROOM_API_KEY` — legacy image polish (currently maintenance mode)
- `RESEND_API_KEY` + `EMAIL_FROM` — transactional email
- `USE_MOCK_AI=true` — local-dev shortcut (returns stub AI responses). Must be unset in prod.
- `QUALITY_SCORE_MIN` + `NEXT_PUBLIC_QUALITY_THRESHOLD` — submit gate threshold
- `SCRAPER_API_KEY` / `SCRAPINGBEE_KEY` / `ZENROWS_KEY` — URL-import scrapers (legacy)
- `VERCEL_URL` — auto-set by Vercel (used as fallback for redirects when NEXT_PUBLIC_APP_URL is missing)

---

## Operational gotchas (things that have bitten us)

1. **Embedding cold start** (historical): `gemini-embedding-001` regularly took
   30–40s on a cold call when the analyze pipeline used it for category
   retrieval. As of 2026-09-13 the pipeline no longer calls it at all — see
   the category-resolution rewrite above — so this class of timeout is gone
   from `runAutoAnalyze`. `lib/ai/embeddings.ts` and
   `searchCategoriesByEmbedding()` still exist for any other caller.

2. **Supabase image transforms require Pro plan**: the user's project is on Free
   tier, so `/storage/v1/render/image/` returns 403. Code falls back to
   `/storage/v1/object/` after first 403 (process-level flag). See
   `lib/actions/ai.ts` → `_resizeDisabled`. If they upgrade Supabase, this
   automatically kicks in and gives ~2× faster Gemini inference.

3. **Vercel function timeout**: routes default to 10s (Hobby) / 60s (Pro).
   Explicit `export const maxDuration = 60` on long-running routes
   (auto-analyze, generate-product-image, embed-categories).

4. **Supabase migrations never auto-apply** — copy/paste into SQL Editor manually
   for every new file in `supabase/migrations/`.

5. **Vercel env-var changes need manual redeploy** — code pushes auto-deploy,
   env changes do NOT. After updating an env var: Deployments → top → ⋯ → Redeploy.

6. **Clerk userId differs between dev and prod instances**. After flipping to
   production keys, the user's dev userId is invalid. They must sign up a fresh
   admin account on prod and update `ADMIN_USER_IDS`.

7. **Tiptap v3 useEditor**: must use `[]` deps array OR pass options through refs
   to avoid infinite remount loop. See `components/jumia/RichTextField.tsx`.

8. **Description column can be misnamed in Jumia schema**: some categories type
   `description` as `number`. Server-side scrub now has both an allowlist
   (description, manufacturer_txt, etc.) and a prose heuristic to skip scrub
   when value contains both letters and whitespace.

9. **"Search the entire web" deprecated** in Google's Programmable Search
   Engine for new instances. PandaWorld uses ~35 curated spec sites instead
   (Amazon, Wikipedia, GSMArena, Jumia, etc.). Add more domains as needed
   in the CSE control panel (50-domain cap).

10. **JPEG/PNG ONLY for Jumia push**. WebP gets rejected at push time. Block
    happens at upload — see `lib/actions/upload.ts` `ALLOWED_MIMES`.

---

## Recent commit history (most impactful first)

Read these commit messages for context on architectural decisions:
- `c38bb1f` feat(ai): wire Google Custom Search as gap-fill ground-truth (Tier 1.1)
- `7c32d4b` fix(ai): tighter embedding timeout (4s) + process-level circuit breaker
- `87af25a` fix(ai): per-source timeouts on retrieval — prevents 60s Vercel function timeouts
- `a6ff21c` fix(ai): three log-diagnosed bugs — description dropped, slow embedding, wasted resize fetches
- `5269feb` fix(ai): What's-in-the-Box uses Jumia's multi-line '1x Item' format + repairs legacy junk
- `5bb91e4` feat(ai): Phase 1+2+3 — universal defaults, gap-fill pass, description expand
- `8378e88` fix(ui): stop Tiptap editor infinite remount loop on review page
- `38c1257` fix(ai): five fixes — Note/Box appear, capacity_liter numeric, highlights line-by-line, WebP blocked, Resolve-with-AI schema-aware
- `34140e5` perf(ai): collapse Pass B + Pass C into one Gemini call (the big speed win)
- `babfdb3` perf(ai): resize images at Supabase CDN edge + diagnostics for slow analyze
- `89d3fd5` feat(ai): richer policy + parallel batch upload (Win A)
- `39eb225` copy(billing): refresh plan feature bullets to launch-ready wording

`git log --oneline -50` for the full picture.

---

## Outstanding work / known gaps

Listed by priority. Pick from here when looking for "what to do next".

### Pre-launch blockers
1. **Lawyer review** of `app/terms/page.tsx` + `app/privacy/page.tsx`. Both are
   substantive (not lorem) but marked as drafts needing sign-off.
2. **Production smoke tests** — 7 paths to walk through on the live URL after
   Clerk prod keys land. Listed in the launch audit (sign-up → onboarding →
   Jumia connect → free listing → submit; payment → tier upgrade → quota tightens;
   etc.).
3. **Verify Paystack MoMo** — long-pending. Confirm Ghana entity + KYC + GHS plans +
   Live mode.

### Reliability / polish (post-launch, low risk)
4. **Quota check at /api/process-listing entry** — currently quota is checked
   inside createListing() after scrape/analyze. Quota-blocked users waste API
   credits before the gate fires. ~20 min fix.
5. **Surface `?retry=id1,id2` banner** on review page so seller knows which
   batch products need a manual re-run.
6. **Add BreadcrumbList JSON-LD** to /pricing and /landing for richer Google
   knowledge cards.

### Cost / speed (optional)
7. **Install sharp + resize images server-side** as alternative to Supabase
   transforms (so the Free-plan-Supabase user doesn't pay full-res Gemini cost).
   Sharp is heavy binary — consider only if SaaS scales past 1000 active sellers.
8. **Migrate from AI Studio API key to Vertex AI** — same models, higher rate
   limits (cures the embedding cold-start), Cloud Billing integration.
   ~6 hours. Wait until either (a) error rate stays high after current fixes, or
   (b) crossing ~500 paid users.

### Feature expansion (when relevant)
9. **Cloud Vision OCR** (Tier 1.2 of GCP plan) — dedicated OCR for packaging text.
   $1.50/1000 images, first 1000 free monthly. Improves spec-text accuracy.
   ~4 hours.
10. **Cloud Translation API** — when expanding to French Jumia markets.
11. **Firebase Cloud Messaging** — push notifications on Jumia approve/reject.
12. **BigQuery + Looker Studio** — analytics pipeline. Pipe Supabase → BigQuery.

### Marketing
13. **Google Business Profile** — full content drafted in
    `/Users/macbell/.claude/plans/reflective-jumping-hummingbird.md`
    (archived section). Paste into business.google.com when ready.

---

## Communication style with this user

- **Concise + direct**. He prefers short responses with file paths and exact commands over verbose explanations.
- **Specific, not abstract.** "Update line 84 of `lib/actions/listings.ts`" beats "update the quota check."
- **Real numbers**. "~$0.003 per analyze" beats "low cost". Use Vercel logs to ground claims.
- **Verify after shipping** — he reads Vercel logs religiously. Always tell him the exact log line to look for.
- **Don't ask permission for trivia.** "I'll add the import" not "may I add the import?". Do ask for direction on ambiguous architectural choices.
- **Show traffic-light status** (✅ / ⚠️ / ❌) for multi-item reports. He scans these fast.
- **He'll paste Vercel logs / screenshots** — use them as authoritative. Decode the timestamps and per-pass metrics into actionable diagnoses.
- **Push back when needed**. He's already had me revert several "I added X" overcorrections. Better to push back ("this is bigger than it looks because Y") than ship a fragile fix.
- **One commit per logical change** with a 5-10 line commit message body explaining WHY.

---

## How to get up to speed in 30 minutes

If you're a new AI tool inheriting this project:

1. Read this file (~10 min).
2. Run `git log --oneline -30` to see recent shipping rhythm.
3. Read `app/api/listings/[id]/auto-analyze/route.ts` end-to-end (~10 min) — that's the heart of the product.
4. Skim `lib/actions/ai.ts` for Gemini call patterns (~5 min).
5. `npx tsc --noEmit` should pass (5s).
6. Ask the user one question to confirm what they want next.

That gets you to "able to make a useful change" within an hour.
