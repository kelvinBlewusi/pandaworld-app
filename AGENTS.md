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

**Pricing**: pay-as-you-go credits, no subscription (the monthly plans were
removed 2026-09-28). 20 free credits on sign-up; a WhatsApp/web listing costs
2 credits, charged only when Jumia accepts it; an extension autofill costs 1.
1 credit = GHS 0.35, so a live listing is GHS 0.70; packs 100/210/440/940
credits for GHS 35/70/140/280, all in `lib/billing/credit-packs.ts`. Billing
was switched on at `/admin/billing` on 2026-10-01 — see "Billing" below.

**Founder/operator**: Kelvin (single-person operation). Communication style is
concise, direct, file-path-specific. Prefers small focused commits over big
refactors. Hates Lorem-ipsum-style placeholder code.

---

## Tech stack

- **Framework**: Next.js 14 (App Router) on Vercel
- **Auth**: Clerk (production instance live at `pandaworldai.site`, see DNS records under `clerk.pandaworldai.site` etc.)
- **Database**: Supabase Postgres + pgvector extension + Supabase Storage
- **Payments**: Paystack transaction/initialize for one-time credit packs (`app/api/extension/credits/checkout`)
- **AI**: Google AI Studio API key (`GOOGLE_API_KEY`) for:
  - Gemini 3.1 Flash Lite (vision + text) — listing analyze, gap-fill, description-expand
  - Gemini 2.5 Flash Image — text-to-image + image polish/rebuild
  - text-embedding — **Vertex `text-embedding-005`** whenever `GCP_PROJECT_ID` +
    `GOOGLE_APPLICATION_CREDENTIALS_JSON` are set (they are, in production);
    AI Studio's `gemini-embedding-001` only as the no-Vertex fallback. Which
    model wrote a given category vector is recorded in
    `jumia_categories.embedding_model` — see "Embedding model drift" below for
    why that column exists and why it is not optional.
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
      that department's subtree (getSubtreeCategories()), MERGED with a
      timeout-bounded pgvector embedding search scoped to the same
      subtree (as of 2026-09-13 — see "Retrieval upgrade" below) → up to
      8 candidates. If that comes up empty, retry with the department
      pick's next-best alternate before giving up.
      The query is searched TERM BY TERM, IDF-weighted, never as one
      string — see "Fuzzy retrieval was silently broken" below. This is
      load-bearing, not a refinement.
      File: lib/jumia/category-search.ts → searchCategoriesByText(),
      searchCategoriesByEmbedding(), getTopLevelDepartments(),
      getSubtreeCategories(), mergeCandidates()
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
   the whole catalog has nothing to do with the actual product. Jumia's
   own catalog search API is still gone from this path entirely
   (searchJumiaProductsByTitle() is unused, kept in case something else
   needs it) — it was one of the two confirmed sources of 4s/6s timeouts
   stacking toward Vercel's 60s ceiling. The embedding endpoint, the
   other confirmed source, is back (see below) but now bounded so it
   can't reintroduce that risk.

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
- **Seller-notes fidelity**: the describe-pass prompt now treats an
  explicit seller-stated variant list ("comes in red, blue and green")
  as authoritative, using it verbatim instead of requiring the images to
  visually confirm every option. `extractAttributesForCategory`'s prompt
  gained the same "what's in the box" guidance the combined pass already
  had. `extractSalePrice()` (`lib/whatsapp/batch.ts`) deterministically
  parses "sale price 120 from 20 September to 30 September" style text
  in chat (same never-AI-guessed rule as price/stock), wired into
  `applyNotes()`/`handleEdit()` in `lib/whatsapp/intake.ts`, and persisted
  to `listings.sale_price`/`sale_start_date`/`sale_end_date` — the
  listing-level fallback every variant's own sale price resolves to when
  unset (`mapListingToJumiaProducts` in `lib/jumia/api.ts`), so a sale
  price stated once applies no matter the variant, and even a
  zero-variant listing (the common WhatsApp case, before any variant row
  exists) can carry one via `buildBaseProduct`.
- **Retrieval upgrade**: `searchCategoriesByEmbedding()` is back in the
  live pipeline (merged with fuzzy hits via `mergeCandidates()`) to catch
  vocabulary mismatches fuzzy search misses (e.g. "wireless earbuds" vs.
  a category literally named "In-Ear Headphones"). Two guards keep this
  from reopening the exact problem that got it dropped in the first
  place (see the "Embedding cold start" gotcha below): (a) it's scoped
  to the SAME department subtree the fuzzy search already narrowed to,
  via a new `dept_path` parameter on the `search_categories_by_embedding`
  RPC (`supabase/migrations/2026-09-13_category-embedding-department-
  scope.sql`) — a semantic hit can add to the trusted pool but never
  smuggle in a wrong-department candidate; (b) it races against a 4s
  internal timeout (`EMBEDDING_SEARCH_TIMEOUT_MS` in
  `lib/jumia/category-search.ts`) and degrades to `[]` on a miss, same
  as any other retrieval failure here. Embeddings are only ever useful
  for categories that HAVE one, so backfilling stopped being purely
  admin-manual too: `/api/cron/embed-categories` (daily, 00:20 UTC, 5
  min after the freshness check) runs the same idempotent batch
  `/api/admin/embed-categories` always did — extracted to
  `lib/jumia/embed-categories.ts` so both share it — looping batches
  within one invocation until either done or a 50s soft deadline.
- **WhatsApp credits** (superseded 2026-09-28 by pay-when-live, see
  "Billing" below): a WhatsApp listing is charged `LIVE_LISTING_CREDIT_COST`
  (2) credits when it goes live, from the SAME ledger the Chrome
  extension's autofill spends `LISTING_CREDIT_COST` (1.5) from — see `lib/billing/extension-
  credits.ts`. `startBatchAnalysis` (`lib/whatsapp/intake.ts`) reserves
  affordability for the whole batch up front (same pattern as its
  existing rate-limit reservation), splitting listings the seller can't
  afford into their own "top up" message with a link to
  `/extension/dashboard`, and deducts per-listing only after that
  listing's draft actually succeeds. Pack sizes increased 2026-09-13
  (100/280/600 → 150/330/650 credits, same GHS 20/50/100 prices), then
  repriced 2026-09-28 to 120/200/400 credits for GHS 30/50/100 —
  `getCreditPackByCredits()` keeps a small legacy-amount alias so a
  purchase transaction recorded before the change still resolves to its
  pack for the dashboard's "Plan" pill. WhatsApp's pre-existing
  plan-quota gate (`checkQuota`/`incrementUsage`) is untouched — both
  systems currently run side by side.
- **Batch analysis runs on a queue (2026-09-13)**: `startBatchAnalysis` no
  longer analyses anything. It reserves quota + credits, tells the seller
  what it can't draft, enqueues one `analysis_jobs` row per product and
  returns — so the webhook finishes in well under a second whatever the
  batch size. `app/api/worker/analyze-jobs` drains the queue `CLAIM_LIMIT`
  (3) products per tick, chaining into itself while work remains, with
  pg_cron as the guaranteed trigger.
  - **Scheduling lives in Postgres, not `vercel.json`** — Hobby caps
    Vercel cron at once a DAY. `supabase/schedule-workers.sql` is a
    run-once-by-hand file (it needs the real `CRON_SECRET`, kept in
    Supabase Vault rather than inlined, since `cron.job.command` is
    readable by any DB user). It schedules both the worker and
    `/api/cron/jumia-feeds` every minute.
  - **The jobs only call Vercel when there is work (2026-09-28)**:
    `supabase/migrations/2026-09-28_cron-only-when-there-is-work.sql`.
    The Hobby plan includes 4 hours of Active CPU a month, and ~6,000
    mostly-idle cron calls a day used all of it. Each job now checks
    Postgres first: the worker runs only for queued/stale jobs or an
    unclosed settled batch (one worker per 2 jobs, max 3); the feed poll
    only while a feed is pending (every minute for its first 30 minutes,
    then every 10); the Jumia keepalive only when a Self Authorization
    connection is within 6 hours of expiring; the health check hourly.
    Adding a cron job or changing what a route looks for: keep its SQL
    check in step, or the route never gets called for the new work.
    Since 2026-09-29 the worker and feed-poll checks run as ONE job,
    'minute-workers' (`supabase/migrations/2026-09-29_one-every-minute-
    cron-job.sql`): pg_cron logs two lines per run that can't be switched
    off, and they were most of Supabase's metered log ingest. Prefer
    adding to that job over scheduling another every-minute one.
  - **Two safety properties worth not breaking**: `claim_analysis_jobs`
    uses `FOR UPDATE SKIP LOCKED`, so overlapping ticks (pg_cron + the
    webhook's own nudge) take disjoint work instead of double-analysing
    and double-billing a product; and `claimBatchFinalization` flips the
    session out of "analyzing" as a conditional UPDATE, so exactly one
    worker sends the "🎉 Done drafting!" close-out even when two finish
    the last two jobs at once.
  - `MAX_BATCH_SIZE` went back to 20 as a result. What binds now is the
    shared Gemini/Vertex project quota (still unmeasured) and seller
    patience, not a per-request ceiling. On 2026-10-03 the owner set it
    to 10 for sellers; admins (`isAdmin`) keep `ADMIN_MAX_BATCH_SIZE`, 20
    (handleAwaitingCount passes the cap to `readProductCount`).
- **Batch cap history (2026-09-13)**: `MAX_BATCH_SIZE`
  (`lib/whatsapp/batch.ts`) dropped 20 → 5 before the queue existed. `startBatchAnalysis` runs every
  product's analysis concurrently inside the WhatsApp webhook, which Vercel
  kills at 60s; a single product measured 22.7s in production, already half
  `ANALYSIS_DEADLINE_MS`. At 20 that meant 60-80 concurrent Gemini vision
  calls and up to 160 images in the shared in-process cache from one
  instance. The `>= 10` "big batch" thresholds became `BIG_BATCH_SIZE` (3, back to 10 on 2026-09-29)
  since a literal 10 was unreachable under the new cap. Raising the cap
  again needs the analysis moved off the request path onto a background
  worker — changing the number alone just moves the failure.
- **Pending listings looked stuck forever (fixed 2026-09-13)**: the only
  thing that flipped `pending_approval` → `live`/`failed` was
  `/api/cron/jumia-feeds`, scheduled `0 0 * * *` because Hobby caps cron at
  once a day, while Jumia usually finishes in minutes. The route's own
  comment still says "runs every 5 minutes" — it doesn't. Sellers saw
  "Pending" for up to 24h. `refreshPendingFeedStatus` now runs on the
  `/extension/whatsapp-listings` page load too (5s bounded, best-effort —
  stale statuses render rather than blocking the page).
  **The subtlety worth keeping**: whichever path observes the transition
  CONSUMES it, because the row stops being `pending_approval` and the cron
  never looks again. So `refreshPendingFeedStatus` notifies over WhatsApp
  itself (`notifyListingResolved`) in the same words the cron uses. Any new
  caller that resolves a pending listing must go through it, or it silently
  swallows the seller's "it's live" message.
- **Fuzzy retrieval was silently broken (fixed 2026-09-13)**: Fuse's bitap
  matcher caps a search pattern at 32 characters (`MAX_BITS` in
  `fuse.cjs`) and splits anything longer into arbitrary mid-word 32-char
  chunks that each have to match. `retrievalQuery` is title + keywords +
  use case + environment — essentially always past that cap — so
  `searchCategoriesByText()` was being handed a pattern it could not
  match. Measured against the real catalog for a canvas wall-art print:
  `"canvas art"` (10 chars) returned Pre-Stretched Canvas 0.41 / Boards &
  Canvas 0.35 / Wall Art 0.33, while `"canvas art wall decor"` (21) and
  the real ~107-char query returned **nothing at all**. Retrieval then
  fell through to the full-catalog retry (same broken long query) and the
  vision model was handed whatever noise surfaced — which is how a canvas
  print was pushed to Jumia as "Icing & Decorating Spatulas" at 0.95
  confidence. The earlier "safety helmet / canvas easel filed under
  Laptops" incidents share this root cause; the alphabetical-fallback
  removal treated the symptom.
  Fix: search each term separately (so no pattern nears 32 chars) and
  score a category by the IDF-weighted mean of its per-term relevances.
  IDF matters as much as the split — a real query carries a few
  discriminating words among a lot of filler that matches half the
  department, and unweighted terms let "decor"/"supplies"/"kits" outvote
  "canvas". A cheap 4-char-prefix substring prefilter runs first so Fuse
  only scores rows that could plausibly match (33ms for a department
  subtree, 112ms for the full catalog; without it, 12 terms over 27k rows
  blocked the event loop for ~5s).
- **"None of these fit" (2026-09-13)**: `aiPassBC_pickAndFill`'s prompt
  used to require `chosen_code` to be one of the candidates, so a bad
  candidate set could only ever produce a confidently wrong answer — and
  its confidence meant "best of these three", not "actually fits this
  product", which is why 0.95 sailed past `needsUserConfirmation`
  (`top1 < 0.75 || top1 - top2 < 0.15`). It may now return
  `chosen_code: null`, surfaced as `noCandidateFits`, and the confidence
  rule now explicitly asks how well the category fits the product.
  `runAutoAnalyze` routes that to `no_category_picked` (seller picks
  manually) rather than the separate-passes fallback, which would just
  force the same bad pick from the same candidates.
  Both "no category" exits now go through `bailToManualCategory()`, which
  persists Pass A's title/description/highlights on the way out (honouring
  seller edits). Before, an early return saved nothing — so a seller who
  had already been charged for the draft got a listing holding nothing but
  its images.
- **One content style everywhere**: `aiPassA_describeProduct()` and
  `aiExpandDescription()` (both in `lib/actions/ai.ts` — the shared entry
  points for every WhatsApp-drafted and web-uploaded listing) now pull
  their Description/Highlights writing-style rules from the same
  `lib/ai/content-style-rules.ts` the Chrome extension's fill prompt has
  always used, via two new exports (`buildDescriptionAndHighlightsStyleBlock`,
  `buildDescriptionStyleBlock` — the latter excludes Highlights for
  `aiExpandDescription`, which only ever rewrites Description). Previously
  these two entry points carried their own, much thinner inline rules (no
  length floor beyond Jumia's bare 50-char minimum, no structural
  guidance) — a listing drafted via WhatsApp or the web upload flow read
  noticeably plainer than one autofilled by the extension. Still edit
  `content-style-rules.ts` when tuning the actual rules, not either call
  site — see that file's own doc comment.

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
- `app/api/extension/credits/checkout/route.ts` / `verify/route.ts` — credit-pack purchase
- `app/api/paystack/webhook/route.ts` — credits packs + records donations (PUBLIC, HMAC verified)
- `app/api/webhooks/clerk/route.ts` — Clerk user sync (svix verified)
- `app/api/admin/embed-categories/route.ts` — backfill pgvector embeddings (admin only)
- `app/api/generate-product-image/route.ts` — Imagen 3 text-to-image (IMAGE_CREDIT_COST credits)
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
- `lib/billing/credit-packs.ts` — every price: packs, free credits, cost per autofill / draft / photo
- `lib/billing/extension-credits.ts` — the credit ledger (balance, deduct, purchase, top-up)
- `lib/billing/mode.ts` — the billing switch (app_settings.billing_enabled)
- `lib/ai/usage.ts` + `lib/billing/costs.ts` — per-call AI cost log and its per-run summary
- `lib/billing/ai-models.ts` — which Gemini model each kind of call uses (one per kind, no tiers)
- `lib/jumia/categories.ts` — category schema fetch + cache
- `lib/jumia/category-search.ts` — fuzzy + timeout-bounded embedding search, merged, department-scoped (getTopLevelDepartments/getSubtreeCategories/mergeCandidates); Jumia-catalog search function still lives here but is unused by the analyze pipeline as of 2026-09-13
- `lib/jumia/embed-categories.ts` — idempotent embedding-backfill batch, shared by the admin route and the daily cron
- `lib/jumia/api.ts` — Jumia Vendor Center API client + OAuth token refresh
- `lib/actions/listings.ts` — createListing / updateListing server actions
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
- `2026-09-13_listing-sale-price.sql` — `listings.sale_price`/`sale_start_date`/`sale_end_date`, the fallback every variant's own sale price resolves to when unset (see below)
- `2026-09-13_category-embedding-department-scope.sql` — adds a `dept_path` parameter to `search_categories_by_embedding()` so semantic search can be scoped to one department subtree (see "Retrieval upgrade" below)
- `2026-09-13_donations.sql` — `donations` table (userId, amountGhs, reference, created_at) for the temporary "Donate" flow (see below)

---

## Jumia connection: Self Authorization (2026-09-28)

Jumia issues refresh tokens ONLY to "Self Authorization" applications
(vendorcenter.jumia.com/api-docs, Step-by-Step Authentication). "Web
Application" apps — what sellers were told to create until 2026-09-28 —
never get one, so every connection died ~24 h after each login (all 16
rows had refresh_token null).

- New default: the seller creates a Self Authorization app, clicks
  Generate Token, and pastes Client ID + token on /onboarding/connect or
  into the WhatsApp chat (a JWT second half = Self Authorization).
  `connectSelfAuthorization` (lib/jumia/self-auth.ts) exchanges it with
  grant_type=refresh_token, client_id, NO client_secret, and saves
  auth_type='self'.
- Jumia rotates the refresh token on every exchange and it expires
  (refresh_expires_in, ~1 day in Jumia's example). pg_cron job
  `jumia-keepalive` (every 30 min) → /api/worker/jumia-keepalive →
  lib/jumia/keepalive.ts renews any self connection within 6 h of either
  expiry, through refreshJumiaConnection (lock + rotation +
  refresh_token_expires_at).
- Web Application connections still work (auth_type='web') but expire
  daily; the Jumia card, /onboarding/connect?reason=disconnected and the
  WhatsApp prompt offer the one-time switch. getJumiaConnectionKind:
  needs_reconnect = expired web app, needs_new_token = self token refused.

## Public SEO pages (2026-09-28)

Indexable, public in middleware.ts, listed in app/sitemap.ts, and linked
from every marketing footer:
- `/how-to` + `/how-to/<slug>` — one page per guide (lib/marketing/guides.ts).
- `/jumia-price-calculator`, `/jumia-commission-rates` — Ghana, from the
  rate table in lib/mock/categories.ts.
- `/sell-on-jumia` + `/sell-on-jumia/<country>` — all 8 Jumia markets (GH,
  NG, KE, EG, MA, CI, SN, UG) with a local-currency calculator. Fee facts
  in lib/marketing/countries.ts are only what each country's VendorHub
  states plainly, each page links its source; don't add per-category rates
  for a country without an official table.
- One listing-price formula for all calculators: listingPriceFor in
  lib/marketing/jumia-fees.ts (rounds up without float drift).
- Every country page has a category-aware calculator and rate table
  (2026-10-01): `lib/marketing/country-fees.ts` holds each market's 2026
  commission table from its VendorHub (mostly images, read off them), with
  the per-item fee by category (GH, MA, SN, UG), by size (NG, EG; Egypt
  has a 10 EGP minimum commission on drop shipping) or typed in (KE, CI,
  no published table). Ghana's rows come from lib/mock/categories. The
  VendorHub sites block plain fetches (Cloudflare); Chromium through the
  proxy works once the proxy CA is in /root/.pki/nssdb.
- The nav and footer calculator link is `/calculator` (CALCULATOR_HREF, a
  redirect, so not in the sitemap): app/calculator/route.ts redirects to
  the seller's own country, from their Jumia connection, else Vercel's
  `x-vercel-ip-country`, else Ghana (calculatorPathFor). It's a plain `<a>`
  because next/link would prefetch it and drop the `#calculator` fragment.
  Ghana's page is GHANA_CALCULATOR_HREF. The in-app calculators
  (/price-calculator, /extension/calculator) pick the same country and
  switch with `?country=`. Every calculator lists the other countries under it.

## Billing (2026-09-28)

Credits are the only billing. The monthly plans (Free/Starter/Pro/Business,
`lib/billing/plans.ts` + `quota.ts`, the reset-quotas cron, Paystack Payment
Pages) were deleted 2026-09-28; nobody was on a paid plan. The
`subscriptions` and `billing_events` tables are left in the database,
unused.

**The switch.** `/admin/billing` has one button, stored in
`app_settings.billing_enabled` and read by `isBillingEnabled()`
(`lib/billing/mode.ts`, cached 30 s per instance, stays free if it can't be
read). It replaced the `FREE_FOR_ALL_MODE` constant.
- Off: `getOrCreateCreditBalance()` returns `Infinity` and `deductCredits()`
  is a no-op for everyone (as for admins always), so no credits move. The
  homepage says "Try PandaWorld for free", the nav's Pricing link is greyed,
  the footer offers Donate, and no Buy Credits button shows.
- On: WhatsApp/web listings cost credits when they go live, extension
  autofills (and the unused AI photo tools) cost credits each, new sellers
  get 20 on first use (10 free WhatsApp listings), the dashboard /
  `/settings/billing` / `/pricing` show
  Buy credits, and the homepage banner, nav and footer switch to pricing.
- Purchases always land in the stored balance, whatever the switch
  (`creditPurchase` → `storedBalance`).
- The admin page won't switch on while a readiness check fails
  (`lib/billing/readiness.ts`: Paystack key set and accepted, live vs test,
  `NEXT_PUBLIC_APP_URL`), shows measured AI cost per run from `ai_usage`
  against what each run earns, and can top up low balances to the current
  welcome amount.

**Starter is no longer sold (2026-10-08;** owner: "let's remove the 35 GHS
PACK"). `CREDIT_PACKS` is Standard (GHS 70 = 210), Pro (GHS 140 = 440) and
Business (GHS 280 = 940); "From GHS 70" on the home page and pricing meta
follows from it, and /pricing shows Free plus three packs (4 columns).
Starter (80 credits for GHS 35) lives on in `RETIRED_PACKS`: a past
purchase still reads as Starter (the only one was the owner's admin test,
2026-10-02), with packRank -1, so it has what free credits have and
autofills with nothing connected (`autofillBlock` now tests `< standard`).
Checkout (`getCreditPack`) refuses it; a payment for it is still credited
(`getPaidCreditPack` in paystack-purchase.ts), so a Starter checkout opened
before the change and paid after isn't lost. Terms and the chat's site
guide no longer name Starter. Don't add Starter back to CREDIT_PACKS to
resolve old purchases: that would put it on sale again.

**Prices changed 2026-10-07** (see "Pricing, 2026-10-07" under Outstanding
work): Starter 80 credits, autofill 2, 12 free credits, listing price by
country, WhatsApp services charged. The paragraph below is the 2026-10-01
launch pricing it replaced.

**Prices (launch pricing, 2026-10-01; `lib/billing/credit-packs.ts`).** 1
credit = GHS 0.35 at the Starter price: a live WhatsApp/web listing 2
credits (GHS 0.70), an extension autofill 1 (GHS 0.35), an AI image 4 (GHS
1.40). Packs: Starter GHS 35 = 100 credits, Standard GHS 70 = 210, Pro GHS
140 = 440, Business GHS 280 = 940 (up to 15% extra; a listing ~GHS 0.60 at
Business). Set against measured costs of ~GHS 0.25 per live WhatsApp
listing (AI ~0.05, WhatsApp messages ~0.18, Paystack 1.95%) and ~GHS 530 a
month fixed once charging (Vercel Pro, Supabase Pro): break-even ~1,200
listings a month. The Terms (`app/terms/page.tsx` §4) describe credits
without numbers, pointing to /pricing.

**Pack features (2026-10-01).** `PACK_FEATURES` in `credit-packs.ts` lists
what each pack unlocks from its `minPack` up; `lib/billing/features.ts`
`hasFeature(userId, id)` grants it from the highest pack the seller has
ever bought (purchase ledger), and to admins and everyone while billing is
off. QC follow-up and guided fixes (`qc_fix`) need Standard and up, gated
completely: below it the feeds cron doesn't check QC at all (no alert, no
refund), acceptance messages don't promise a QC alert, and Fix & resubmit
on a QC rejection points to the editor and the packs. Pro and Business
add the extension's image polish (`image_polish_extension`, IMAGE_CREDIT_COST
per image that comes back) and its price calculator for the seller's own
country (`fee_calc_extension`), both live 2026-10-02: GET
/api/extension/account returns `features` and `country`
for the panel, and the polish route checks `hasFeature` itself. They also
listed features not built yet, shown like the others with no "soon" label
(owner's call, 2026-10-03; greyed out before), and the pricing FAQ and
Terms §4 named them as not available yet. That ended on 2026-10-07 (owner:
"don't mention the 'not available yet'"): order alerts and shipping labels
are on for their packs, and `comingSoon` / `comingSoonLabels()` are gone.
Don't bring back a "not available yet" list.

**Every plan in the chat (owner, 2026-10-07: "make all the capabilities
available to all plans in the chat and charge credits for those we
charge ... except the label and the alert on WhatsApp").** `minPack:
EVERYONE` in `PACK_FEATURES` means every plan, free sign-up credits
included: `shop_whatsapp` (live products, orders with packing, ready to
ship and cancelling, reports, payouts, warehouse, bulk and content changes)
and `fee_calc_whatsapp`. `featureAccess` only checks the balance for them
(blocked at 0, `blockedBy: "credits"`). Charges are unchanged (live change
or bulk tap 0.5, order-update notices 0.2, listings at the country price);
the payout-paid message is free (owner, same day: "let us not bill payout
message"). Still by pack: `qc_fix` (Standard+, put back the same day: "yes
QC on standard and up"), `shipping_labels` (Standard+, the label PDF on
WhatsApp only, never on the web) and `order_alerts` (Pro+: new-order
alerts, order-update notices and payout-paid notices, `runShopNotices`
skips a seller without it); and the extension's two Pro tools. `packFeatures(pack)` leaves out the every-plan
ones (`everyoneFeatures()`); the pricing page lists those in a line of
their own, the FAQ and Terms §4 say so, and `featureMinPackName` is "" for
them. In `lib/whatsapp/orders.ts` the orders gate is `shop_whatsapp`;
without `shipping_labels` on WhatsApp a pack shows "Pack all" (not "Pack
all & labels"), no label is fetched or charged, and the reply says labels
come with the Standard pack. The assistant's `sellerFacts` lists three
lines: the chat's shop features, label PDFs, alerts.

**The owner's plan of 2026-10-07 (pack rules, buying, autofill).**
- Free credits = Starter: listing, the chat (free), orders (see, pack,
  ready to ship, cancel), reading their shop (products, stock, sales,
  reports, payouts, fees), image polish, the shop health report.
  `shop_changes` (Standard+): changes to live Jumia products from the chat
  (one product, bulk rules, content, warehouse orders and their taps:
  shop.ts CHANGES_FEATURE). QC fixes and labels Standard+; order alerts
  (renamed "Order alerts on WhatsApp", still covering order updates and the
  free payout message) Pro+, WhatsApp only; the extension's fee calculator
  Pro+. `image_polish_extension` is EVERYONE at POLISH_CREDIT_COST (2) an
  image, in the extension and the chat; REPORT_CREDIT_COST (2) for the
  shop health report.
- Buying any pack needs WhatsApp linked and Jumia connected
  (lib/billing/connections.ts purchaseBlock): the checkout route answers
  403 with `connect`, and the Buy credits modal asks
  GET /api/extension/credits/eligibility when it opens and shows "Before
  you buy" with Settings instead of a Buy button. Owner, asked: yes, an
  extension-only seller can't buy without connecting both.
- Extension autofill on Standard/Pro/Business (pack bought last) needs both
  still connected (autofillBlock, a 403 the panel shows as text); free
  credits and Starter autofill with nothing connected.
- The web Listing Assistant is every seller's (listingAssistantFor: only
  the kill switch), and since 2026-10-07 so is the conversational AI on
  WhatsApp (assistantFor: everyone, both channels, unless switched off).

**Pay when live** (WhatsApp and web listings). Drafts are free; a seller
only needs enough available credits to draft. `pushListingToJumia` checks
`creditsDueForSubmission` before anything reaches Jumia and records the
price on `listings.credits_due`; while the listing waits on Jumia that
amount is held (`availableCredits` = balance − holds on pending listings).
`refreshPendingFeedStatus` calls `chargeLiveListing` on the pending → live
transition (once per listing: ledger reference `live:<listingId>`) and
clears `credits_due` when Jumia rejects it. A listing submitted while
billing was off is never charged.

A listing can be charged more than once: Jumia's quality check can reject
it after acceptance (refunded) and the fixed resubmission is charged again
when accepted. Charges are `live:<id>`, `live:<id>:2`, … and each refund is
`refund:<charge>`; `liveCharges()` finds the one still standing.

**Purchases are checked against the money.** The webhook and /verify credit
a pack only through `creditsPaidFor()` (`lib/billing/paystack-purchase.ts`):
GHS, at least the named pack's price, no more credits than it holds.
Paystack accepts transactions started in a browser with the public key, so
metadata alone is never trusted. A refused one is logged to app_errors
(source `paystack-webhook`).

**First live purchase (2026-10-02, the owner's admin account, Starter).**
The webhook credited it within a second of payment and /verify, 4 s later,
found it already processed: one purchase row, balance 20 + 100. The
account had no ledger row (admins never touch it), so the welcome grant
was written after the purchase; `creditPurchase` now provisions the
balance first. `__tests__/credit-purchase-flow.test.ts` replays that
purchase through both real routes for a non-admin: on top of the welcome
or a part-spent balance, either order, Paystack retries, another account's
/verify refused. After paying, the seller sees the new balance and a bell
notification, but no "payment received" message
(`CreditsPurchaseHandler` renders nothing).

**QC follow-up promised before the gate.** Listings Jumia accepted before
2026-10-01 15:00 UTC were told "Will alert you if it passes Jumia QC", so
`qcAlertPromised()` keeps their follow-up whatever the pack. It does
nothing after 2026-10-04 and can be deleted then.

Donations (`components/extension/donate-modal.tsx`,
`app/api/donations/checkout`, `lib/billing/donations.ts`) grant nothing and
only appear while billing is off.

---

## Environment variables (24 referenced — all from process.env.*)

### Required for any deploy
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` — Clerk (`pk_live_...` in prod)
- `CLERK_SECRET_KEY` — Clerk (`sk_live_...` in prod)
- `CLERK_WEBHOOK_SECRET` — from Clerk → Webhooks (`whsec_...`)
- `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` + `SUPABASE_SERVICE_ROLE_KEY`
- `GOOGLE_API_KEY` — single key for Gemini + Imagen + embeddings + Custom Search
- `GOOGLE_CSE_ID` — Programmable Search Engine ID (set 2026-05-28 to `05213a7d53c7a498e`)
- `GOOGLE_CSE_API_KEY` — the API key Custom Search runs on. **Must be a
  SEPARATE key from `GOOGLE_API_KEY`**: Google refuses to combine the Gemini
  API restriction with any other on one key ("Cannot be combined with the
  currently selected API restrictions", because Gemini keys bind to a service
  account), and `GOOGLE_API_KEY` is the AI Studio fallback for generation,
  embeddings and extension-fill. Falls back to `GOOGLE_API_KEY` when unset,
  which is the state that 403s with `API_KEY_SERVICE_BLOCKED`.
- `JUMIA_CLIENT_ID` + `JUMIA_CLIENT_SECRET` + `JUMIA_REDIRECT_URI` + `JUMIA_API_ENV` (`staging` | `production`,
  defaults to `production` for any other value — see `JUMIA_API_BASE` in `lib/jumia/oauth.ts`)
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

- **Jumia's banned words vs blocked product types (2026-09-29)**: two
  different checks. Banned *words* (`lib/ai/restricted-words.ts`) are kept
  out of drafts three times: named in every prompt, stripped after
  drafting, stripped again before a push (`lib/jumia/listing-ready.ts`).
  When a rejection names a new one ("contains the restricted words :
  supreme"), `logFeedOutcome` records it in
  `jumia_learned_restricted_words` and every later draft/push uses it
  (`lib/jumia/learned-restricted-words.ts`); no code change needed.
  Blocked *product types* (`lib/jumia/prohibited-catalog.ts`, from Jumia's
  per-country sheet) hold the listing instead: re-categorising to dodge
  one would be evading Jumia's rules. A row that names a category path in
  one Jumia department only applies inside that department; GH's "Acid"
  (lab chemicals) used to hold a collagen supplement in "Supplements >
  Hyaluronic Acid".

- **Supabase Free Plan limits (2026-09-29)**: database size (500 MB,
  doesn't reset; over it the project can go read-only) and egress (5 GB
  uncached per billing cycle). The database hit 605 MB: a 277 MB ivfflat
  index nothing used (every search is department-scoped) plus bloat from
  re-syncs and pg_cron/pg_net logs. Now ~190 MB; see
  `supabase/migrations/2026-09-29_shrink-database-under-free-plan-limit.sql`.
  Egress was mostly the category catalog: every new server instance paged
  all ~28k rows twice (~17 MB). It now pages them once per instance, in
  primary-key order, and every reader shares that copy, including the
  category drawer's `/api/jumia/categories?all=1` and concurrent callers
  while a load is in flight (`loadCatalog` in `lib/jumia/categories.ts`).
  Don't move the load into one SQL function: `category_catalog()` did
  that and took 2–19s; six at once hit the statement timeout and stalled
  a 3-product batch for 6 minutes (dropped in
  `2026-09-29_drop-category-catalog-rpc.sql`). Check size with
  `select pg_size_pretty(pg_database_size(current_database()))` before
  adding big indexes or vector columns.
- **A finished feed is not QC approval (2026-10-01)**: a feed with no
  errors means Jumia created the product; its quality check runs after
  and can still reject it. Two products announced "🎉 live" on 2026-09-30
  were rejected in Vendor Center ("Wrong Category: Category mismatch: AI
  suggests Grocery / Beverages / … / Soft Drinks") and the seller was never
  told. The feeds cron now follows live listings until QC decides
  (`lib/jumia/qc-followup.ts`, `qc_followup_candidates()` in
  `2026-10-01_jumia-qc-followup.sql`), reading `businessClients[].qc` from
  GET /catalog/products. A rejection sends the listing back to failed with
  Jumia's reason, refunds it and drops it from the live examples; Fix &
  resubmit switches to the category Jumia suggests. Every new push clears
  `jumia_qc_status` so a resubmission gets its own check. Messages (owner's
  wording): on acceptance "✅ Jumia accepted it — Will alert you if it
  passes Jumia QC", on approval "🎉 … passed Jumia QC and is now live on
  Jumia!" (`QC_APPROVED` in `lib/jumia/push-listing.ts`).
- **Fixing QC rejections (2026-10-01)**: the upload-error classifier
  (`lib/jumia/rejection-remedy.ts`) reads every QC reason as "unknown" and
  can only redraft. QC rejections go to `lib/jumia/qc-remedy.ts` instead:
  a table of Jumia's known reasons, then the AI (gemini-2.5-flash) for the
  rest, then one redraft. Actions: switch to Jumia's suggested category,
  ask for the category, ask the seller for a value (FDA number etc., into
  the category's own field, else the description), the brand, a price, new
  photos (`qc_new_images`, swapped in on "done"), or Vendor Center's
  reason when Jumia gave none; redraft; or explain what can't be fixed
  (banned brand, prohibited, counterfeit, duplicate). Questions wait in
  `whatsapp_sessions.awaiting_qc_answer` (`handleQcAnswer` in intake.ts).
  Jumia's own words are kept in `jumia_qc_reason` / `jumia_qc_comment`;
  its `rejectionReason` is often empty and the comment carries it.
- **Every bot message costs money (2026-10-01)**: from 2026-10-01 Meta
  charges per message the business sends, replies inside the 24-hour
  window included (about $0.004 each in "Rest of Africa", Ghana included;
  reportedly 1,000 free a month per WhatsApp number, shared by all
  sellers). The bot averaged ~8 messages per listing. Trimmed: no reply per
  photo burst ("done" reports the count), the last product's "saved" line
  rides on "drafting now", a single product's draft is one message, a
  batch's status lines + closing line + submit actions are one message
  (buttons for ≤2 ready, a list for more), and submit results + the batch
  sign-off are one. Before adding a message, fold it into one that's
  already going out.
- **A category the AI wasn't sure of (2026-10-01)**: when a draft's pick
  needs confirmation, the bot sends "🤔 Product N: I filed it under … but
  I'm not sure" with the alternates as buttons, and sets
  `listings.category_unsure`. The seller can tap, or type "N category:
  <name or path>" (a bare name works while only one draft is unsure);
  `handleDraftCategoryAnswer` matches it with matchCategoryAnswer and
  switches + refills the draft without submitting. Taps (`category:` ids)
  and typed answers work in "analyzing" too: the message usually lands
  before the batch is done, and every message there used to get "hang
  tight". The model sees at most two siblings in its top three
  (`diverseTop`): a kids' tablet was offered only Tablet Accessories >
  Bags, Cases & Sleeves > Cases/Bags/Sleeves and picked Cases.
- **Quiet batch mode's product numbers (2026-10-01)**: in mode I the
  seller closes each product by sending its number. Live, a photo and "1"
  sent a second apart: the "1" was handled before the photo had made the
  listing, was filed as a note, and products 2 to 4 all landed on product
  1 (8-photo cap, later captions dropped, "2" and "4" read as prices), with
  no reply at all. Now a number with no listing looks for one, waiting up
  to 10s when whatsapp_message_log shows a photo just arrived; with none it
  says so instead of staying silent. Another product's bare number is
  never a price: a later one gets "I'm still on product N" with Restart,
  an earlier one is ignored. A photo over the cap keeps its caption, and
  notes still parked when a product closes are applied to it, not cleared.
  Picking mode I now answers with ONE message: a worked example image
  (public/whatsapp/quiet-mode-example.jpg, sent by link with sendImage;
  its source page is scripts/whatsapp/quiet-mode-example.html) captioned
  with the instruction, "…like in the example above" (the caption shows
  under the picture). If the send is refused the instruction goes as plain
  text. Meta fetches the link, so it only works where the app URL is public.
- **Held for a field the category requires (2026-10-01)**: "this category
  also needs Weight (kg)" used to leave the seller only the editor. Now
  readiness returns the fields as `missingFields`; the batch summary (and a
  WhatsApp category switch) first fills what the AI can
  (`autoFillMissingFields`, lib/whatsapp/missing-value.ts, one
  `extractAttributesForCategory(..., { only })` pass), then
  `askForNextMissingValue` asks for the rest one at a time, after any price
  question, pointer in `whatsapp_sessions.awaiting_value_for`
  ({listingId, field}). Replies take "0.5", "500g", a tapped option
  (`value:N`) or text; "skip value" moves on; anything else drops the
  pointer. Weight and package sizes are always estimated now (rule 7 of the
  attribute prompt): they are shipping values, not specs.
- **A category switch keeps the draft's values (2026-10-01)**:
  refillAttributesForCategory used to drop every AI value with the old
  category and never mirror weight into `weight_kg`, so a switched shower
  cream lost its weight. It now carries values the new category also has
  (if allowed there) and fills empty weight/size columns.
- **The bot asks for what blocks a product (2026-10-03)**: a price, a field
  the category requires, or a variation from its stocked options is asked
  for in chat instead of "pick one in the editor", at draft time, after a
  stopped submit and in Fix & resubmit. `askBlockingValue` (intake.ts)
  asks a required field first, then the variation
  (lib/whatsapp/variation-question.ts: the session's awaitingValueFor gets
  field `__variation`; the reply is matched to the category's options,
  several allowed, and saved as variant rows with the product's price and
  stock). `resubmit: true` on the pointer (a stopped submit or Fix) sends
  the product straight back once nothing else holds it. A single product
  drafted without a price gets one message: "✅ Product drafted: X. ⚠️
  needs price. What price…?" with an "Or enter it here" editor button.
- **A category named close to Jumia's (2026-10-03)**: notes naming a
  category ("Category: Portable Power Banks") that isn't Jumia's exact
  name used to be ignored. `resolveStatedCategory` now returns `near`: up
  to 3 categories whose path holds every word the seller wrote. Drafting
  puts them in front of retrieval's candidates, marked
  `[CLOSE TO THE CATEGORY THE SELLER NAMED]` (`sellerNamed`, ai.ts), with
  the usual candidates kept after them, since a close name can still be
  the wrong shelf. An exact name is still used outright, and a shared one
  is still the whole shortlist.
- **One variant by default (2026-10-03)**: runAutoAnalyze keeps one
  variant unless the seller's notes name options (`notesNameVariants`,
  lib/whatsapp/variant-claims.ts: a stocked-options claim, "comes in …",
  "colours: …", "3 sizes", "variations: …"), and never saves one without a
  label. The Describe prompt already asked for this; a single product
  still drafted as two variants, the second unlabelled, and its submit
  stopped on "Variant 2 has no Variation label". When the Describe pass
  gives no variant but the note intent read the seller's (verified against
  the note), those are used (2026-10-07: "Variation is 100ml" drafted with
  none and the bot asked "What variation(s) do you have?").
- **Sales set in chat reach the variants (2026-10-07)**: handleEdit,
  applyNotes and the assistant's edit save a sale on the listing and carry
  it to the variants (`carrySaleToVariants`, listing-edits.ts: those with no
  sale, those at the listing's previous one, or all when they share one).
  A variant's own sale beats the listing's in the push and is what the
  editor shows, so "Sale 100 from 20th October to 28th October" was set and
  the draft showed none. The focused editor also shows the listing's sale on
  a variant without its own, and on save writes the listing's sale as the
  variants' shared one (none when they differ). A QC price fix below a
  variant's sale clears it (`dropVariantSalesFrom`).
- **Named once (2026-10-07)**: a single product's "✅ Product drafted: X."
  with its missing-value or variation question drops the question's own
  "*X*" line (`named` in askForNextMissingValue / askBlockingValue).
- **Prices in chat (2026-10-03)**: a price the bot says back goes through
  `chatPrice` (intake.ts): the seller's own symbol from their shop's
  country ("GH₵150", "₦15,000", "KSh 500"), or the bare number when the
  country isn't on file, never "GHS" for someone who isn't in Ghana.
  `shopCurrencyForUser` (GHS fallback) is for reading a typed price only.
- **A refused category is asked for at once (2026-10-03)**: Jumia's "You
  can't list products in this category…" no longer gets a redraft that
  guesses another category first. The rejection message itself is the
  category question (`askedForRefusedCategory` in lib/jumia/push-listing.ts
  calls `askCategoryForRefusedListing` in intake.ts), and a Fix tap on one
  asks it too (`askRefusedCategory`): the product named by its title,
  suggestions not refused in the seller's country, and the tip to copy the
  path off a similar product on their Jumia site (jumia.com.gh, .ng, …).
  A batch with several rejections keeps its Fix taps; each category one
  asks when tapped.
- **Start another, and "already with Jumia" (2026-10-03)**: the button
  under a submitted batch, a resubmitted product and a drafted product is
  *Start another* (`START_ANOTHER`, id "start another", a restart with a
  "Let's list more!" hello), where Restart was; errors, connect prompts
  and help keep Restart. A batch that's all gone to Jumia ends in
  `finishSubmittedBatch`, which resets the session and keeps the batch in
  `whatsapp_sessions.last_submitted_batch_id`. While that's set, a reply
  in awaiting_count that isn't plainly a count (`CLEAR_COUNT_RE`: "3",
  "3 products") gets "✅ … already with Jumia" instead of being read as a
  count: "Quantity 20" used to start a 20-product batch. A count or Start
  another clears it.
- **WhatsApp text caps (2026-10-02)**: Meta refuses (400, nothing sent)
  any interactive body over 1,024 characters, a list's included, and plain
  text over 4,096. A 20-product batch summary of 1,731 went in a list and
  was refused, after the batch was already marked finished, so the seller
  heard nothing. The caps and `splitForText` live in
  lib/whatsapp/text-limits.ts; intake.ts adds `replyLongText` and
  `fitInteractiveBody` (long text first as plain text, a short body on the
  buttons/list). Used by the batch summary (which also falls back to plain
  text if the send fails), the "weren't sent to Jumia" list, the status
  reply, the submit results and the QC/acceptance update
  (notifyBatchResolved). The intake-flow tests' client mock enforces both.
- **Fix/Edit taps name the product (2026-10-02)**: a button holds 20
  characters, so "Fix product 3" can't carry the name. The QC update
  numbers its lines ("Product 3: ⚠️ …") and the Fix message lists
  "Product 3 — <title>"; list rows show the title as their subtitle. The
  "weren't sent to Jumia" follow-up names them the same way.
- **"Not visible for category" goes back by itself (2026-10-02)**: Jumia
  refuses fields our cached schema lists but the category doesn't show,
  naming them a few at a time (a freezer in Refrigerators: 7, then 4 more).
  logFeedOutcome already excluded the named fields on arrival
  (jumia_excluded_attributes); now the feeds cron also resubmits the
  listing (lib/jumia/auto-resubmit.ts) instead of sending the seller a Fix
  button, up to 3 rejections a day per listing. Two bugs fixed with it: the
  stored reason held Jumia's feed error plus each product error again,
  joined with " | " (allErrorTexts now keeps a text once), and that " | "
  made the classifier read it as mixed, so Fix redrafted the listing
  instead of resubmitting.
- **Price calculator in the extension (2026-10-02, Pro and Business)**:
  the panel's "Price calculator" section frames /embed/calculator?country=,
  the site's calculator for one country with nothing around it and no
  country switch (app/embed/calculator, public, noindex). The country is
  `country` from GET /api/extension/account: the seller's Jumia connection,
  else where the request comes from, else Ghana. The page posts its height
  (`pandaworld:embed-height`) so the frame fits it; loaded when opened.
- **Polish images in the extension (2026-10-02; Pro and Business since
  0.2.53, admins only before)**: every connected seller sees "Polish
  images" (owner's request, 2026-10-06). GET /api/extension/account always
  sends `features.imagePolish: true` (what panels 0.2.53 to 0.2.55 read to
  show it, so no extension update was needed for that) and
  `features.imagePolishAllowed` (whether this seller may use it; panels from
  0.2.57 read it, and a tap without it says "Upgrade to use this feature."
  with a link to /pricing). Panels 0.2.53 to 0.2.55 call the route, whose 403
  (`upgrade: true`) says the same; the route is the real check. Before 0.2.53
  panels read `isAdmin`. A seller can also be given it, free, by a row in
  `feature_grants` (lib/billing/feature-grants.ts: `free_use` skips the
  credits, `credit_allowance` ends it once that many credits are spent
  since the grant; added by hand in SQL, no page). The button
  doesn't show the price (owner's call); the credits are deducted after. It harvests the uploaded photos
  (same HARVEST as autofill), shrinks them to ≤1536px JPEG, and POSTs up to
  3 to /api/extension/polish-images (API key auth, `isAdmin` enforced
  there too, public in middleware). That calls `generateProductShots`
  (lib/gemini-image.ts, Gemini 2.5 Flash Image, one call per shot in
  parallel: main on white, angle, lifestyle, detail) and returns public
  URLs. The panel squares each (pad for white shots, crop for scenes),
  converts to JPEG, shows a grid with Save links, then sends PLACE_IMAGES:
  content.js sets each File on the slot's `<input type=file>` and fires
  change, waiting (up to 20s) for slot i to exist, since Jumia only adds
  the next empty slot once an upload is in; falling back to the last slot
  put the 4th image over the 3rd live. The Save links are the fallback.
  One build serves everyone: the section only shows for admins. No credits charged. The request goes from the panel, not the
  worker, because generation takes ~30s.
  content.js's record of uploaded files (`capturedFiles`, the first
  harvest tier for both Polish and autofill) holds the current product's
  own uploads only: images placed by PLACE_IMAGES are left out
  (`placingImages` flag around the dispatch), and `forgetOtherProducts`
  clears it on a path change and drops slots no longer on the page. Before
  0.2.52 it lived as long as the tab, oldest first, so a new product in the
  same tab polished the previous one's images again (live, 2026-10-02).
- **Notices (2026-10-06)**: a message from us to one seller, in table
  `user_notices` (title, body, `dismissed_at`; added by hand in SQL, no
  page). Body is plain text: `*word*` is bold, a blank line a new paragraph.
  Shown in the extension panel from 0.2.57 (GET /api/extension/account ->
  `notices`, a card with "Got it" -> POST /api/extension/notices/dismiss,
  API key) and in the dashboard's notification bell, above the account
  activity (layout.tsx -> ExtensionShell `notices`; its x posts
  /api/extension/notifications/dismiss with `kind: "notice"`). Panels before
  0.2.57 ignore `notices`, so a seller on one sees it on the dashboard only.
  lib/notices.ts. A notice with `show_on_key_card = true` is also shown above
  the Copy button on the dashboard's API-key card (the one place a seller
  signed out of the extension is sure to visit) and is dismissed when they
  copy their key, so it is seen once. The dismiss route does nothing when the
  session is Clerk's "Impersonate user" (`actor` is set): the owner looking
  at a seller's dashboard must not use up the seller's message (it was
  dismissed that way on 2026-10-06). To show it again:
  `update user_notices set dismissed_at = null where id = '...'`.
- **Update available (0.2.57, 2026-10-06)**: GET /api/extension/account
  returns `latestExtensionVersion`, the newest version on the Chrome Web
  Store, read from `app_settings` key `extension_latest_version`
  (lib/extension/latest-version.ts). It is set BY HAND once the Store has
  published a version, never from a deploy, so sellers are never told to
  update to a version Chrome can't give them yet:
  `insert into app_settings (key, value) values ('extension_latest_version', '"0.2.58"') on conflict (key) do update set value = excluded.value, updated_at = now();`
  Unset or malformed means no bar. A panel older than it shows a blue bar
  with "Update now" (panel.js): `chrome.runtime.requestUpdateCheck()` asks
  Chrome for the update (also once, quietly, when the bar first shows), and
  if one is ready `chrome.runtime.reload()` restarts the extension on it
  (the seller reopens the panel and refreshes their Jumia tab). Neither call
  needs a permission: never add one, since Chrome disables an extension
  that gains permissions until every seller re-approves. Panels before
  0.2.57 have none of this, and Chrome updates them by itself within hours.
- **Extension 0.2.58 (built 2026-10-06, for the owner to upload; no new
  permissions)**: Autofill and Polish sign the seller out the moment the
  server answers 401 "revoked" (`signOutRevoked`, same removal as the power
  button's logout()); a 402 from Autofill shows a **Buy credits →** link
  under the message (`buyCreditsLink`); Polish says "You're out of credits."
  with Buy credits when the account's `outOfCredits` is true or the route
  answers 402, and "Upgrade to use this feature." with See credit packs when
  it's the pack. The "🔒 Encrypted & stored locally on your device." line
  under the key field is gone (owner's request; the Privacy Policy link
  stays, panel.js sets its href). Published by Google; app_settings
  extension_latest_version set to "0.2.58" on 2026-10-06 (it had never been
  set, so no panel showed the update bar). Only 0.2.57 panels have the bar;
  0.2.56 and older update through Chrome on its own schedule.
- **FAQ (2026-10-02)**: public at `/faq` (app/faq/page.tsx, content in
  lib/marketing/faq.tsx with a plain-text copy of each answer for its
  FAQPage structured data), linked from the extension sidebar and the
  footer, in the sitemap. The owner wanted it open to everyone; the
  briefly signed-in /extension/faq redirects there (next.config.mjs). The
  Credits section only renders while billing is on, every number from
  lib/billing/credit-packs.ts; keep answers in step with the bot.
  The WhatsApp guide shows both ways of sending a batch with the example
  image (components/marketing/whatsapp-sending-modes.tsx, `sendingModes`
  in lib/marketing/guides.ts). The landing page's "List from WhatsApp"
  goes to /extension/whatsapp-listings (through sign-up when signed out).
- **Option values after a category switch (2026-10-02)**: the switch now
  runs the same check a first draft does (`allowedValueFor` in
  lib/jumia/preflight.ts): AI values snapped to the allowed spelling or
  cleared, the seller's own left alone. Live: Age Group "Female" held a
  pair of earrings. Readiness also no longer holds over a refused value
  that's only the AI's guess; it still does when the seller typed it, it's
  a variant option, or their notes say it.
- **A category named in the notes (2026-10-01)**: "Category is wigs" in a
  caption was only a hint, and two wigs landed in Hair Extensions and
  Fascinators. `resolveStatedCategory` (lib/jumia/stated-category.ts)
  matches it against Jumia's leaves: one match is kept as the seller's
  (field_sources.category_code = "user"), several of the same name (seven
  Wigs) become the whole shortlist; loose matches are ignored.
- **Undelivered WhatsApp messages (2026-10-01)**: the send API answers
  200 for a message it later fails to deliver; the failure comes back as a
  webhook status update. The webhook records each one in app_errors
  (source `whatsapp-delivery`, `lib/whatsapp/delivery-status.ts`). Watch
  for 131047: a free-form message outside the 24-hour window, which QC
  alerts arriving days later will hit until they're sent as a template.
- **Emoji in WhatsApp messages built by joining lines (2026-09-28)**: the
  production minifier folds `[...].join("\n")` of constants into one
  string; when one line was a `${}` template it printed a new template
  with the emoji escaped twice, and sellers got "padlock icon
  🔒" instead of 🔒. Tests run the source, so they passed. Keep
  joined message lines as plain strings. `scripts/check-built-emoji.mjs`
  now runs after `next build` (package.json and vercel.json) and fails the
  build if the server bundle contains a double-escaped emoji.
0. **Embedding model drift (cost: four months of wrong categories)**: on
   2026-05-26 the category index was embedded with AI Studio's
   `gemini-embedding-001`. On 2026-05-29 embedding QUERIES moved to Vertex's
   `text-embedding-005`. Nobody re-embedded the index, so from that day the
   index and the queries lived in two different vector spaces. Both models emit
   768 dimensions, so **nothing ever errored** — pgvector compared unrelated
   spaces and returned confident nonsense. A safety helmet was filed under "Ball
   Transfers", another under "Automobile > Car Care > Cleaning Kits", a canvas
   print under "Icing & Decorating Spatulas", and four of seven Jumia push
   failures traced to a wrong category.

   It stayed invisible because nothing recorded which model wrote a vector, and
   unfixable because `embedPendingCategories` selected only `WHERE embedding IS
   NULL` — at 100% coverage the daily cron was a permanent no-op that could not
   rewrite a stale vector even in principle.

   **The invariant now: never write an embedding without writing
   `embedding_model` in the same statement.** The backfill re-embeds any row
   whose model differs from `currentEmbeddingModel()`, so a future backend
   switch heals itself on the next cron run. Fixed 2026-09-14 (#88).

   **And if you ever re-embed in bulk, REINDEX afterwards.** The ivfflat index
   (`lists=100`) computes its centroids at build time from the then-current
   vector distribution; leaving the old centroids in place keeps recall broken
   even once every vector is correct. It needs `maintenance_work_mem` above the
   32MB default — 256MB works.


0. **The embedding search was timing out on Vertex too (fixed 2026-09-13)**:
   measured live on a real WhatsApp draft — `[category-search] embedding
   search TIMED OUT after 4000ms`, with Vertex correctly configured, the
   dept-scoped RPC verified healthy, and every category embedded. The cause
   isn't the model: `embedViaVertex` has its OWN auth path, separate from
   `gemini-client.ts`, and the first call in a fresh process pays for a
   dynamic `import("google-auth-library")` + a JWT sign + an OAuth token
   fetch — all inside `searchCategoriesByEmbedding`'s 4s race. The same
   request logged `[gemini] backend=vertex` (which prints once per process),
   confirming a cold start, and `retrieval=11560ms` of a `total=22701ms`
   analyze, 4s of it waiting on a result that never came.
   Fix: `warmEmbeddingBackend()` (`lib/ai/embeddings.ts`), started
   un-awaited at the top of `runAutoAnalyze` so the one-off cost overlaps
   Pass A's ~5s vision call. The token caches for ~50 min, so a warm
   process never pays it again. Watch the `[category-search] embedding
   search ok in NNNms` line to confirm it stays well under the budget —
   that log exists precisely because this failure was previously silent.
1. **Embedding cold start**: `gemini-embedding-001` regularly took 30–40s on a
   cold call when the analyze pipeline used it for category retrieval —
   this is why it was dropped from `runAutoAnalyze` entirely in the
   2026-09-13 department-first rewrite (see above). It's back as of the
   same day's "Retrieval upgrade" work, but bounded: `searchCategoriesByEmbedding()`
   (`lib/jumia/category-search.ts`) races its own call against a 4s
   internal timeout and returns `[]` on a miss, so a cold AI Studio start
   degrades silently instead of stacking toward `runAutoAnalyze`'s own
   deadline. Configuring Vertex AI (`GCP_PROJECT_ID` +
   `GOOGLE_APPLICATION_CREDENTIALS_JSON`) avoids the cold start
   altogether — `text-embedding-005` is provisioned-warm, <1s.

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
0. **Billing is on (2026-10-01) while three things aren't ready** (audit,
   2026-10-01): Vercel's Hobby plan allows no commercial use, "any method
   of requesting or processing payment" included (Fair Use Guidelines;
   donations are allowed), so Pro is needed while selling credits; and
   Supabase Free has no automatic backups of the credit ledger. (Terms and
   Privacy were published as written on 2026-10-01: linked in the footer,
   the buy modal and the sign-in pages. The Privacy Policy, last updated
   2026-05-20, doesn't name WhatsApp/Meta as a processor yet.) Also open: Next.js 15.5.24+ for
   the critical advisories 14.x won't get (on 14.2.35 now), and a Meta
   utility template for QC/rejection alerts outside the 24-hour window.
1. **Lawyer review** of `app/terms/page.tsx` + `app/privacy/page.tsx`, published
   as written on 2026-10-01 (owner's decision); a review is still advisable.
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
8. ~~**Migrate from AI Studio API key to Vertex AI**~~ — DONE (2026-05-29,
   `6022a45` + `94444fa`). Production runs `backend=vertex`. Left here only
   because migrating the embedding half without re-embedding the index is what
   caused the four-month category outage described below.

### Credit rules (owner, 2026-10-06)

**Since 2026-10-07 the chat locks at 0, not below a listing's cost**
(owner: "at zero credit the chat should tell the user they need to top up
and lock after that"): `chatLocked` in lib/billing/credit-status.ts,
used by credit-gate.ts. One reply ("🔒 ... this chat is locked until you
top up"), then silence on WhatsApp; on the web,
GET /api/listing-assistant/messages returns `locked` (creditLock in
lib/whatsapp/listing-assistant.ts, which also puts the one reply in the
conversation the first time) and the page swaps the composer for a Buy
credits banner until the balance is above 0 (a purchase or a refund). Above
0 and below a listing's cost the chat answers; a batch count it can't cover
is refused before any photo (batchCreditRefusal), without the "running
low" warning on the same message. The notes below describe the old line.

- **The WhatsApp bot goes quiet below one listing's cost**
  (`BOT_MIN_CREDITS` = LIVE_LISTING_CREDIT_COST = 2; metered sellers only:
  never admins, never while billing is off). It sends ONE reply ("You have
  1 credit left, and a WhatsApp listing needs 2, so I'll stay quiet until you
  top up…", or "You've used all your PandaWorld credits…" at 0, with Buy
  credits), then nothing at all, not even "typing…" (webhook `acknowledge`
  sends read ticks only), until they can afford a listing again. Moved from
  "at 0" the same day: the owner's test seller with 1 credit sent a
  product's photos and was only refused at drafting. Order alerts stop too
  (order-alerts.ts `botPausedForCredits`). Extension and dashboard pack
  features still pause at 0 (Autofill costs 1). lib/whatsapp/credit-gate.ts
  `creditGate`, run first in intake.ts handleLinkedMessage. Still works at 0:
  listing updates from Jumia (sent, not answered), disconnecting Jumia
  (disconnect / confirm disconnect / keep jumia connected), linking a number
  (webhook, before the gate). Order alerts and every pack feature stop.
- **Coming back**: any rise above 0 (purchase, refund, admin top-up, a hand
  edit seen at the next message) brings everything back. A QC rejection's
  refund is the built-in way back, so the QC check in /api/cron/jumia-feeds
  and the listing-update wording use `hasFeature(…, { ignoreBalance: true })`.
- **Below 6 (LOW_CREDITS)**: one WhatsApp warning with the reply to the next
  message (so it lands inside the 24 hours), and one notice (user_notices
  kind `credits_low`; at 0 replaced by `credits_out`) in the dashboard bell
  and the extension panel, added by the ledger when a charge crosses the
  line (lib/billing/credit-status.ts, called from extension-credits.ts
  deductCredits/addToBalance/topUpBalancesTo). Remembered in credit_notices
  (migration 2026-10-06_credit-notices.sql) and reset when the balance
  recovers (>0 for the out flags, >=6 for the low ones), which also takes
  the notices down. Sellers already below 6 before this shipped get the
  WhatsApp warning at their next message, but no dashboard notice until
  their next charge.
- **Batch start, before any photo**: if the seller's available credits
  (balance less what's held for listings waiting on Jumia) can't list the
  count they gave, the batch is NOT started: the bot says how many it can
  ("Reply *2* to list those now, or buy credits to list all 4"), with Buy
  credits, and waits for a new count (`batchCreditRefusal`). Done's own
  check (reserveDraftCapacity) stays as the backstop.
- **Pack features follow the pack bought LAST** (lib/billing/features.ts
  `currentPack`), no longer the biggest ever bought, and pause at 0
  (`featureAccess` says "pack" or "credits"; grants pause too). Messages say
  "buy credits" when it's the credits: Polish route answers 402
  `{buyCredits: true}`, the account route sends `outOfCredits`, the QC fix
  and the orders gate word it accordingly. Pricing FAQ updated to match.

### WhatsApp assistant: the conversational layer (pilot, owner 2026-10-06)

> Superseded on 2026-10-07: the assistant is on for every seller, reads
> every typed message first, and has no daily allowance or pilot list. See
> "The AI reads every typed message, for every seller" below. The rest of
> this section is the history and still describes the actions and checks.

The owner: "we will maintain the way the images are sent ... but anything
else can be a conversation where the intent of the user is understood and
the AI executes the right code", "the conversational flow will only come to
play if users try to talk to it like they did not know the current flow",
"we will pilot this for my admin account". Examples given: "change the
quantity of the fridge to 20" (ask which fridge if there are two) and
"change the variation to Large for the drafted T-shirt".

- **Who**: admins (`isAdmin`) and the user ids in app_settings
  `assistant_users` (a JSON array). Everyone else: unchanged. To widen the
  pilot: `insert into app_settings (key, value) values ('assistant_users',
  '["user_…"]') on conflict (key) do update set value = excluded.value;`
- **Where**: lib/whatsapp/assistant.ts `runAssistant`, called from
  intake.ts at three points only:
  - review step (`handleAwaitingBatchConfirmation`), after every exact
    command (photo, submit, review, edit: tap, price/value answers, a bare
    product number) and in place of the older `classifyBatchIntent`;
  - just after a batch went to Jumia, and between batches
    (`handleAwaitingCount`), for words that aren't plainly a count.
  Never in awaiting_photos (text is a product's notes there, as always),
  analyzing, or the Jumia connect steps.
- **The fixed flow starts at "Got it — N products"** (owner, 2026-10-06:
  "the fixed product upload flow should start from this message, so users
  can say i want to list 5 products and the bot should understand them").
  Before it:
  - for everyone, `plainCount` (lib/whatsapp/batch.ts) reads a message that
    is plainly a count, in digits or words: "3", "five products", "I want
    to list 5 products", "I'm listing four today". It's also what starts a
    new batch straight after one was sent (it replaced CLEAR_COUNT_RE);
  - on the pilot, anything else goes to the assistant, whose `list` action
    hands back a count. The count must be in the message, or add up from it
    ("2 shirts and a fridge" is 3; `countBacked`), and starts the batch the
    usual way (credits checked first, the cap said). Small talk with a
    number in it ("I have 2 questions") no longer starts a batch on the
    pilot; for everyone else the first digit still does, as before.
- **The plain edit stays deterministic**: "2: price 150", "quantity 20",
  a sale with dates still go to `handleEdit` with no AI call
  (`plainQuickEdit`: handleEdit's extractors found something and the text
  names no other field). Anything else goes to the assistant.
- **Its own replies for everything else** (owner, 2026-10-06: "users that
  say anything that our system don't know should get a response from the AI
  telling them what it is capable of ... this messages should not be fixed",
  "restricted to jumia related and our systems", "only enter into fix mode
  when the user signals it wants to list", "users can even say send me the
  link to your home page"). The `reply` action is the AI's own message:
  - greetings, small talk, "what can you do" and anything unmatched get a
    numbered list of what it can do, tailored to the seller, ending with
    what they'd like to do for their Jumia shop;
  - Jumia and PandaWorld questions are answered from what it's told;
  - anything outside them gets "I don't understand that, try something
    different".
  What it's told: `capabilities()` (each line is something the code does)
  and `sellerFacts` (their country; pack bought last, or not charged; orders
  and labels and QC fixes on, paused, or "needs Pro"; available credits).
  Links: only `assistantLinks` (home, pricing, dashboard, listings, review,
  settings, faq, guides, the extension on the Chrome Web Store, calculator,
  commission rates, their country page, Vendor Center, privacy, terms),
  chosen by key and sent as a CTA button. `cleanReply` strips any other web
  address and caps it at 900 characters. In review a reply keeps the Submit
  all / Review listings buttons. It answers in the seller's language. The
  fixed "help"/"status" commands are unchanged.
- **The AI only chooses actions** (gemini-2.5-flash-lite, JSON): edit /
  submit / list / restart / review / orders / credits / reply. Our code
  checks each part (`parseAction`, `verifyChanges`):
  - a price or quantity must be a number written in the message;
  - a name, brand or colour must be written in the message;
  - a variation must be in the message, one of the category's options, or
    one the product has (so "add XL" can keep "M"). If one isn't, the whole
    list is dropped rather than losing a variation.
  - What's dropped is told: "I couldn't find the price in your message".
- **Carrying out an edit** (`applyChanges`): only draft / failed (held)
  products. Rules:
  - price: Jumia's minimum check, then carried to the variants;
  - quantity: carried to the variants (see the bug below);
  - name: at least 15 characters;
  - brand: refused if on Jumia's forbidden list for the category;
  - sale: read from the message with both dates, as handleEdit does;
  - variations: `parseVariations` against the category's options, then
    `saveVariations`. Size names now match both ways ("Large" ↔ "L",
    "2XL" ↔ "XXL"; `SIZE_NAMES` in variation-question.ts), which also helps
    the existing "What variation(s) do you have?" question;
  - anything else: the Edit product link.
  The reply lists what changed per product, with Submit all / Review listings.
- **"Which product?"**: when the change fits several products and the
  seller didn't say all, it asks. Two products get buttons plus Both; three
  or more get a list plus All N. The change waits in
  `whatsapp_sessions.assistant_pending` for 30 minutes. A tap (`apick:N`,
  `apick:all`), a typed number (it applies, it does NOT submit that
  product), or "both"/"all" answers it. Anything else drops it.
- **Never on the AI's word**: submit, start over, and "list more" during
  review come back as a button
  to tap ("Send all 2 products to Jumia?" → "Yes, submit ✅" with id
  `submit all`). Orders go through `handleOrderMessage` with its own pack
  and credit gate. Credits reply with the real balance.
- **If the AI fails** (no reply, error): the usual handling runs, the old
  "Which product number is this for?" included.
- **Learning**: every message it reads is in `whatsapp_assistant_log`
  (stage, message, validated action, outcome). Check it to see where it
  misunderstands. Calls are in ai_usage as feature `assistant` ("WhatsApp
  assistant (pilot)" on /admin/billing). Expect about $0.0002 a message.
- Migration 2026-10-06_whatsapp-assistant.sql (applied).
- **Bug fixed on the way**: a quantity changed in chat ("2: quantity 20")
  only changed `listings.quantity`. Jumia takes stock from each variant
  (`stock: v.quantity ?? 1`), and every draft has at least one variant, so
  the old quantity went to Jumia. `carryStockToVariants`
  (lib/whatsapp/listing-edits.ts, shared with the price helpers moved out
  of intake.ts) now moves variants still at the old quantity.
- Tests: __tests__/whatsapp-assistant.test.ts, and "the assistant, on the
  pilot's accounts" in whatsapp-intake-flow.test.ts (gemini-client mocked
  with scripted replies).

### The live Jumia shop on WhatsApp (owner, 2026-10-07)

"Leave [several shops / countries] and [Fulfilled by Jumia] and let's
implement the rest from the API AND WIRE IT CONVERSATIONALLY." Everything below
is reached by talking to the assistant (so, for now, only on its pilot
accounts; the worker's notices go to every seller with the pack).

- **API layer**: lib/jumia/shop.ts, from Jumia's spec
  (vendorcenter.jumia.com/api-docs/openapi.yaml). `call` is shared with
  lib/jumia/orders.ts.
  - **Catalog**: GET /catalog/products as one row per variation
    (`productsFromCatalog`), using the seller's own country's business client
    ("jumia-gh") for status, QC and price. Stock comes from GET
    /catalog/stock.
  - **Sync**: kept in `jumia_products`; `syncCatalog` re-reads it when it's
    older than 3 hours and the assistant needs it, paced under Jumia's
    4 requests a second.
  - **Finding a product**: `findProducts` matches the seller's words: exact
    SKU first, otherwise the products whose name, variation, brand and SKU
    hold the most of the words. Deleted products are left out.
  - **Live changes**: `sendLiveChange` sends stock (POST
    /feeds/products/stock), price or a sale with dates, or ending a sale
    (/feeds/products/price, for the seller's country too), and on/off
    (/feeds/products/status).
    - Feeds take the VARIATION's id (`variations[].id`) with its sellerSku.
      The product set's `id` is not the one they take.
  - **Payouts**: GET /payout-statement with currency=LOCAL.
  - **Orders**: one order by its number (`findOrderByNumber`, last 89 days);
    orders created since a date; orders changed since a time
    (`ordersChangedSince`, `updatedAfter` + DELIVERED, RETURNED, FAILED,
    CANCELED).
- **WhatsApp**: lib/whatsapp/shop.ts.
  - **Live changes**: `proposeLiveChange` finds the product and offers ONE
    tap before anything reaches Jumia: "Yes, change it ✅" (`lchg:<id>`) or
    No (`lchgno:<id>`). If several products fit, a list where tapping one
    (`lpick:<id>:<n>`) applies the change.
    - Every change is a `jumia_product_changes` row: pending, then sent,
      done, failed or cancelled. It's also the record of who changed what.
    - Offers expire after 30 minutes and can only be tapped by their owner.
    - A price below Jumia's minimum is refused before any of this.
  - **Taps** are handled globally in intake (`handleShopTap`, right after
    the order taps) and keep no conversation state.
  - **Answers**: `answerStock` (a product's stock, out of stock, low = 3 or
    fewer), `answerProducts` (overview, turned off, rejected with Jumia's
    reason), `answerOrderStatus` (item by item, with tracking; a waiting
    order gets the usual order view and buttons), `answerSales` (today / 7
    days / 30 days in the seller's timezone, by status; the total leaves out
    cancelled orders), `answerPayouts` (last paid with its reference, the
    open statement with sales, fees and refunds).
- **The assistant** (assistant.ts):
  - **Actions**: `live_change` (stock | price | sale true/"end" | active),
    `stock`, `shop`, `order_status`, `sales`, `payouts`.
  - **Checks**: the product must be named in the message
    (`productBacked`). Numbers must be written in it; stock 0 is allowed for
    "sold out" and the like. A sale needs its price and both dates in one
    message, otherwise it says so. An order number must be in the message.
  - **Drafts vs live**: `edit` stays for the drafts in review; `live_change`
    is for products already on Jumia.
  - **Context**: `capabilities()` and `sellerFacts` describe all of this,
    including whether their pack has it.
  - `assistant_users = ["*"]` in app_settings switches the assistant on for
    every seller.
- **Told without asking**: lib/whatsapp/shop-notices.ts, run by the same
  10-minute worker after the order alerts (route budgets: 30s for alerts,
  20s for these).
  - **Refused changes**: a change Jumia refused, or didn't confirm within a
    day, is told. One it applied updates `jumia_products` quietly.
  - **Order updates** (`order_alerts`): delivered, returned, failed and
    cancelled orders, grouped, at most every 2 hours. A cancellation goes
    out at once ("don't ship these"). The seller's own cancellation through
    the bot isn't told back (orders.ts `markNoticed`).
  - **Payouts** (`shop_whatsapp`): a paid payout, checked every 6 hours.
  - **Same rules as order alerts**: WhatsApp linked and Jumia connected,
    not while paused for credits, quiet 10pm to 7am, and only inside the 24
    hours (no template for these, so they wait).
  - **First run**: what's already there is taken as known, so nothing old
    is announced. Each thing is told once (`shop_notices`).
  - **Low stock** with new-order alerts (`shop_whatsapp`, our own message
    only): `lowStockNote` reads the ordered products' stock live, using the
    sids from the catalog copy.
- **Pack**: products, stock and payouts are the new `shop_whatsapp` feature
  ("Live Jumia products and payouts on WhatsApp", Pro and up, comingSoon
  like the order features until the owner tests). Orders and sales come
  under `order_alerts`.
- Migration 2026-10-07_jumia-shop.sql (applied): jumia_products,
  jumia_catalog_syncs, jumia_product_changes, shop_notices.
- **Not yet tried against the live API**: the stock, price and status feeds,
  /payout-statement, and /orders with `updatedAfter` plus a status list.
  Watch the first "[shop notices]" logs and the first confirmed change on
  the owner's shop.
- Tests: __tests__/jumia-shop.test.ts (Jumia's answers shaped as in its
  spec), plus "the live shop, through the assistant" in
  whatsapp-assistant.test.ts.

### Assistant, after the owner's live test (2026-10-07)

The owner talked to the pilot for about an hour (whatsapp_assistant_log,
whatsapp_message_log). The live API calls worked: a stock change on the
Wellington boot was applied. What went wrong, and what changed:

- **It promised instead of acting**: "Any orders cancelled today?" was
  answered "I can check that for you", and nothing followed. Same for
  "Has JUMIA payed me?", "Shop statement" and "how many listings today".
  Fixes:
  - **Rules in the prompt**: act, don't promise; read the new message with
    the recent conversation; a product that isn't a draft is a live one;
    expect typos.
  - **15 worked examples** in the prompt (message → JSON).
  - **New answers**: `sales` with a status and "yesterday" (`answerSales`
    lists the orders that moved to that status), `listings`
    (`answerListings`, PandaWorld listings by period).
  - The shop's name is now in `sellerFacts`.
- **No memory of the conversation**:
  - "Let's do five then" (after the 20-a-time limit) became "submit all".
  - "Yes check" (after "I can check") became "submit" and sent two drafts.
  - Fix: `recentConversation` puts the last 8 messages in the prompt.
    Button ids read as "[tapped a button]".
  - A live product named only in the conversation is accepted, marked
    `fromContext`; "it" then means the last product changed in the last 30
    minutes (`lastChangedSid` → `preferSid`). An order number may come from
    the conversation too.
- **Wrong draft**: "Set the gold medal to 25" changed the gold-tone
  earrings draft. Fix: edits carry `said`, the seller's words for the
  product, and the draft must fit them (`fitsDraft`: more than half of the
  words in its name). If no draft fits, a price or quantity becomes a
  `live_change` for that product, which still needs the confirm tap.
- **A change nobody asked for reached Jumia**: "Change the sales price of
  the Wellington boot to 100" came back as `sale: "end"`, and one tap on a
  list row applied it (the size 44 boot's sale was ended; the 100 sale was
  never set). Fixes:
  - **Seller's own words required**: "end" needs end-sale words
    (`END_SALE_WORDS`), off/on need `OFF_WORDS` / `ON_WORDS`.
  - **Picking from a list now leads to the Yes/No confirm** (two taps when
    several products fit).
  - **Sale price**: the AI gives `sale_price`, checked against the
    message's numbers. Dates come from `saleWindow`: written ones
    (`extractDateRange`), or "this month" / "this week" / "you choose", which
    run from today to the end of the month or week. Otherwise it asks for
    them.
  - **`extractSalePrice`** now reads "sale 80", "on sale at 100" and "on
    sale for 100". The bot's own example, "sale 80 from 20 Oct to 30 Oct",
    didn't read before.
- **Silence right after starting a batch**: "Has JUMIA payed me ?", "I
  won't list again" and "You remember which one I last used?" were taken
  as product 1's notes. Now, on the pilot, a message that `looksLikeQuestion`
  (a "?", or starting with has/what/how/cancel/I won't…) sent before any
  photo of the batch goes to the assistant in stage `starting`:
  - `note` keeps it as the product's notes, as before;
  - restart stops the batch;
  - anything else is answered, followed by "I'm still ready for product 1
    of N".
  From the first photo on, nothing changes.
- **Smaller fixes**:
  - variations keep the words the message backs and leave out the AI's own
    ("add Blue variant" was refused);
  - the "couldn't see the new …" message gives an example per field;
  - stock lists are capped at 15;
  - the idle fallback says "Sorry, I didn't catch that…" instead of "I need
    a number";
  - no "Hi there!" unless greeted, and no pack warnings for features the
    seller has.
- **Watching it**:
  - `whatsapp_assistant_log.raw` now keeps the AI's own answer before our
    checks (migration 2026-10-07_assistant-log-raw.sql, applied).
  - The model can be switched without a deploy: app_settings
    `assistant_model` = "gemini-2.5-flash" (better reading, roughly 5 to 7
    times the cost) or "gemini-3.1-flash-lite" (AI Studio). Default
    "gemini-2.5-flash-lite".
  - Measured in the test: 32 calls, $0.0071, about $0.0002 a message.

### Assistant round 3 and its limits (owner's second test, 2026-10-07)

From the second session (whatsapp_assistant_log, 2026-10-07 02:14 to 03:27):
- **A bare "10" after "What should its stock be?"** started a batch of 10.
  The question is now kept in `whatsapp_sessions.assistant_pending` as
  `{kind: "live_value", field, products, preferSid, at}` (`LiveValueAsk`,
  10 minutes); intake checks it right after the shop taps
  (`answerLiveValue`): a bare number (or "stock 10", "GHS 150") is the
  answer and goes to `proposeLiveChange`; anything else drops it.
- **Several products in one change**: `live_change` takes `products: [...]`
  (`others` on the action) and `all` when the message says all/every.
  `proposeLiveChange` with several queries → `groupTargets`: one match,
  the product just changed, every match when "all" or when the matches are
  one product's variations (same `setSid`); otherwise it says back which
  word fits several products, and nothing is offered. One question with a
  line per product, one tap (`lgrp:<groupId>` / `lgrpno:`), one feed
  (`sendLiveChanges`, items in `products`), up to `MAX_GROUP` = 20. The
  rows share `jumia_product_changes.group_id` (migration
  2026-10-07_live-change-groups.sql, applied). An edit returned with no
  drafts around becomes a live change (`splitProducts` on its `said`; "and"
  splits only before the/my/also/a, so "Salt and Pepper Grinder" stays one).
  A value missing from the message may come from the seller's own last 3
  messages ("update those to 10 each" → "the freezer and the blender").
- **The worker** reads each feed once (`checkSentChanges` groups rows by
  feed) and refuses only the products Jumia refused (`feedItemResults`,
  from `feedItems` by SKU or sid), in one message.
- **"Is the drone live?"** → `product_info` (`answerProductInfo`): status,
  QC, price, sale, stock, read fresh for up to 3 matches (`refreshProducts`:
  GET /catalog/products?sellerSku= and /catalog/stock, saved back). A
  live_change with `active` on a question (`isStateQuestion`) becomes
  product_info, never a change.
- **ON words** take typos ("tun on") and not "on sale"; `productBacked`
  accepts a shared start of 4+ letters ("dron" for "drones").
- **Whole shop at once** ("off all products", "turn off all the other
  products") is explained (`namesAProduct`, BULK words), not attempted.
- **Fees** → `fees` (`answerFees`, feature `fee_calc_whatsapp`, Pro): the
  product's Jumia category path (jumia_categories) matched to the country's
  fee table (`feeCategoryForPath` in lib/marketing/country-fees.ts: the
  deepest path part holding every word of a table name), commission
  (`commissionOn`), the per-item fee where it's by category (else the size
  range, Nigeria), and what they receive, at the price they give, else its
  running sale price, else its price; with the calculator button. A draft
  in review is worked out from the draft. The AI's own "calculator" type is
  read as fees.
- **Sales**: `quarter` (90 days, Jumia's limit; "all"/"ever" map to it);
  several statuses at once (each read on its own request; the worker's
  comma-joined statuses are still unverified live). "returns" → returned.
- **Prompt**: no promises for later; questions about a product are
  product_info; greetings get the capabilities list; shop facts are answered
  from About this seller; new examples for each of these.
- **Starting a batch**: a reply carries "I'm still ready for product 1 of
  N" in the same message (one message, not two).

**Limits** (`lib/whatsapp/assistant-limits.ts`):
- Daily allowance of AI turns (`whatsapp_assistant_log` rows with `raw`
  since the seller's midnight): no pack 10, Starter 20, Standard 30, Pro
  50, Business 100; Nigeria half, Morocco a quarter (`COUNTRY_FACTOR`);
  none for admins or while billing is off. Past it: one message that day
  (`ALLOWANCE_TOLD`), then `runAssistant` returns "failed" so the fixed
  flow answers.
- Kill switch: app_settings `assistant_enabled` = false turns the assistant
  off for everyone, admins included (`assistantEnabled`).
- Global ceiling: app_settings `assistant_daily_limit` (default 2,000 AI
  turns a UTC day across sellers); past it, off for all but admins.

### Pricing, 2026-10-07 (owner)

All in `lib/billing/credit-packs.ts`; charged only while billing is on,
never for admins.
- Starter is 80 credits for GHS 35 (was 100; a purchase of 100 still reads
  as Starter via `LEGACY_CREDIT_AMOUNTS`). An extension autofill is 2
  credits (`LISTING_CREDIT_COST`). New sign-ups get 12 free credits (6
  listings, `FREE_SIGNUP_CREDITS`); balances already given are unchanged.
- **Listing price by country** (`COUNTRY_LISTING_CREDIT_COST`: Nigeria 3,
  Morocco 5, else 2; `listingCostFor`, `listingCreditCost(userId)` from the
  seller's jumia_connections country). Used for the hold/charge
  (push-listing, auto-analyze), the WhatsApp messages, the credit gate and
  status, the assistant. Public pages show 2; a signed-in seller from those
  countries sees their own price on /pricing ("Prices for your shop in
  Nigeria"), /settings/billing and the pack picker (`listingCost` prop on
  BuyCreditsModal / BuyCreditsButton / ExtensionShell). The Terms (§4) say
  the price can depend on the country.
- **WhatsApp services, charged as used** (`chargeService` /
  `refundService` in lib/billing/extension-credits.ts: once per ledger
  reference, refused when available credits don't cover it):
  - a shipping label 0.5 per order, the first time it's sent
    (`label:<orderId>`; `sendWithLabels` checks before asking Jumia; not
    enough credits → packed, the label waits with a Get labels button);
  - a confirmed live change 0.5 per tap whatever the number of products
    (`lchg:<id>` / `lgrp:<groupId>`), shown in the question; given back if
    Jumia's POST fails or the worker finds all of it refused;
  - an order-updates or payout message 0.2 (`notice:orders:…`,
    `notice:payout:…`); one the seller can't cover waits for a top-up.
  New-order alerts, the low-stock line and chatting stay free.
- **Shipping labels from Standard** (`shipping_labels` minPack standard).
  "orders" (the list, pick, view) opens with either `order_alerts` (Pro)
  or `shipping_labels`, so Standard sellers can pack and label; new-order
  alerts, order status and sales stay Pro.
- `creditCosts(listingCost)` is the one list of what costs credits, used by
  /pricing and /settings/billing.

**Fewer messages per listing** (owner, 2026-10-07):
- A single product's "✅ Product drafted" and its missing-value question
  (variation, weight…) are one message (`askForNextMissingValue` with
  `prefix`), as the price question already was.
- For sellers with QC follow-up (Standard and up), Jumia's acceptance isn't
  told (`acceptedQuietly` in push-listing): they hear "passed Jumia QC and
  is live" or the rejection. A partly accepted product is still told.
  Sellers without it still get "accepted", their last update.
- Measured before: a guided single product took about 8 bot messages
  (count, note ack, saving, drafted, question, answer, submitted, accepted,
  then live); now 6 to 7. A captioned batch: 5 for the whole batch.

### Listing Assistant: the bot on the dashboard (owner, 2026-10-07)

"A chat interface with image + upload button named Listing Assistant, where
the interface does all queries, drafting and pushing except order alerts and
labels." It is the WhatsApp bot itself, not a copy:
- **Address**: `web:<userId>` stands where a phone number would
  (`lib/whatsapp/channel.ts`: `webAddress`, `isWebAddress`, `chatChannelOf`).
  The session (whatsapp_sessions), the log, the assistant and its allowance
  all key on it, so the web chat and WhatsApp are separate conversations.
- **Sending**: `callGraphApi` in lib/whatsapp/client.ts records a message to
  a web address in whatsapp_message_log (awaited, `recordOutboundMessage`,
  with its buttons / list rows / link in `payload`) and returns: nothing goes
  to Meta, and the `*IfConfigured` senders work with no WhatsApp account
  (`canSend`). Templates are never sent to the web; a label document would
  go without its PDF (orders are refused before that).
- **Photos**: POST /api/listing-assistant/upload validates (validateImageBuffer,
  5 MB) and stores under `<userId>/assistant/` in product-images
  (`storeAssistantUpload`); the media id is `web:<path>`, and
  `ingestWhatsAppImage` returns its public URL (only the seller's own folder).
- **Messages**: POST /api/listing-assistant/message (`receiveAssistantMessage`
  in lib/whatsapp/listing-assistant.ts) records the inbound message (a photo
  with its link, a tap with the button's words as `label`; the page's own id
  as `wamid`, so `claimMessageId` drops a resend) and calls
  `handleLinkedMessage(userId, web:<userId>, id, content)`, exactly like the
  webhook. GET /api/listing-assistant/messages?after= is polled by the page.
  Rate limits `assistantMessage` 300/h, `assistantUpload` 200/h.
- **Listings made there** carry `listings.chat_channel = 'web'` (set at
  `claimBatchSlot`; migration 2026-10-07_listing-assistant.sql, applied), so
  their updates (accepted, live, rejected, the category question) go to the
  web chat (`chatAddressFor` in push-listing; works with no WhatsApp linked).
  Analysis jobs already carry the address, so drafts come back to it.
- **Not on the web**: `handleOrderMessage` answers any order command on a web
  address with "orders, packing and labels are on WhatsApp" and reads
  nothing; `answerOrderStatus` doesn't open the packing view there; the
  assistant's prompt says so (`web` in PromptContext). New-order alerts and
  shop notices only ever go to whatsapp_connections numbers. Sales, order
  status by number, stock, live changes, payouts, fees all work.
- **Page**: /extension/assistant (`components/assistant/listing-assistant.tsx`):
  bubbles with WhatsApp formatting, the bot's buttons as pills, list rows
  inline, links as buttons, photos; Upload (up to 8 photos at a time, Jumia's
  per-product maximum; the typed text becomes the first photo's caption),
  drag-and-drop and paste; polls every 2.5 s (1.2 s while a message is being
  handled). Sidebar item "Jumia Listing Assistant" under the dashboard. On a
  phone (below `sm`) the chat is fixed full screen over the shell's top bar
  and title card, with one slim row (back arrow to the dashboard + title);
  from `sm` up it's a card in the page.
- **Never silent while collecting photos** (owner: "I uploaded an image and
  got no response"). WhatsApp says nothing to a photo (paid per message) and
  the quiet way (I) moves between products in silence; on the web,
  `sayWhereWeAre` in listing-assistant.ts fills that in when the bot sent
  nothing (reply count unchanged) during awaiting_photos: the upload's last
  photo (the page sends `last: false` on the others) gets "📷 Product N of
  M: 3 photos, notes saved. Upload more photos, or tap *Done*…" with a Done
  button (no notes: "Type its price and any notes…"); a product closed in
  silence gets "✅ Product N saved (…). Next: product N+1 of M…"; a quiet-mode
  note gets "📝 Noted for product N". WhatsApp is unchanged.
- **Resend**: a message or photo that didn't go stays in the chat marked
  "Not sent" with a small Resend button under it (the message's own body,
  or for a photo that never uploaded, its file). Other photos of the same
  upload still go. Sidebar: "Jumia Listing Assistant" is first on the list.
- **No photo-settle waits on the web** (`albumsArriveLoose` in intake.ts):
  the page sends one photo at a time and waits for each, so the in-flight
  waits and the "Still receiving your photos" hold only apply to WhatsApp.
- **Who**: the assistant's pilot (`assistantEnabled`: admins and
  app_settings `assistant_users`, `["*"]` for everyone; off with the kill
  switch). Others see "coming soon" with a link to WhatsApp. Its messages
  cost no WhatsApp fees; the AI turns count against the same daily allowance.
- **Orders on the web (owner, 2026-10-07)**: "the label and alerts for orders
  should be on WhatsApp only ... we can do all other order actions". The
  web chat runs the WhatsApp order flow (lib/whatsapp/orders.ts, `Ctx.web`):
  waiting orders, Pick orders, Pack all / Pack order, Ready to ship, Cancel
  with its confirm. Packing there prints and charges no label: the message
  says labels are printed on WhatsApp ("orders") or in Vendor Center, and
  `orders:labels` / `olabel:` there answer the same without asking Jumia.
  New-order alerts still only go to whatsapp_connections numbers. Since
  the same day orders are on every plan (`shop_whatsapp`, see "Every plan
  in the chat" under Billing); only the label PDF and the alerts keep
  their packs.
- **Logo, not a sparkle** (owner, 2026-10-07): the PandaWorld "P" in the
  chat header on desktop, the sidebar item (`PandaLogoIcon`,
  components/assistant/panda-logo-icon.tsx, on a white tile so it shows on
  the dark active row) and the coming-soon card.
- **Scroll down**: a round down-arrow, centred over the composer, shows once the chat is
  scrolled up from the bottom; tapping it goes back to the newest message.

### Commands, polish, the shop health report, Jumia first (owner, 2026-10-07)

- **Commands** (lib/whatsapp/commands.ts, run by lib/whatsapp/chat-commands.ts):
  menu, credits, report, polish [N], shop, out of stock, low stock, sales
  [today|week], payouts, on top of restart/status/help/orders/disconnect.
  The same words on WhatsApp (a command flow for everyone; "menu" sends a
  10-row list; the conversational AI there stays the pilot's) and in the
  Listing Assistant, whose message box says "Type / for commands": "/"
  or the + button beside Upload opens the menu
  (components/assistant/chat-commands.ts PALETTE, `slashToText` turns
  "/polish 2" into "polish 2"). Billed: report (REPORT_CREDIT_COST),
  polish (POLISH_CREDIT_COST an image that came back) and confirmed
  changes to live products; the rest is free. The assistant has the same
  two as actions (polish, health_report) when a seller asks in words.
- **Polish in the chat** (lib/whatsapp/chat-polish.ts): the extension's
  four PRODUCT_SHOTS made from a draft's own photos, which REPLACE the
  seller's on the listing (owner, 2026-10-07: "it must replace them
  entirely"), originals kept in listings.original_images. On the web its
  reply names no credits (nor does the report's footer): "don't mention
  credit spent after an action". WhatsApp's replies still do.
  From the note: note-intent.ts `polish_images` (the AI reads it, the quote
  must name the photos, notesAskForPolish) queues the listing at drafting
  (auto-analyze, chat listings only) and nudges
  app/api/worker/polish-images (CRON_SECRET, 2 per run); 'minute-workers'
  calls it while one is queued or a run is stale
  (2026-10-07_chat-polish-cron.sql). "polish 2" runs at once. Columns:
  polish_status (queued, running, done, failed, skipped),
  polish_requested_at (the charge reference `polish:<id>:<requested_at>`),
  original_images. Checked for all four first, charged for those that came
  back; nothing when none did, not enough credits, or the product is
  already with Jumia. pushListingToJumia refuses a product whose photos are
  queued or running ("still being polished").
- **Shop health report** (lib/whatsapp/shop-health.ts): live catalog, 90
  days of orders and items (newest 300 orders' items within 35s), payouts,
  PandaWorld listings → healthEvidence (pure) → healthScore (catalog 25,
  quality 15, orders 25, trend 10, fulfilment 25) → the numbers as text
  plus the AI's "What's working / What isn't / Do this next" from those
  numbers only (plainReading when the AI can't be reached). Credits are
  checked before Jumia is read and charged once it's ready
  (`report:<userId>:<minute>`).
- **Jumia first in the Listing Assistant** (jumiaGate in
  lib/whatsapp/listing-assistant.ts): not connected, the connect steps go
  in the conversation once and the web session waits in
  awaiting_jumia_credentials (the WhatsApp flow, paste Client ID + token;
  the country from the linked WhatsApp number, chatCountry); connected
  from Settings meanwhile, it moves on by itself. The page shows a "Connect
  Jumia to start" bar (`connectJumia` from GET .../messages).
- **Pointers to the assistant**: a fixed orange note under the sidebar's
  Jumia Listing Assistant item ("Talk to your Listing Assistant", no close)
  and, on phones, a pill at the bottom right; the home page's floating nav
  has it as its first of five links (a row from xl, the menu below that).

### Chat round 4: the owner's web test and a seller's WhatsApp day (2026-10-07)

- **Command menu** (components/assistant/chat-commands.ts): /change became
  **/edit "Edit live on Jumia"** (`aliases: ["change"]` keeps /change
  typing); no credit badges on the right; **/clear** (`action: "clear"`)
  opens a "Clear this chat?" dialog. A bare "Change" isn't sent: the page
  says what to add (`unfinishedFill`); the bot reads a bare change/edit as
  `edit_help` too.
- **Clear chat** (lib/whatsapp/chat-clear.ts, POST
  /api/listing-assistant/clear): sets whatsapp_sessions.chat_cleared_at
  (2026-10-07_chat-cleared-at.sql) and resets the session (restart). The
  log keeps every message; GET .../messages and recentConversation read
  only those after it, and return `clearedAt` so open tabs drop the rest.
  Typed "clear (my) chat" asks with buttons (`clear chat now` / `keep
  chat`); on WhatsApp it says how to clear the chat on the phone.
- **Help for the seller's pack** (lib/whatsapp/help.ts, `sendHelp`): what
  every plan has, "On your pack" and "Bigger packs add" from PACK_FEATURES
  (coming-soon ones left out), credits. app_settings `help_outbox` (user
  ids) + POST /api/worker/help-outbox (CRON_SECRET; not on a schedule, call
  it once by pg_net) sends it unasked, within WhatsApp's 24-hour window.
- **What the assistant knows about the seller** (sellerFacts): WhatsApp
  linked and its number, Jumia connected, the pack ("none bought yet").
  Rules: answer about themselves only from those lines; asked about their
  pack, name it and list what's on and off.
- **Daily chat replies**: replaced the same day by no per-seller limit at
  all (next section).
- **Fixed-flow fixes**: credits words ("remaining credit", "credits left",
  "how many credits…"); "dine"/"dne"/… alone are done (draft.ts
  isDoneWord, never mid-caption); "submit it" while asked for a price
  submits once priced, else asks again; a Client ID pasted twice or cut
  off (looksLikeBrokenClientId) is caught before Jumia; a sale price from
  the notes must say sale/promo/discount/was/now and can't equal the price
  (note-intent.ts SALE_WORDS: "Ghc 160" had set both); photos before a
  count get one reply per album (claimPhotoNudge, a compare-and-set on
  last_image_at), and Meta's album container there gets none; "Sizes: …"
  with a price answer saves the variations (variationsFromAnswer); "put a
  stop to this product creation" (STOP_ASK_RE, ≤12 words, never orders or
  sales) asks before restarting; the variation options list plain sizes
  first (commonFirst).
- **Restart on the questions**: the price question, the variation question,
  their "isn't one of the options" replies and the "edit it in the editor"
  fallback are button messages with the editor's link written in
  (replyLinkButtons): Skip for now / Submit all, and Restart.
- **Listing editor**: an X on each photo (not the last; not once the
  product is with Jumia) removes it from the listing at once.
- **Pricing**: a Free card first (FREE_SIGNUP_CREDITS, what they reach,
  everyoneFeatures), "Every pack includes everything on the Free card".
- **Install** (components/install/install-app.tsx, app/manifest.ts,
  public/icons): "iPhone & iPad" and "Android" buttons in Settings and the
  footer's "Get the app", each sliding up that phone's Add to Home Screen
  steps (Android's has Install now when Chrome offers its prompt). No
  store names or logos: there's no store app, and Apple's and Google's
  badges are for store listings only. root metadata `appleWebApp`.
- **Model**: the assistant runs gemini-2.5-flash-lite (about $0.0004 a
  turn). app_settings `assistant_model` switches it (MODELS): what went
  wrong in these tests was flow and facts, not the model.

### The AI reads every typed message, for every seller (owner, 2026-10-07)

"Any reply or text to the bot is taken afresh and the previous context is
taken into consideration too ... like this message ... about our entire
journey" — then "AI for all sellers and remove daily limit".

- **Router** (lib/whatsapp/intake.ts handleLinkedMessage, after the taps
  for orders, live changes, fix:/recat:/category: and a live value's
  answer, before the commands and the per-state handlers): `aiReadable`
  picks the typed text the AI reads first; `runAssistant` gets the stage
  (`aiStage`: idle, sent, starting, collecting, drafting, review), the
  batch position ("product 2 of 3"), the bot's open question
  (`openQuestion`: price, value/variation, category, QC, which product)
  and the review edit's product number. "handled" ends it; anything else
  rides on as `content.aiRead` and the usual handling runs, reusing it
  instead of asking the AI again (handleAwaitingCount: `{list}`, "default"
  → "didn't catch that"; review: "default" → the review reply). The old
  starting-stage question check is gone (the router does it), and the old
  classifyBatchIntent fallback runs only when the assistant is switched off.
- **Skips the AI**: taps (`tapped`, set by contentOf for button/list/
  template taps and by the web page for a tap with a label), button ids,
  plain numbers with or without a currency (PLAIN_NUMBER_RE), exact submit
  words, a command's own words (parseGlobalCommand, except the fuzzy
  stop_ask/edit_help, which go to the AI and stay as the fallback), a count
  in words between batches, "done" (and typos) while sending photos, a
  plain "2: price 150" in review (plainQuickEdit), and every message while
  connecting Jumia (codes) or in the error state.
- **"step"** (the AI's `{"type":"step"}`, old `note`): the message carries
  on the current step: an answer to the open question, or the product's
  notes while photos come in. Mid-batch, anything else is answered with the
  position appended (collectingNudge); "start over" asks first (Yes / No,
  keep going).
- **Memory** (lib/whatsapp/seller-memory.ts, table seller_memory,
  2026-10-07_seller-memory.sql): a running summary per seller (what they
  sell, how they work, what's unfinished, what went wrong), refreshed by
  the AI after their 4th message and then every MEMORY_EVERY (12), from the
  previous summary and their last 60 messages on WhatsApp and the web. In
  the prompt as "What you remember about this seller". `blankCodes` hides
  Client IDs, tokens, keys and LINK codes in what reaches the AI (memory
  and the 20-message recent conversation alike), and the summary is
  blanked again before it's saved.
- **Everyone, no allowance** (lib/whatsapp/assistant-limits.ts): the pilot
  list (`assistant_users`) and the per-seller daily allowance are gone. Left:
  the kill switch (`assistant_enabled` false: the fixed flow alone, for
  everyone) and the all-sellers daily ceiling (`assistant_daily_limit`, else
  DEFAULT_DAILY_CEILING 20,000 turns ≈ $20). Past the ceiling runAssistant
  returns `limited` and limitedText says the commands still work.
- **Cost**: about $0.001 a typed message (gemini-2.5-flash-lite, ~5-8k
  tokens with the site guide, memory and conversation), plus a memory
  refresh every 12 messages; about 1-2 seconds more per typed reply.

### Photos at once in the web chat; what's billed and what fires (2026-10-07)

- **Albums** (owner: "images to the web chat should be ... sent at a go"):
  the page uploads all picked photos at once and posts them as one message
  (`mediaIds`, up to 8, MAX_ALBUM); receiveAssistantMessage records one
  inbound row (payload `links`) and hands each photo to the bot in turn
  (`<id>:<n>`, the words as the first one's caption, as a WhatsApp album
  arrives), then one "Your product: N photos" reply. The bot's own photos
  go the same way on the web: sendImagesIfConfigured records one outbound
  image with `album` → payload `links` (chat polish uses it; WhatsApp still
  gets the main photo only). The page draws an album as a grid; every photo
  opens full size.
- **Billed, as on the pricing page** (creditCosts): a listing when it goes
  live, an extension autofill, a shipping label (first time, Standard+), a
  confirmed live change, an order-updates message (0.2), image polish (per
  image back), the health report. Free: new-order alerts, payout messages,
  chatting. All of these were checked in code on 2026-10-07.
- **Order alerts and labels are on for their packs** (`comingSoon` removed
  later the same day, see "Labels and alerts for every pack that has
  them"). Order alerts run every 10 minutes for Pro and up and send inside
  WhatsApp's 24 hours; outside it they wait for app_settings
  `order_alert_template` (not set: Meta's `jumia_new_order` was still in
  review). When Meta approves it: set
  `{"name":"jumia_new_order","language":"en"}` and send one test.
  Order-update messages have no template and only go inside the 24 hours.

### Labels and alerts for every pack that has them (owner, 2026-10-07)

Owner: "test the label on my shop - note i cancelled the order ... don't
mention the 'not available yet' ... after that let's make the new
improvement global".

- **Label test on the owner's shop passed.** Order #355926919 (cancelled
  through the bot on 2026-10-06; 3 items, one package,
  DS-GKC-355926919-5316): Jumia's print-labels still returns the label of a
  cancelled order that was packed. `labelsPdf` gave one 48 KB PDF, and it
  reached the owner's WhatsApp inside its message (`sendButtonsWithDocument`)
  at 21:02 UTC; the owner tapped its Menu button. Nothing on the order
  changed; no credits.
- **How to run it again:** POST /api/worker/label-test (Bearer CRON_SECRET,
  by pg_net with the vault's `cron_secret`) reads app_settings `label_test`
  `{ userId, orderId }` (an admin's own order only), empties it to `{}`
  (app_settings.value is NOT NULL), asks for the label with the bot's own
  `labelsPdf`, sends the PDF to that admin's linked WhatsApp, and answers
  with what Jumia said (read it in net._http_response). Read-only: it never
  packs, ships or cancels. The bot's own `orders` list shows waiting orders
  only, so a cancelled order is tested this way.
- **No "not available yet" anywhere.** `comingSoon` and `comingSoonLabels()`
  are gone: the pricing FAQ and Terms §4 no longer list unavailable
  features, help lists labels (Standard+) and order alerts (Pro+) like the
  rest, and the Buy credits window shows each pack's first 3 features as
  chips, "N more tools", and the full list under the chosen pack.
  Gating was never on the flag (lib/billing/features.ts), only the words.
- **Still true for alerts:** outside WhatsApp's 24 hours a new-order alert
  waits until app_settings `order_alert_template` is set (Meta's
  `jumia_new_order` in review).
- **Fixes from the owner's AI test the same evening** (WhatsApp, 20:43):
  - The prompt told the AI to answer "what can you do" with a *numbered*
    list; the owner's "4" (option 4, shop insight) then went the plain-number
    way and became "4 products". Now: choices as "• " lines with the words
    that do each (steps alone keep "1." lines), and a number typed right
    after a bot text that listed "1." options and ended with a question goes
    to the AI (`pickedFromList` in intake.ts) with that list in its
    conversation.
  - "Give me insight": vague insight / stats / performance is `shop` (the
    free overview), whose last line now points to *sales week* and *report*
    (REPORT_CREDIT_COST). "How is my shop doing?" and an asked-for report
    stay `health_report`, which charges at once.
  - `cleanReply` turns the model's `**bold**` into WhatsApp's `*bold*` and
    drops `#` headings.

### A draft's price, sizes and colours in one message (owner, 2026-10-07/08)

The owner's web chat: the bot asked "What variation(s) do you have?" for a
drafted bodysuit (category with 54 size options) and the answer was
"Price: 130gh / Sizes: Large, Medium, Small. / Colors: cream, black and
brown". The AI read it twice and both failed:

- First it put the sizes in the edit's `said` (the words for WHICH
  product), so the edit was refused as "isn't one of the drafts here".
  Now `saidIsValues` ignores a `said` made only of the change's own values,
  and the prompt says `said` is never the new values.
- Then it sent all 54 of the category's options as the variations, and
  verifyChanges took any listed option as backed. Now a variation is backed
  only when the message says it: written in it, a clothing size name for it
  (`sizeNamedIn`: "Large" for "L"), a current variation (adding), or a
  checked pair (next point).
- **The AI matches the seller's words to the category's options** (owner:
  "what if it was a different word with its interpretation in the variation
  list ... is the AI able to match it"): where the category lists options,
  the AI sends each variation as `{"said","option"}` ("free size" → One
  Size, "size 42" → EU 42, "ages 3 to 4" → 3-4 Years). Kept only when
  `said` is in the message and `option` is on the list; one phrase stands
  for one option, one per item it lists ("Large, Medium, Small"), or up to
  8 for a range ("S to XL"); a phrase read as more is dropped whole. The
  prompt now shows up to 120 options (was 40). In review, a draft's sizes
  (even answering the bot's question) are an edit, not "step".
- The AI wrote "cream" as "Beige": a colour not in the message falls back
  to the seller's own words on their "colour:" line.
- Saving sizes this way closes the bot's open variation question
  (`awaitingValueFor`). Options are saved one by one, so an option with
  "and" in it stays whole.
- `other` (a field chat can't change) must be a field name of up to 3
  words: "Don't list tbis again pls" came back as one. That message, mid-
  drafting, is now `restart` (asks before stopping), per a prompt example.
- `wordInMessage`: an apostrophe joins letters ("it's" has no "S"), but a
  quoted 'L' still counts.

### The web chat's product form, and four fixes from the owner's web session (2026-10-08)

Owner: "check my interaction with the web today should we standardise and
make product upload on the web a fixed flow?" Then: "fix the bugs and build
the form for only admin let me see first".

**Fixes (every seller, WhatsApp too):**
- An edit needs something from this message: the product's current
  variations alone back nothing (`fromMessage` in verifyChanges; "my message
  count so far" came back as the draft's sizes again and was applied). A
  pair's `said` is matched as whole words ("S" isn't in "message"). An edit
  whose values are nowhere in the message, in a message naming no field or
  number (`namesAField`), is "unclear", not "I couldn't see the new colour".
- A draft named by number in the edit's `said` ("the 150 is product 3
  price") is that draft (`draftNumberIn`), never a live product on Jumia.
- After a category switch that still needs a price, that product's price is
  asked and becomes the open question (`askForNextMissingPrice` with
  `from`); before, the next number went to the product asked earlier.
- "Let's list new products" in review: the AI's "list" with a count the
  message doesn't give is now "restart" (offers "Start a new batch?"); with a
  real count the offer's button is `start another N` (START_ANOTHER_RE takes
  a count), and a number typed right after the offer starts that batch
  (`NEW_BATCH_OFFER`, `startAnotherWithCount` in intake.ts) instead of being
  read as a price.

**The product form (admins only, `productForm` on the assistant page):**
"New products" in the chat's header opens components/assistant/product-form.tsx:
a card per product (photos uploaded through /api/listing-assistant/upload,
price required, quantity, sizes, colour, notes), "+ Add product" up to
ADMIN_MAX_BATCH_SIZE, "Draft N products". POST /api/listing-assistant/products
(404 for non-admins) checks every card (own photos, a price, a whole
quantity) and calls `startBatchFromForm` (lib/whatsapp/intake.ts): Jumia
connected, not mid-drafting, credits for the count (batchCreditRefusal);
records the form as the seller's message (an album, a line per product);
makes each listing with claimBatchSlot (channel web), the photos appended,
the fields as notes (`formNotes`: "Price: … / Quantity: … / Sizes: … /
Colour: …") and price and quantity set; then startBatchAnalysis, so drafting
reports in the chat as always. No count question, no Done, no sending ways.
Not built yet: fixing held drafts on cards (price box, size chips); they
still go through the chat's questions and the editor.

**Every seller lists through the form on the web (later 2026-10-08;** owner:
"open the form on the web for users who want to list so they don't go
through the old flow"). The page gives everyone `productForm` (max 10, 20
for admins) and the route only needs the assistant switched on. The chat's
ways in stay ("how many products?", the count buttons, "I want to list 3
products", Start another): on a web address, handleAwaitingCount stops at
the accepted count (after the Jumia and credit checks) and sends
`offerProductForm` ("📝 3 products: … in the form", button `form 3`)
instead of starting a batch; photos sent with no batch get it too (button
`form`). The page never sends a `form…` button as a message: tapping it
opens the form, and a bot message carrying one that arrives after the page
loaded opens it by itself, with that many cards and any photos sent in the
last 2 minutes as product 1's. A `form…` text that reaches the bot (an old
page) is offered again. WhatsApp keeps its own flow; a batch already
started the old way on the web finishes the old way. Help and the chat's
site guide point web sellers to New products.

### How a seller's sizes become variations (owner, 2026-10-08)

Owner, after drafting from the web form: "when the value entered can not be
matched with the expected variation what should happen, is it guessed by
the AI ... when it is a plain text field ... is what is entered used? if the
note says something that looks like a variation request what happens?"

- **A plain list is the variations** (`explicitVariationList` in
  lib/whatsapp/variant-claims.ts): a line "Sizes: …" / "Variations: …" /
  "Variants: …" with a colon, split on commas, "and", "&", "+" (never "/":
  "S/M" is a size). The web form's Sizes field writes one. In
  lib/actions/auto-analyze.ts it replaces the Describe pass's proposals
  instead of being reconciled against them (before: "Sizes: Cream" on
  earrings, whose photo suggested other options, kept nothing and held).
  A range ("38 to 44") or no colon ("Sizes Medium Large") isn't a plain
  list: the old reading stands (the Describe pass, then reconcileVariants).
- **Free-text variation field** (the category's is_variant attribute has no
  allowed values, e.g. "variation" on hats, earrings, wigs): the values as
  typed.
- **Closed list** (e.g. Bodysuits' Size, 549 values): each value is the
  list's own spelling (reconcileDraftVariation: case, plural, grey/gray),
  else a size name (`parseVariations`: "Small" is S), else the AI's match
  by meaning, which can only answer one of the list (aiMatchAllowedValue),
  else "..." and the bot asks with the options (the variation question),
  where the AI's {said, option} matching applies to the reply.
- **Notes**: still read by the Describe pass ("comes in red and blue" makes
  those variants; "only black available" restricts), the claim check and
  the one-variant rule. A "Colour:" line counts as naming options, so
  photo-proposed colours can stay as variants when no Sizes are given.
- The "Size field was never filled" Hold (readiness.ts
  blankSizeClaimReason) applies only when the category's variation field is
  size-named; a category whose variation is its own field keeps the sizes
  there (it held a beanie with variants S, M, L).
- Form: Quantity, Colour and Notes are labelled "(optional)".

### Polish in the form, and research across the shop (owner, 2026-10-08)

Owner: "add a polish before draft button to the form so that buttons turn
rough images into polished ones replacing the old one during draft ... let
it be able to make a number of Different API calls to the vendor shop and
get info and data and organize them to fit the sellers request."

- **Polish photos in the product form**: a switch on each card
  ("✨ Polish photos · 8 credits", shown only while the image service is on;
  the page passes `polishCost` = POLISH_COST). The route takes
  `polish: true` only as a boolean. `startBatchFromForm` queues that
  listing (`queuePolish`, right after its photos and notes are saved) and
  nudges the polish worker after `startBatchAnalysis`, so the four photos
  are made alongside the drafting and replace the seller's own
  (lib/whatsapp/chat-polish.ts, unchanged: charged per photo made, Buy
  credits when short, own photos kept in original_images, submit waits
  while they're being made). The form's line in the chat says "✨ polish".
  The note-intent queue in auto-analyze still works; `queuePolish` only
  queues once, so the two never double up.
- **Research** (lib/whatsapp/shop-research.ts, the assistant's `research`
  action): for questions no single answer covers, the AI names up to
  MAX_NEEDS (4) read-only sources: `products` (sort newest, oldest, price,
  stock, name; filter on, off, rejected, pending, out of stock, low, on
  sale; the seller's words; limit up to 30; since a period), `orders` (with
  their items), `product_sales`, `sales_summary`, `payouts`,
  `pandaworld_listings`. Each is read into plain lines (`readNeed`, never
  throws). Newest/oldest products without words come straight from Jumia
  (`fetchCatalogPage`, GET /catalog/products with `latestFirst`, plus
  their stock, saved back to jumia_products); the rest use the synced copy.
  Then a second AI call (gemini-2.5-flash) writes the answer to the
  seller's question from those lines only; `numbersBacked` checks every
  figure in it is in the data or the question (small counts and recent
  years allowed), else the lines go out as they are. Free (shop_whatsapp),
  nothing changes. Words for products must be in the message or the
  conversation (`productBacked`), else dropped.
- **"The last 10 products uploaded" is research, never listing**:
  `newestProductsAsked` in parseAction turns a list, restart, unclear or
  "I can't" reply into a newest-products read (10 when no number) unless
  the message says they want to list now ("I want to list my last 3").
  The owner's web chat got "I can't" and then "Let's list! How many…".
  Since any reply (the hello menu came back too) is replaced the same way.
- **A product's name on its own is that product**: after interpret, a reply
  or unclear for a message that is a product name in their shop (3+ words,
  every one in a jumia_products name, no "?"; `isProductName`) becomes
  product_info. "Malta Guinness Soft Drink - 330ml Bottles, Pack of 6",
  picked from the bot's rejected list, got "I can only look up products
  related to your shop". Not while a batch's photos come in (it'd be notes).
- **Rejection reasons**: Jumia's catalog API gave no `qcReason` for any of
  the owner's rejected products. The rejected list now says so ("check each
  one in Vendor Center") instead of a plain "Fix them…", and the prompt
  knows a reason is never guessed.

### Owner's web chat 09:34–10:04, the category drawer, the polish switch (2026-10-08)

- **"Change/restock X to N" is a live change, never a count**
  (`changeToAsked` in lib/whatsapp/assistant.ts, applied in parseAction
  when the AI said list, restart, unclear, help or an empty edit). After
  the bot asked "How many products are you listing today?", "Change
  Foldable Drone with HD Camera to 10" opened a 10-product form and
  "restock the foladable drone to. 10" offered a new batch.
  - "restock", "stock", "qty", "pcs"/"psc" → stock; "price", a currency,
    "cedis" → price; plain "to 10" → asks "the stock or the price?".
  - Leaves alone a draft's own name, "it", a field name and anything
    about a sale.
  - The prompt has the rule and examples.
- **"Those", "the last 10", "all" after a list are the products just
  listed** (bulk scope `listed`).
  - Saved in `whatsapp_sessions.last_listed` (migration
    2026-10-08_last-listed.sql, applied), kept through restarts and fresh
    for 30 minutes.
  - Written by research's products block, answerStock (a product's stock,
    out/low) and answerProducts (off, rejected).
  - `bulkAction` never widens "listed" to the whole shop. With nothing
    listed lately it asks which products; "restock all" then means what's
    out of stock.
  - The prompt says what was just listed.
- **No colour, brand or name warning** for a value the AI added when the
  message doesn't mention that field. "Large, Medium and Small" got
  "I couldn't see the new colour".
- **Restart only on listing talk** (`listingTalk`): listing or stopping
  words, a quantity, or things in the plural. "Let's enter Shop assistant
  mode" offered a batch; it now gets help.
- **Category drawer** (components/ui/category-drawer.tsx), used by the
  WhatsApp draft editor and the main listing pages:
  - Drawn into document.body through a portal, pinned top and bottom
    instead of `h-screen` (100vh ran under a phone's browser bar and hid
    the footer), above the dashboard's layers (z-[70]).
  - The selected path on its own line (2 lines max) and a full-width
    "Select category" button clear of the phone's home bar.
  - Search no longer auto-focuses on phones (the keyboard covered the list).
- **"The last 20" came back as 10**: the newest-products read asks Jumia
  for 4× the products wanted (up to 100; its page may count variations)
  and shows only as many as asked.
- **Polish switch**: just "Polish photos" (the credit cost and the
  explanation line removed, owner's ask). The cost still comes from the
  page (POLISH_COST), which only decides whether the switch shows.

### The assistant's test set: how a change is checked (owner, 2026-10-08)

Owner: "how can we ensure that we are not looping on what words is detected
as what ... how do we make sure that the next solution we offer for the
problem does not conflict the past solution." The plan (shared page:
https://claude.ai/artifact/8f6i4rjVFvPyG8EcKFHs5n) has four steps; step 1,
measuring, is this.

- **The set** (lib/evals/assistant-cases.ts): real messages from
  whatsapp_assistant_log (`src: "log MM-DD HH:MM"`) with the conversation
  before them, the drafts, the list just shown and their shop's product
  names where those matter, plus rewordings (`src: "variant"`) to test the
  request rather than the phrase. `ok` lists every acceptable answer as a
  shape of the parsed action ("~" = contains; arrays are sets).
- **The runner** (lib/evals/assistant-eval.ts) gives each case exactly what
  production does: buildPrompt, the model, parseAction, and runAssistant's
  product-name check. It scores twice: "pass" (as deployed) and "bare"
  (`parseActionUnguarded`: the AI's choice with safety checks only, no word
  rules). The gap between them is what the word rules are doing; step 2
  deletes the ones the AI no longer needs.
- **Runs**: rows in `assistant_eval_runs` (migration
  2026-10-08_assistant-eval.sql), worked by app/api/worker/assistant-eval,
  10 cases at a time, saved as they go. A case gets at most 40 s, and a
  timed-out case is recorded as an error, not scored. The worker has 120 s
  and starts a group only if it can finish. At 60 s, slow Gemini answers
  (8 Oct afternoon) made every call time out before saving. pg_cron calls it each minute only
  while a run is queued or running; queuing from /admin/assistant-tests
  also nudges it. AI calls count as the `assistant_eval` feature, never a
  seller's.
- **/admin/assistant-tests**: Run (the model in use, or flash / flash-lite
  to compare), score history, the latest run by area, and every case it got
  wrong with what it should have done.
- **Baseline (8 Oct, one run each)**: gemini-2.5-flash-lite 147/203 (72%),
  69% without the word rules; gemini-2.5-flash 194/203 (96%), the same
  without them. Flash: ~2.6 s a reply against 1.3 s, $3.33 against $0.94 per
  1,000 messages. On the owner's go-ahead, app_settings `assistant_model`
  is `gemini-2.5-flash` since 2026-10-08 12:27 UTC (delete the row, or set
  it back, to return to flash-lite; ASSISTANT_MODEL stays the default).
  The daily ceiling (20,000 turns) now caps a worst day near $67, not $19.
- **The rule from now on**: a misread from a real conversation becomes a
  case here first, with its right answer. A change to the prompt, the
  model or the checks ships only if no case that passed before fails. No
  new word rules in parseAction; safety checks stay.
- **Step 2 as a prototype, side by side** (owner: "can we test what we had
  wanted to build against what we have now without affecting anything?"):
  lib/assistant-v2/front-door.ts is "one front door". It builds the context
  as one record (stage, the bot's open question and what answers it,
  drafts, the list just shown, the shop's products the message names),
  makes one call to sort the message into an area, then one call that
  only sees that area's actions and examples (the chat's own, sorted by
  area). That call returns the chat's JSON or `clarify` (a question with
  2–3 options) instead of guessing. Then `parseActionUnguarded`, with no word
  rules. **Nothing in the chat imports it.** Runs with
  `pipeline = 'front_door'` (migration 2026-10-08_assistant-eval-pipeline.sql;
  `router_model` is the sorting call's model) go through it, and
  `asked` counts its questions back. A question back is right only where
  the case accepts any reply (it is a reply with buttons), and wrong
  otherwise. In /admin/assistant-tests, choose the way and the sorting
  model; click a run's time to see that run. Round 1 asked back for things
  that have a default (a period, a report kind, the price in a fees
  question), so round 2 asks only when the action, the product or a
  change's value can't be told.
- **Results, 8 Oct 14:52–15:44 UTC (Gemini slow that afternoon)**:
  - Live chat (Flash): 189/201 = 94.0%, median 2.4 s, $3.34 per 1,000
    messages (one call of ~9,200 prompt tokens).
  - Front door round 1: 183/203 (90%) under the final scoring.
  - Round 2 on Flash/Flash: 192/199 (96.5%), median 4.8 s, ~$2.10.
  - Round 2 sorting on flash-lite and reading on Flash: 194/199 (97.5%),
    median 2.8 s, $1.13 (~600 + ~1,000 tokens). It asked back 6 times,
    each one fair.
  - It fixes the live chat's leftovers: notes typed while sending a
    product, and "kettle price GHS 120" read as listing. Its misses are
    mostly the sorting call. Round 2 was tuned on this set, so its score is
    optimistic, and runs vary by about 2 points.
  - Only understanding is tested: carrying out and clarify buttons in the
    chat aren't built.
  - Flash-Lite for both calls (16:18): 188/200 (94.0%), median 1.4 s,
    ~$0.24 per 1,000. That is the live chat's score at a fourteenth of the
    cost, but its misses start the wrong thing ("i won't continue draft for
    only product 1" read as list 1), so the live front door reads with
    Flash.
- **Fixed 8 Oct (owner: "do this")**: `bulkAction` used to turn a group the
  message didn't name (`out_of_stock`, `low_stock`, `inactive`, `active`)
  into `all`. Now only `WHOLE_SHOP_RE` ("all products", "everything") makes
  it the whole shop; otherwise it asks "Every product in your shop, or only
  the ones out of stock?".
- **Daily ceiling**: app_settings `assistant_daily_limit` = 6000 since
  8 Oct, on the owner's go-ahead. The busiest day so far was 170 turns.

### Step 2 live: the front door in the chat (owner, 2026-10-08: "go ahead with building step 2")

- **Switch**: app_settings `assistant_front_door`: `"admins"` (the owner
  first), `"all"`, or a list of user ids; off without the row
  (`frontDoorFor` in lib/whatsapp/assistant.ts). Set to `"admins"` on
  8 Oct. To roll out, set `"all"`; to stop, delete the row.
- **What changes for those accounts**: in `runAssistant`,
  `interpretThroughFrontDoor` replaces `interpret`. It makes two calls:
  sorting on `FRONT_DOOR_ROUTER` (flash-lite) and reading on
  `assistantModel()` (Flash), with the same facts: drafts, the list just
  shown, the open question, position, seller facts, memory, listing cost,
  and their Jumia products whose names share words with the message
  (jumia_products). It uses no word rules (`parseActionUnguarded`, safety
  checks only) and no `namesShopProduct` override. Everything after
  (carryOut, confirm taps, credits, logs) is the same. `raw` in
  whatsapp_assistant_log starts with `[front door]`.
- **Questions back**: a `clarify` goes out as buttons (2–3 answers of up to
  20 characters) or a list (longer answers). Bare numbers are never offered,
  since a tapped "10" would read as a count. The outcome is logged
  `asked: <question>`. A tap comes back as `answer:<words>`;
  intake.ts `aiReadable` lets it through as if typed (taps otherwise skip
  the AI), and if the AI hands it back it goes on as plain text.
  `recentConversation` shows it as the words.
- **The owner's first session (web, 8 Oct 17:00–17:52) and what changed**:
  - Replies made claims up in areas without the facts ("our team will
    update your rejected products", "I can't write descriptions"). Now every
    area's reading call gets the seller's facts and `capabilities()`, with
    "there is no team doing things by hand".
  - "The approved ones" picked 2 of 6, because the conversation keeps only
    300 characters of each message. Now the products just listed go in as
    lines with on/off, quality check and stock (`listedLine`, `shopFacts`,
    from session.lastListed). They also count as named for the safety
    checks.
  - The bot's ask without "?" ("please provide the new description text
    for …") is now an open question (`ASKING_RE`), and the router keeps an
    answer in its question's area. A live product under discussion stays
    live_products while drafts wait.
  - "On them and keep their current stock" after "on all the products that
    are off" now passes. `bulkAction` reads the rule and group from the
    previous seller message when this one points back (`lastSellerLine`).
    ON_WORDS takes a leading "on" ("on all…", "on them").
  - "Change the description of X" with no new text means rewrite
    (`CHANGE_WORDS` plus the field named).
  - One message got no reply (the 60 s route limit while Gemini was slow).
    `FRONT_DOOR_LIMITS` now gives sorting 10 s and reading 25 s; after that,
    Flash-Lite reads it in 12 s. `raw` starts with the timings
    (`[front door] 0.9s+6.2s …`).
  - Shop numbers now agree. Bulk `out_of_stock`/`low_stock` count only
    products that are on, like the stock list (it showed 5; the rule changed
    12). `healthEvidence` drops DELETED (436 vs 297). The overview and stock
    list say when changes sent in the last 30 min are still being applied.
  - 9 new cases in the test set (`src: "log 10-08 17:xx"`).
  - After those fixes, the first run (18:18) scored 199/210 (94.8%; 96%
    on the original 203) and 6 of the 9 new cases. The misses were the
    sorting call (flash-lite) sending description messages to listing or
    drafts, and a reply sent as a JSON list of two actions. Now the sorter
    may name a second area (`"also"`) and the reading sees both areas'
    actions and examples. A drafts reading always gets live_products too.
    A list answer is read as its first action.
- **The chat page** (owner: "cover the entire page with the side panel
  still in place"): on /extension/assistant the shell has no title bar or
  padding (`onAssistant`). The chat fills the page beside the sidebar, with
  messages and the composer in a centred `max-w-3xl` column. Phones are
  unchanged (full screen).
- **The chat's type** (owner: "change the font size and style of the chat
  to the same as the one you use here", i.e. Claude's): the chat uses
  `font-chat`, the device's own UI font (tailwind.config.ts), not the site's
  Inter Tight. Text and the composer are 16px with a 1.7 line height. The
  bot's messages are plain text on white with no bubble; the seller's are
  in a soft grey bubble on the right. `• ` and `1. ` lines get a hanging
  indent (`Formatted`).
- **Before "all"**: read the owner's front-door turns in
  whatsapp_assistant_log (`raw like '[front door]%'`). Make each misread a
  test case and run the set with the front door. Then remove the word rules
  in `parseAction` as the current path retires.

### The chat knows the website (owner, 2026-10-07)

"Let the chat know our site very well ... connect WhatsApp, use extension,
regenerate key, the entire flow": lib/whatsapp/site-guide.ts is in the
assistant's prompt, page by page (the dashboard's menu, what each page
holds) and each flow as steps with the pages' own button words (link
WhatsApp, connect Jumia, the extension, regenerating the API key, buying
credits, the 0-credit lock, rejected products, support). Its [keys] are
assistantLinks keys (assistant, calculator_app, connect_jumia,
guide_link_whatsapp and community were added; `listings` is Autofill
Activity). A how-to answer may run to 900 characters (cleanReply cuts at
1,000, under WhatsApp's 1,024 for a message with a button). Keep the guide
in step with the pages when they change.

### More of the Jumia API in chat (owner, 2026-10-07: "do all")

Everything below is an assistant action (lib/whatsapp/assistant.ts:
`parseAction` checks it, `carryOut` runs it), on WhatsApp and in the web
chat alike. Gated by `shop_whatsapp` (Pro and up) except brands and
categories, which are for everyone.

- **Routing fix**: "How many of my products are on / off / live" is the
  overview (`shop`), whatever the AI picked (`SHOP_COUNT` in parseAction).
  Live, the owner got a product search and "I can't tell you".
- **Rules for many products** (`bulk`, `proposeBulkChange` in
  lib/whatsapp/shop.ts): scope all / out_of_stock / low_stock / inactive /
  active / matching words, and one change: stock, price, `price_pct` (each
  product's own price up or down, `pctPrice`: whole prices stay whole),
  `sale_pct` (a sale that % off, with dates; "this weekend" is understood),
  a sale price, ending sales, on/off. `bulkTargets` leaves out what wouldn't
  change (already off, not on sale, price unknown, below Jumia's minimum,
  a sale not below the price) and says how many. Up to `BULK_MAX` (200)
  products, said in full, one `lgrp:` tap, one feed, charged once
  (LIVE_CHANGE_CREDIT_COST). The message must say it's a rule (all, every,
  a percentage); the scope must be in it, and every number. handleGroupTap
  reads and updates in chunks of 100; the worker takes up to 1,000 sent rows.
- **A live product's content** (`content_change`, `proposeContentChange`):
  name, description, highlights (the `short_description` attribute) or
  brand, as the seller wrote it (copied from the message) or rewritten by
  AI (`rewriteContent`, gemini-2.5-flash, only from what Jumia has now,
  restricted words removed), shown before the tap. A brand must be in
  jumia_brands (its code is sent) and not forbidden in the category. The
  tap sends POST /feeds/products/update: the feed takes the WHOLE product,
  so `contentItems` reads the set (GET /catalog/products?sellerSku=) and
  sends every variation with only those fields changed; no price or stock
  (Jumia doesn't take them in an update), and the main image can't change.
  LiveChange kind `content`, so the tap, charge, refund and refusal notice
  are the live-change ones. **Not yet tried live**: the update feed's `id`
  is sent as the variation's id (like the other feeds); Jumia's own example
  repeats one id for two variations, which may mean the set's id.
- **Reports** (`report`, lib/whatsapp/shop-insights.ts `answerReport`):
  best sellers, products with no sale (on, approved, older than the period,
  with stock), restock (runs out within 14 days at its 30-day rate), returns
  and failed deliveries. From the newest 500 orders' items (paced, 35 s
  budget), said when partial.
- **Payouts in detail** (`payout_detail`): every statement of the last 90
  days, or one line by line (`statementLines`). Jumia's statements don't
  list their orders: Vendor Center has those.
- **Before listing** (`brand_check`, `category_info`): a brand in Jumia's
  list (or the close ones), and forbidden / closely checked in the product's
  category; what a kind of product needs (category, required details,
  variation options, commission in their country, a country ban).
- **Shops** (`shops`): GET /shops-of-master-shop. The chat works on the
  connected shop only.
- **Jumia's warehouse** (`warehouse_stock`, `warehouse_order`,
  `warehouse_shipped`): GET /consignment-stock by Jumia's own SKU (new
  `jumia_products.jumia_sku`, read from businessClients[].sku; refreshed
  when missing); POST /consignment-order (shopId, business client, shipping
  date, products by Jumia SKU) and PATCH /consignment-order/{po} (shipped,
  tracking), each offered and recorded in jumia_warehouse_orders and sent on
  the `wh:<id>` tap (`handleWarehouseTap`, routed in intake after the shop
  taps). Jumia has no call to read a delivery order back. Not charged.
- **QC brand answer** (intake.ts `handleQcAnswer`): live, asked "What brand
  is on the product?", the owner asked "what was the old one used" and that
  went to Jumia as the brand. Now a question back (`isQcQuestion`) is
  answered with the brand it was sent with and the question stays; "stop"
  leaves it; a brand not in jumia_brands is said with the close ones and
  not sent (Jumia's own spelling is used when it is).
- Migration 2026-10-07_shop-more.sql (applied). Tests:
  __tests__/jumia-shop-more.test.ts, plus parse tests in
  whatsapp-assistant.test.ts and the web order tests in
  whatsapp-orders.test.ts.

### Feature expansion (when relevant)
9. **Cloud Vision OCR** (Tier 1.2 of GCP plan) — dedicated OCR for packaging text.
   $1.50/1000 images, first 1000 free monthly. Improves spec-text accuracy.
   ~4 hours.
10. **Cloud Translation API** — when expanding to French Jumia markets.
11. **Firebase Cloud Messaging** — push notifications on Jumia approve/reject.
12. **BigQuery + Looker Studio** — analytics pipeline. Pipe Supabase → BigQuery.
13. **WhatsApp order alerts + printable shipping labels** — requested by the
    owner 2026-10-01, parked for later ("will do that in the future"). Nothing
    built yet: the app reads no orders and the WhatsApp client sends no files.
    Planned flow:
    1. Poll new orders per WhatsApp-linked seller (GET /orders?status=PENDING,
       every few minutes; mind the Vercel CPU budget) and alert: "🛒 New
       Jumia order #… [Get shipping label]".
    2. On tap: GET /orders/shipment-providers?orderItemId=… (ask if several),
       POST /v2/orders/pack (assigns the tracking number), POST
       /orders/print-labels (returns `success.labels[].label`, a base64 PDF
       per package), upload it to WhatsApp (POST /{phone-number-id}/media)
       and send it as a document, e.g. `Label-<order>.pdf`.
    3. "Mark ready to ship" button: POST /orders/ready-to-ship.

    **Trial started 2026-10-06** (owner: "use my shop's orders to try the
    label thing"): `/admin/orders` (admin only) lists the signed-in admin's OWN
    shop's orders of the last 30 days and, per order already packed, a Get
    label button (POST /admin/orders/label) that reads the order's items and
    asks Jumia to print the label of the packed ones, then shows the PDF.
    lib/jumia/orders.ts is READ-ONLY on purpose: list orders, read items,
    print labels. Packing and Ready to ship are not in it and must only be
    added with the owner's OK per order: they commit a real customer's order to
    a shipping provider and can't be undone through the API. The owner's shop
    is GEM MALL (admin account user_3ELTiEPmV6I2pYCgXedoxbZsQgh). Spec facts
    (openapi.yaml): GET /orders needs createdAfter/createdBefore (else only
    today's orders; range at most 3 months), `size` up to 300, pages by
    `token`/`nextToken`; GET /orders/items?orderId= -> {orderId, orderNumber,
    items[{id, status, trackingNumber, shipmentType, isFulfilledByJumia,
    product{name, sellerSku}}]}; POST /orders/print-labels {orderItemIds} ->
    201 {success:{labels:[{orderItemIds, countryCode, trackingNumber, label}]},
    error:{orderItems:[{id, response:{code, message}}]}}, `label` a base64 PDF;
    items must be packed (have a trackingNumber), seller-shipped, and share
    country, provider and method. (The real items reply is a list: see
    below.)

    **Result so far (2026-10-06)**: reading works. The owner's shop (GEM MALL,
    Jumia GH) returned its orders to /admin/orders, so the Self Authorization
    token has at least VC - Order Viewer; 3 orders that day, all "Pickup
    Station", none packed. Print-labels (needs VC - Order Manager) is not yet
    tried: it needs a packed order.

    **Packing, built the same day for ONE named order** (owner: #388626919):
    /admin/orders/pack (lib/jumia/orders.ts `getShipmentProviders`,
    `packItems`). Off for every order by default: only numbers in app_settings
    `orders_pack_allowed_numbers` (JSON array, set by hand, see
    lib/jumia/pack-allowlist.ts) get a Pack… button; empty or malformed means
    none. Packing has no undo in the API.

    **Reworked the same day into "Pack order and get label"** (owner: "so we
    can have a button like pack order and download label"), the test bench
    for the WhatsApp button of that name. GET shows the items still to pack
    and only the providers Jumia offers for EVERY one of them (one package
    goes with one provider), and changes nothing. POST puts the whole order
    in ONE package, as Vendor Center does: `{packages:[{orderItems:[id, id…],
    shipmentProviderId, trackingCode?}]}` to POST /v2/orders/pack. The spec
    types `orderItems` as one string (its samples are generated from that),
    but its rules ("all Order Items in a package must belong to the same
    order…") and its reply (each package's `orderItems` is a list) mean a
    list. If Jumia refuses and nothing was packed, the page offers the older
    POST /orders/pack `{orderItems:[{id, shipmentProviderId}]}` (no tracking
    code field), whose sample reply shows 2 items in one package. Guards:
    admin, same-origin, confirmation ticked, allow-listed number from the
    orders list, and the items still to pack must be EXACTLY the ones the
    page showed. After the call the order is read back and the page reports
    what Jumia now has (packages = distinct tracking numbers, "Only 1 of 2
    packed" when partial), then prints the label (download link + Open the
    label).

    **Ready to ship and Cancel, added the same day** (owner: "a button that
    fires for moving order to ready to ship? and cancel order?"):
    /admin/orders/ready-to-ship (POST /orders/ready-to-ship {orderItemIds};
    items must be pending AND packed) and /admin/orders/cancel (PUT
    /orders/cancel {orderItemIds}; items pending or ready to ship). Same
    guards, shared in lib/jumia/order-admin.ts (`loadAllowedOrder`,
    `sameOrigin`): admin, same site, an order switched on in
    `orders_pack_allowed_numbers` (one switch now covers pack, ready to
    ship and cancel), confirmation ticked, items exactly the ones the page
    showed; Cancel also needs the order number typed. Both read the order
    back and report the items' status as Jumia now has it. The cancel
    request has NO reason field, so Jumia records its default reason; to
    give one (out of stock…), cancel in Vendor Center.

    **What the real API and Vendor Center showed (2026-10-06, order
    #388626919, 2 items, Pickup Station):**
    - GET /orders/items?orderId= answers with a LIST, `[{orderId,
      orderNumber, items}]`, not the single object the spec shows.
      `getOrderItems` unwraps it and picks the entry for the order; the pack
      route still takes the order number from the orders list
      (`findOrderNumber`), the shape it was proven against.
    - GET /orders/shipment-providers worked: both items were offered
      "GH-VDO-OWN-East Legon-Station" (a Jumia VDO drop-off station).
    - The owner then packed the order in **Vendor Center**, not through our
      route. Vendor Center's flow: pick a provider from a map ("Select a
      shipment provider close to you", Jumia VDO stations), then it packs
      BOTH items into ONE package (2/2) with one tracking id,
      `DS-GKC-388626919-9965`, and offers CLOSE / SHIPPING LABELS / READY TO
      SHIP. "Shipping labels" downloads the label PDF; "Ready to ship" moved
      the order to Ready to Ship. These are two separate actions, so the
      bot should offer them as two buttons.
    - Open: which pack shape Jumia really accepts for several items in one
      package (v2 with a list, or the older call). Being tried with "Pack
      order and get label" (above); record the result here.
    - ✅ print-labels works through our code: /admin/orders → Get label on
      #388626919 returned the label PDF (owner confirmed). So the Self
      Authorization token has **VC - Order Manager**, and reading items,
      picking the packed ones and turning Jumia's base64 into a PDF are
      proven. After the owner's Vendor Center steps, GET /orders still
      listed the order as PENDING with packedItems 2 of 2, so read the
      items' status, not the order's, to know where an order is.

    **Agreed design for the WhatsApp order flow (owner, 2026-10-06):**
    - **Alert: our own message OR the template.** The bot checks the seller's
      last INBOUND message (whatsapp_message_log). Within 23 hours (a margin
      under WhatsApp's 24): our normal interactive message (free, richer:
      photo, items, buttons). Older: the `jumia_new_order` utility template.
      If a normal message still fails with 131047 (lib/whatsapp/
      delivery-status.ts sees it), resend as the template. Tapping the
      template's quick reply reopens the window, so everything after it
      (station, label PDF, Ready to ship) is normal messages for everyone.
      Same pattern for late QC results: `jumia_listing_update`.
    - **Orders with several products** name them all. Our own message: one
      line per product (name, price, "2 ×" when the same SKU appears as
      several items), first product's photo as the header, "+N more" past
      what 1,024 characters hold. Template: a parameter can't contain a new
      line, so {{2}} is one line, e.g. "LGNT Tablet 4GB RAM, Pedestal Fan
      5-Blade (+1 more)", names shortened, at most 3 named; the full list
      comes in the normal message after the tap.
    - **Stations: live from the API, per seller, per order.** GET
      /orders/shipment-providers?orderItemId= runs with the seller's own
      token and returns the providers associated with THAT seller's shop
      that can take the item (COD-capable for COD orders, economy for
      economy items), so each seller sees their own list, as in Vendor
      Center. It gives only {id, name, trackingCodeRequired}; `name` is the
      code Vendor Center prints under each station
      (`GH-VDO-OWN-East Legon-Station`, `KE-VDO-3PL-Karen-Station`). The
      friendly name, landmark, hours and map are NOT in the API: keep our
      own station directory keyed by that code, filled from Jumia's public
      VendorHub page per country (`vendorhub.jumia.<tld>/vdo-details-and-location/`,
      seen for GH, EG, KE, CI, MA: address, hours, map link, phone) and
      from Vendor Center. Those pages lag (GH's lacked "Agility VDO" and
      "Industrial VDO", which Vendor Center offered), so a code missing
      from the directory still shows, with a short name made from the code,
      and is logged so it gets added. Last-used station first. WhatsApp
      lists hold 10 rows (title 24 chars, description 72).
      **Seen 2026-10-06: the API returns only the station(s) LINKED TO THE
      SHOP.** For both trial orders (5 items) the owner's shop got exactly
      one, GH-VDO-OWN-East Legon-Station, while Vendor Center's map listed
      several (Agility, Spintex, Industrial…). So with one station the bot
      doesn't ask: it names the station (with address and hours from the
      directory) and packs with it. The list appears only when Jumia
      returns more than one. A seller who wants another station changes it
      in Vendor Center; how a shop gets linked to more stations for the API
      is not known yet.
    - **Busy sellers: grouped alerts, one tap, one PDF** (agreed by the
      owner 2026-10-06). Jumia has no order webhooks (the spec's /callback
      is OAuth), so each seller's PENDING orders are polled about every 10
      minutes. One new order since the last alert: the single-order alert.
      Several: ONE message listing them ("🛒 4 new Jumia orders · GHS 812",
      one line per order) with [Pack all & get labels] [Pick orders]. The
      first order after a quiet spell alerts at once; after that at most
      one alert per 30 minutes, later orders joining the next one. Orders
      from 10pm to 7am in the seller's own country's timezone are held
      for one morning message. About 10 orders per message, then "+N
      more"; Pick orders pages a WhatsApp list (10 rows) and gives each
      order its own Pack & get label / Ready to ship / Cancel. Pack all:
      one POST /v2/orders/pack with one package per order, one
      print-labels call, the PDFs MERGED into one document (one page per
      order; needs a PDF library such as pdf-lib), sent as one WhatsApp
      document, then [Ready to ship all] (one ready-to-ship call). A
      failed order never blocks the rest ("3 of 4 packed: #… was cancelled
      by the customer"). "orders" typed any time shows what's waiting.
      **No afternoon or other reminders** (owner said no). Defaults (30
      min, 10pm–7am) may become per-seller settings later.
    - **BUILT 2026-10-06** (owner: "can we test the entire flow using my
      whatsapp"; then "don't switch for only me, it should be gated for the
      respective packages"). lib/jumia/order-flow.ts (Jumia side:
      `waitingOrders`, `packOrders` one package per order in ONE v2 call
      with the order's item ids as a list, `labelsPdf` merging every label
      into one PDF with pdf-lib, `readyToShip`, `cancelOrder`; every change
      read back), lib/whatsapp/orders.ts (messages and taps; stateless: each
      id names its order: `orders`, `orders:packall`, `orders:packat:<station>`,
      `orders:labels`, `orders:rtsall`, `orders:pick`, `order:<id>`,
      `opack:<id>`, `opackat:<id>:<station>`, `olabel:<id>`, `orts:<id>`,
      `ocancel:<id>` then `ocancelyes:<id>`), lib/whatsapp/order-alerts.ts +
      /api/worker/order-alerts (every 10 minutes from the minute-workers
      pg_cron job; table order_alerts; migration
      2026-10-06_order-alerts.sql). Routed in intake.ts before the global
      commands. **Gate: `order_alerts` to see orders and get alerts,
      `shipping_labels` to pack / label / ship / cancel** (Pro and up,
      admins, grants; lib/billing/features.ts). Others get "come with the
      Pro pack" and a See packs button. Template quick replies arrive as
      type "button" with the payload (message-content.ts). The template is
      used only once app_settings `order_alert_template` is set, e.g.
      `{"name":"jumia_new_order","language":"en"}` (WhatsApp account
      1080436151465743, template in review on 2026-10-06); until then an
      alert outside the 24 hours waits for the seller's next message.
      Both are on for their packs since 2026-10-07 (no comingSoon).
    - **The label comes INSIDE its message** (owner, 2026-10-06: "can the
      pdf and its message be one message"): `sendButtonsWithDocument`
      (lib/whatsapp/client.ts), a button message with the merged PDF as a
      document header, "✅ Packed …" as its body and Ready to ship / Pick
      orders as its buttons (`sendWithLabels` in lib/whatsapp/orders.ts).
      Same for Get label(s). No label yet: the same text without the PDF,
      saying so, with a Get label(s) button.
    - **Packing uses the OLDER call** (POST /orders/pack, one call per
      order): live on 2026-10-06 the first bot pack of #355926919 got
      "Jumia answered 400: Tracking Code should not be null" from
      POST /v2/orders/pack, for a station that takes no code. The older
      call has no tracking-code field and Jumia assigns the number, as
      Vendor Center does. v2 only for a station that needs a code (the
      bot turns those away; the admin page asks for the code).
    - **One package per order, always**, and nothing said about it: the
      owner says one label serves all of an order's boxes and sellers
      already know to print it for each box.
    - **Every Jumia country, not just Ghana.** One Vendor API host for all
      (lib/jumia/oauth.ts); the seller's token decides shop and country.
      Nothing in lib/jumia/orders.ts, order-admin.ts or the admin pages is
      Ghana-specific (checked 2026-10-06), and new code must stay that way:
      station codes parsed for any `XX-` prefix; amounts from Jumia's own
      `totalAmountLocal` with the country's formatting (lib/marketing/
      countries.ts, `wholeUnits`); times in the seller's country's
      timezone; Jumia's own text (delivery option, errors) passed through,
      since it may be French or Arabic. Templates: one name, one
      translation per language (WhatsApp allows several languages under a
      name), chosen by the seller's country `marketLanguage` (French for
      CI, SN, MA; Arabic for EG) once the bot speaks those; English
      everywhere until then. Quick-reply payloads are set at send time, so
      the button text's language never matters to the code. Meta's
      template price differs by country (Nigeria and Egypt have their own
      rates; the rest are "Rest of Africa").

    Before building: (a) each seller's own Self Authorization app needs the
    **VC - Order Manager** role, which labels and packing need (the owner's
    has it, proven 2026-10-06; another seller's may not, so the bot must
    name the role on a 403, as describeError does); (b) the owner submits a Meta **utility template**
    for the order alert, since it usually lands outside WhatsApp's 24-hour
    window, where only templates are delivered. QC/rejection alerts
    (`lib/jumia/qc-followup.ts`) arriving hours later have the same problem
    and could use a template too. Labels exist only for seller-shipped
    (Dropshipping) items, not Fulfilled by Jumia. Spec:
    vendorcenter.jumia.com/api-docs/ (`openapi.yaml` → `paths/orders/*.yaml`).

### Marketing
14. **Google Business Profile** — full content drafted in
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
