# PandaWorld 🐼

AI-powered product listing tool that helps vendors auto-generate Jumia (and later Shopify, eBay, Amazon) listings from a single product photo.

## Running locally

```bash
# Install dependencies
npm install

# Start the dev server on port 3002
npm run dev

# Run unit tests
npm test
```

Open [http://localhost:3002](http://localhost:3002). The app redirects to `/dashboard` automatically.

---

## Environment variables

Copy `.env.local.example` to `.env.local` and fill in the values below.

| Variable | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | ✅ | Clerk publishable key (from [clerk.com](https://clerk.com)) |
| `CLERK_SECRET_KEY` | ✅ | Clerk secret key |
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ | Supabase anon/public key (safe to expose) |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Supabase service role key — **server only**, never expose to browser |
| `GOOGLE_API_KEY` | ✅ | Google Gemini API key — used for AI product analysis |
| `JUMIA_CLIENT_ID` | ✅ | Jumia Vendor Center OAuth client ID |
| `JUMIA_CLIENT_SECRET` | ✅ | Jumia Vendor Center OAuth client secret |
| `JUMIA_REDIRECT_URI` | ✅ | Must match the Redirect URI set in Jumia Vendor Center app settings. E.g. `http://localhost:3002/api/jumia/callback` |
| `NEXT_PUBLIC_APP_URL` | ✅ | Full base URL of this app (no trailing slash). E.g. `http://localhost:3002` |
| `PAYSTACK_SECRET_KEY` | For billing | Paystack secret key (for Pro/Business subscriptions) |
| `NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY` | For billing | Paystack public key |
| `QUALITY_SCORE_MIN` | Optional | Minimum quality score (0–100) required to publish. Default: `60` |
| `NEXT_PUBLIC_QUALITY_THRESHOLD` | Optional | Same as above, but readable in the browser for the UI gate. Default: `60` |

### Jumia OAuth redirect URI

In [Jumia Vendor Center → Settings → Applications](https://vendorcenter.jumia.com/settings/applications), set your app's Redirect URI to:

```
http://localhost:3002/api/jumia/callback
```

For production, replace with your deployed URL.

---

## Database setup

Run the following SQL files in order in **Supabase → SQL Editor**:

```
supabase/schema.sql                    # Base tables (listings, variants, stores)
supabase/add_jumia_connections.sql     # OAuth connection table
supabase/add_jumia_categories.sql      # Category + attribute cache tables
supabase/add_jumia_attribute_set_sid.sql  # attributeSet.sid column
supabase/add_jumia_variant_flag.sql    # is_variant flag on attributes
supabase/add_listings_fields.sql       # field_sources + quality_score columns
supabase/seed_phone_attributes.sql     # Demo phone attributes (run for local dev)
```

After connecting your Jumia account, go to **Settings → Integrations → Sync now** to populate real category and attribute data from the Jumia API.

---

---

## Project structure

```
app/
  (main)/          ← all main pages (sidebar layout)
    dashboard/
    listings/
      new/
      [id]/review/
    price-calculator/
    imports/
    settings/
      account/
      billing/
  (onboarding)/    ← onboarding flow (clean layout, no sidebar)
    onboarding/
      channel/
      connect/
  layout.tsx       ← root layout (Inter font, globals)
  page.tsx         ← redirects → /dashboard

components/
  layout/
    Sidebar.tsx    ← left sidebar with nav, workflow links, upsell card
  ui/
    stat-card.tsx         ← gradient stat tiles
    status-pill.tsx       ← draft|processing|pending|live|failed
    marketplace-badge.tsx ← jumia|shopify|ebay|amazon
    stepper.tsx           ← horizontal step indicator
    image-upload-dropzone.tsx ← drag-drop multi-image uploader
    ai-copy-block.tsx     ← AI-generated text with regenerate button
    listing-table.tsx     ← full table with checkboxes, filters, actions
    button.tsx            ← shadcn/ui primitives
    card.tsx
    ... (other shadcn primitives)

lib/
  utils.ts         ← cn(), formatGHS(), formatDate()
  mock/
    listings.ts    ← 24 sample listings
    categories.ts  ← 15 categories with commission rates
    stores.ts      ← 3 connected stores
```

---

## What's mocked vs real

| Feature | Phase 1 (now) | Phase 2 |
|---|---|---|
| Authentication | Mock "logged in as Kelvin" | Real auth (NextAuth or Clerk) |
| AI copy generation | Static mock text | Claude API integration |
| Image enhancement | Simulated | Real AI (background removal, upscaling) |
| Jumia OAuth | Mock (navigates forward after 2s) | Real Jumia Vendor Centre API |
| Publishing to Jumia | Mock (redirects to listings) | Real Jumia Seller API |
| Payments / Stripe | Placeholder plan cards | Real Stripe Checkout |
| Database | None — all data is in-memory | Supabase or PlanetScale |
| CSV import | Placeholder UI | Working parser + bulk create |
| URL import | Placeholder UI | Scraper + AI extraction |

---

## Pages

| Route | Description |
|---|---|
| `/dashboard` | Stats overview + recent listings |
| `/listings` | Full table with search, filters, pagination |
| `/listings/new` | Upload → AI enhance → category → copy → pricing → publish |
| `/listings/[id]/review` | Side-by-side AI preview + editable form |
| `/price-calculator` | Fee breakdown tool (commission + shipping) |
| `/imports` | Bulk CSV import placeholder |
| `/onboarding/channel` | Select selling channel (Jumia enabled, others "coming soon") |
| `/onboarding/connect` | OAuth connect or spreadsheet fallback |
| `/settings/account` | Profile, connected stores, warranty defaults, notifications |
| `/settings/billing` | Plan tiers (Free / Pro / Business) |

---

## Phase 2 roadmap

1. **Real auth** — Clerk or NextAuth with Google/email
2. **Database** — Supabase (listings, users, stores)
3. **Jumia API** — real OAuth + product create/update endpoints
4. **AI pipeline** — Claude API for copy, Replicate/Cloudinary for image enhancement
5. **Stripe billing** — subscription management for Pro & Business
6. **CSV import** — parse Jumia template, bulk-create listings
7. **URL importer** — scrape any product URL, pre-fill the form
8. **Multi-channel** — Shopify, eBay, Amazon integrations
9. **Analytics** — Jumia earnings dashboard with real data

---

## Deploying to Vercel

1. Push this repo to GitHub (or connect the folder directly)
2. Go to [vercel.com/new](https://vercel.com/new)
3. Import your GitHub repository
4. Vercel auto-detects Next.js — no settings needed (the `vercel.json` is already configured)
5. Click **Deploy**

Your app will be live at `https://pandaworld.vercel.app` (or a custom domain you configure).

> **Tip:** For future phases, add environment variables in Vercel's dashboard under *Settings → Environment Variables* (e.g. `ANTHROPIC_API_KEY`, `DATABASE_URL`, `NEXTAUTH_SECRET`).
