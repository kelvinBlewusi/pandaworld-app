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
list three features not built yet (order alerts, shipping labels and the
fee calculator on WhatsApp), shown like the others with no "soon" label
(owner's call, 2026-10-03; greyed out before). So the pricing FAQ and
Terms §4 name them as not available yet (`comingSoonLabels()`); keep that
while any are.

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
  0.2.53, admins only before)**: the side panel shows a "Polish images"
  section when GET /api/extension/account returns
  `features.imagePolish` (panels before 0.2.53 read `isAdmin`). The button
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

    Before building: (a) confirm the seller's token has the **VC - Order
    Manager** role, which every order call needs (one read-only GET /orders
    with the owner's OK); (b) the owner submits a Meta **utility template**
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
