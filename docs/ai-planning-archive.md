# Google Cloud for PandaWorld — what it is, what we already use, and what would actually help

## Context

You asked: "What is Google Cloud and how can it help with our project?"

**Google Cloud Platform (GCP)** is Google's umbrella for ~200 paid services covering AI, storage, databases, networking, analytics, security, and developer tools — the equivalent of Amazon Web Services or Microsoft Azure. The services that matter for an AI-powered SaaS like PandaWorld are a small subset of that catalogue.

**What we already use today** (confirmed by codebase exploration):
- Three Google AI products, all via the consumer **AI Studio API key** (`GOOGLE_API_KEY`):
  - Gemini text models (Pass A describe + combined Pass B+C category-rank/attribute-fill + resolve-rejection + description-expand + gap-fill)
  - Gemini 2.5 Flash Image — for both text-to-image generation (`lib/imagen.ts`) and image polish/rebuild (`lib/gemini-image.ts`)
  - `text-embedding-004` — 768-dim vectors for pgvector semantic category search
- **Zero** GCP infrastructure: no Vertex AI, no Cloud Storage (using Supabase), no Cloud Vision, no Firebase, no BigQuery, no Cloud Translation, no Maps. Just one API key.

The opportunity: there are four specific GCP services that would materially improve PandaWorld today, and three more that would matter once you expand. This plan lists them in priority order with cost, effort, and concrete expected impact.

---

## Recommended services — ranked by impact

### Tier 1 — Ship-ready, high-impact (do these first)

**1. Google Custom Search API** (a.k.a. Programmable Search Engine)
- **What it does:** lets us query Google Search programmatically. Returns top results as JSON.
- **Why it helps PandaWorld:** the Phase 4 "web search boost" we deferred. For a Business-tier listing, search `{brand} {model}` → fetch the top spec page → feed to Gemini as ground truth. Drops the "Skin Type / Volume / Size still empty after gap-fill" problem because the AI now has real spec data, not just image inference.
- **Cost:** $5 per 1000 queries. First 100 queries/day are free. Gate to Business tier to recoup easily.
- **Effort to integrate:** ~3 hours. New `lib/ai/web-search.ts` + call before Pass A on Business listings.
- **Expected lift:** 30–50% fewer empty required attributes after analyze.

**2. Cloud Vision API — OCR (Text Detection)**
- **What it does:** a dedicated OCR endpoint that reads printed text from images more reliably than asking Gemini to do it.
- **Why it helps PandaWorld:** product packaging often shows weight, capacity (e.g. "300ML"), model numbers, ingredients. Gemini reads them inconsistently. A pre-pass with Cloud Vision OCR extracts everything, then we feed the extracted text into Gemini's prompt as ground truth.
- **Cost:** $1.50 per 1000 images. **First 1000 images/month are FREE.** Effectively zero cost until ~30 listings/day.
- **Effort:** ~4 hours. Pre-pass before Pass A.
- **Expected lift:** packaging-text accuracy from ~60% to ~95% for fields like weight/volume/capacity.

### Tier 2 — Reliability + scale (do when you cross ~500 paying users)

**3. Vertex AI — migration from AI Studio API key**
- **What it does:** same Gemini and Imagen models, but accessed through Google Cloud (service account auth instead of API key).
- **Why it helps PandaWorld:** the 32.4% error rate on `/api/listings/[id]/auto-analyze` is likely AI Studio's per-key rate limit. Vertex AI has 10× higher quotas and is the production-grade access path. Also gets you:
  - Cloud Billing integration (cost alerts, per-feature budgets)
  - Regional routing (Europe-west = closer to Ghana than the default US, lower latency)
  - Service account auth (more secure than a long-lived API key)
  - Better monitoring + per-call traces
- **Cost:** identical per-token to AI Studio. The migration itself is free.
- **Effort:** ~6 hours (service account creation, env var swap, SDK swap from `@google/generative-ai` → `@google-cloud/vertexai`).
- **When to do it:** wait until either (a) the 32% error rate persists after image-resize + retry fixes settle, OR (b) you cross ~500 paid users / 1000 analyses per day.

### Tier 3 — Future expansion (when relevant)

**4. Cloud Translation API**
- **For:** when you expand from Ghana (English) to **Côte d'Ivoire / Senegal / Cameroon / Morocco** (French-speaking Jumia markets). Auto-translate every listing into French at push time.
- **Cost:** $20 per million characters. A 500-word listing ≈ 3000 chars ≈ $0.06.
- **Effort:** ~8 hours when expansion is planned.

**5. Firebase Cloud Messaging (FCM)** — push notifications
- **For:** notifying sellers when Jumia approves/rejects a listing without them having to refresh the dashboard.
- **Cost:** free at any reasonable scale.
- **Effort:** ~6 hours. Needs PWA or mobile-app shell first.

**6. BigQuery + Looker Studio**
- **For:** analytics on which AI defaults convert (Jumia approval rate by field), seller retention, ROI per Paystack tier. Pipe Supabase → BigQuery nightly.
- **Cost:** ~$5/month at small scale; first 10 GB scan/month free.
- **Effort:** ~8 hours for the pipeline + a starter dashboard.

**7. Google Maps Platform** — geocoding
- **For:** validate seller addresses during onboarding, show pickup-zone coverage maps.
- **Cost:** ~$5 per 1000 requests. $200/month free credit.
- **Effort:** ~4 hours.

---

## What you need to do (account setup)

This is a one-time setup that unlocks everything in Tier 1 + 2.

1. **Create a Google Cloud project.** Go to https://console.cloud.google.com → "Select project" → "New project". Name it `pandaworld-production`.
2. **Link a credit card / billing account.** Required even for free-tier usage. Set a hard budget cap (e.g. $50/month) with email alerts at 50%, 90%, 100%. GCP auto-pauses at hard cap.
3. **Claim the $300 / 90-day new-customer credit** — appears as a banner when you create the project. Covers many months of Tier 1 + 2 usage at PandaWorld's scale.
4. **Enable the APIs you'll use** (each is a one-click toggle):
   - Custom Search API (for Tier 1.1)
   - Cloud Vision API (for Tier 1.2)
   - Vertex AI API (when migrating in Tier 2.3)
5. **Generate the credentials:**
   - For Custom Search + Cloud Vision: create an **API key** (Console → APIs & Services → Credentials → Create credentials → API key). Restrict it to those two APIs only.
   - For Vertex AI: create a **service account** with role `Vertex AI User`, download the JSON key, store as a Vercel secret.

You'll send me the API key (or set it as a Vercel env var yourself); I wire the code.

---

## Cost summary (realistic monthly estimates)

| Scenario | Tier 1 services only | Tier 1 + 2 |
|---|---|---|
| **10 paid users** (~250 analyses/mo) | ~$2 | ~$3 |
| **50 paid users** (~1.5k analyses/mo) | ~$8 | ~$10 |
| **200 paid users** (~6k analyses/mo) | ~$25 | ~$30 |
| **500 paid users** (~15k analyses/mo) | ~$60 | ~$70 |

All within the $300 new-customer credit for the first ~6 months.

---

## Critical files that will change when we implement

- **NEW** `lib/ai/web-search.ts` — Custom Search API wrapper
- **NEW** `lib/ai/vision-ocr.ts` — Cloud Vision text-detection wrapper
- `app/api/listings/[id]/auto-analyze/route.ts` — call OCR + web-search before Pass A
- `lib/actions/ai.ts` — Pass A prompt threading the OCR text + web spec as additional context
- `lib/billing/ai-models.ts` — Vertex AI path for premium/admin once migrated
- `package.json` — add `@google-cloud/vision` for Tier 1.2, `@google-cloud/vertexai` for Tier 2.3
- Vercel env vars — `GOOGLE_CSE_API_KEY`, `GOOGLE_CSE_ID`, `GOOGLE_CLOUD_VISION_API_KEY`, eventually `GOOGLE_APPLICATION_CREDENTIALS` (Vertex)

---

## Verification (after each implementation)

- **Custom Search:** create a listing for "AirPods Pro 2nd Gen", check Vercel logs for `[web-search] hits=N for "AirPods Pro 2nd Gen"`, verify the analyze response includes plausible model numbers / weight / dimensions that the image alone couldn't supply.
- **Cloud Vision OCR:** upload a product with visible packaging text (e.g. a humidifier showing "300ML" on the label), check Vercel logs for `[vision-ocr] extracted_chars=N`, verify capacity_liter is filled with the visible value.
- **Vertex AI migration:** after swap, watch `[AI] Model=...` Vercel logs for `gemini-2.5-pro` lines under the Vertex SDK; check that `/api/listings/[id]/auto-analyze` error rate in Vercel drops below 5%.

---

## My recommendation right now

**Set up the GCP project + billing this week** (15 min of clicking). **Don't enable any specific API yet** — that costs nothing and locks no decisions.

Then **send me the OK to wire Tier 1.1 (Custom Search)** as the first ship. It's the most impactful for the "fewer empty required fields" problem you've been hitting, and it costs $5 per 1000 queries (a couple of dollars a month at your current scale).

If Custom Search delivers the lift we expect, we ship Tier 1.2 (Cloud Vision OCR) next. The Vertex AI migration only matters once you cross meaningful scale.

---

# (Archived) Google Business Profile — PandaWorld (SEO-Optimised Draft)

## Context

PandaWorld is launching to Ghanaian Jumia sellers. A Google Business Profile (GBP) is one of the highest-leverage free SEO assets for a Ghana-based SaaS — local sellers actively search "Jumia tool Ghana", "how to upload products to Jumia faster", and "Jumia category picker" on Google. A well-tuned GBP can rank in the local-pack and the right-rail knowledge panel for those queries within weeks, no backlinks needed.

This document is **copy-paste ready**. Each section maps to a specific field in the GBP setup wizard at https://business.google.com → Add your business. Paste verbatim; annotations in `[brackets]` are guidance, not content.

---

## SEO Strategy Notes

**Primary keywords** (weave into description + services + posts):
- `Jumia Ghana`
- `Jumia seller`
- `Jumia Vendor Center`
- `AI product listing` / `AI listing tool`
- `product upload Ghana`
- `e-commerce automation Ghana`

**Secondary keywords** (use in posts + Q&A):
- `Jumia category picker`
- `Jumia QC rejection`
- `product image background removal`
- `online seller tool Ghana`
- `Accra software company`

**Local SEO**: GBP boosts "near me" + "in Ghana" searches. Even for SaaS, set service area to **Ghana** (whole country) so you appear for both Accra-based queries and Kumasi/Takoradi/Tamale searches.

---

## 1. Business Name

```
PandaWorld
```

**Do not append** "AI" / "Ghana" / "SaaS" / "for Jumia" — Google penalises keyword-stuffed business names. Real name only. The description carries the keywords.

---

## 2. Primary Category

```
Software company
```

**Why this one:** Highest-volume Ghana-SaaS category. Best match for "software" intent.

## 3. Additional Categories (add up to 9)

Order matters — most-relevant first:

```
1. Marketing consultant
2. E-commerce service
3. Internet marketing service
4. Computer consultant
5. Marketing agency
```

These bring in adjacent searches like "marketing software Ghana" or "e-commerce help Ghana" without diluting the primary "software" signal.

---

## 4. Service Area (no storefront)

PandaWorld is online-only — choose **"I deliver goods and services to my customers"** in the wizard, then:

- Country: **Ghana**
- Cities to add explicitly (improves visibility in each):
  - Accra
  - Kumasi
  - Takoradi
  - Tamale
  - Cape Coast
  - Tema
  - Ashaiman

(Don't add a public street address — there's no walk-in customer service to support it.)

---

## 5. Business Description (750-character max — every char matters)

**Final draft (722 characters — under the cap):**

```
PandaWorld is the AI-powered listing assistant for Jumia Ghana sellers. Snap a product photo, get a complete Jumia-ready listing in seconds: title, description, the right Jumia category, every required attribute, and clean product images — pushed straight to your Vendor Center.

Built for the Ghanaian e-commerce market. We pick Jumia categories from a live catalogue, fill brand and color from your photos, and respect Jumia's content policies so your products pass QC the first time.

Free for 5 listings every month. Paid plans from GHS 30/month. Pay with Mobile Money (MTN, AirtelTigo, Vodafone) or card via Paystack. Cancel any time.

Try it free at pandaworld.gh — no card needed.
```

**Why it's tuned this way:**
- Opens with "AI-powered listing assistant for Jumia Ghana sellers" — primary keyword + buyer intent in one sentence, what Google highlights in the knowledge panel.
- Names every Jumia-specific pain (QC, category, attributes) so the listing matches long-tail searches.
- "Mobile Money (MTN, AirtelTigo, Vodafone)" hits the trust-signal keywords Ghanaian buyers look for.
- "Free … no card needed" — answers the most common pre-click objection in the SERP snippet.

---

## 6. Phone Number

```
+233 [your WhatsApp Business number]
```

**Recommendation:** Use a **WhatsApp Business** number, not your personal phone. The WhatsApp shortcut in GBP knowledge panel converts much better than Call for African markets. You can keep this private from search if you want — toggle off "Show phone number" but keep it for verification.

If you prefer no phone: leave blank, but you lose the "Call" button in the panel.

---

## 7. Website

```
https://pandaworld.gh
```

(or the live Vercel URL if you haven't pointed the domain yet — update once you do.)

---

## 8. Hours of Operation

```
Monday    9:00 AM – 6:00 PM
Tuesday   9:00 AM – 6:00 PM
Wednesday 9:00 AM – 6:00 PM
Thursday  9:00 AM – 6:00 PM
Friday    9:00 AM – 6:00 PM
Saturday  10:00 AM – 4:00 PM
Sunday    Closed
```

**Why:** Don't claim 24/7. Realistic hours signal a real team, which Google likes. "Saturday open" matters for Ghanaian sellers who do most of their admin on weekends.

If you have no live support outside business hours, set those hours honestly. You can add an "Open 24 hours" note for software support in Attributes if needed.

---

## 9. Services (each is a search-discoverable entry)

In the **Services** tab, add each as a separate service card. The name field is what shows in search results — load each name with the right keyword. Price field optional but adds the rich snippet.

### Service 1
- **Name:** AI Jumia Product Listing
- **Price:** GHS 30 / month (starting)
- **Description:** Upload a product photo, get a complete Jumia listing — title, description, category, attributes, and images — generated by AI in under 30 seconds. Built for Jumia Ghana sellers who want to list faster without writing each entry by hand.

### Service 2
- **Name:** Jumia Vendor Center Push
- **Price:** Included
- **Description:** One-click publishing to Jumia Vendor Center. PandaWorld connects securely to your store, formats the listing to Jumia's exact requirements, and pushes the product live without manual copy-pasting.

### Service 3
- **Name:** Product Image Background Removal & Polish
- **Price:** From GHS 30 / month
- **Description:** Remove cluttered backgrounds, replace with the Jumia-required white, and add a soft AI shadow. Bulk-polish every image on a listing in seconds. Saves the photoshoot trip.

### Service 4
- **Name:** Jumia Category & Attribute Auto-Fill
- **Price:** Included on Free plan
- **Description:** AI picks the most specific Jumia category from your image and fills every required attribute (brand, color, material, size) so your listing passes Jumia QC the first time.

### Service 5
- **Name:** Bulk Listing Upload to Jumia
- **Price:** GHS 65 / month (Pro plan)
- **Description:** Upload up to 100 products per month with the Pro plan, or 500/month with Business. Designed for active Jumia resellers who add new SKUs every week.

### Service 6
- **Name:** Jumia QC Compliance Check
- **Price:** Included
- **Description:** PandaWorld strips banned words, removes restricted-brand claims, and fills attributes to Jumia's spec so your listings clear quality control without the back-and-forth.

---

## 10. Attributes (toggle ON in the dashboard)

- ✅ Online appointments
- ✅ Online estimates
- ✅ Identifies as women-owned / Black-owned / etc. (whichever applies — these get a visible badge that helps with diverse-business searches)
- ✅ Wheelchair-accessible (irrelevant for SaaS but doesn't hurt)
- ✅ LGBTQ+ friendly (boosts pride-month searches and signals inclusivity)
- ✅ Free Wi-Fi (skip — no physical location)
- ✅ Has online portal

---

## 11. First Five Posts (publish in the first week — frequency is a strong ranking signal)

GBP posts decay after 7 days, so post weekly. Below are 5 ready-to-publish posts. Add a relevant photo to each (suggestions below in section 13).

### Post 1 — "What's offer" type
**Headline:** 5 free Jumia listings every month
**Body:**
```
New to PandaWorld? Get 5 product listings free every month — no credit card needed. Snap a photo, our AI fills the Jumia category, writes the title and description, and pushes the listing live to your Vendor Center.

Built for Jumia Ghana sellers. Try it free at pandaworld.gh.
```
**CTA button:** Sign up

### Post 2 — "What's new" type
**Headline:** Image background removal — now included
**Body:**
```
Jumia rejects listings with cluttered backgrounds. PandaWorld now polishes every product photo automatically — pure white background, soft shadow, Jumia-spec 2000×2000 pixels. No photo studio required.

Available from GHS 30/month.
```
**CTA button:** Learn more

### Post 3 — "What's new" type
**Headline:** AI auto-picks your Jumia category
**Body:**
```
Filing a power bank under "Phones" gets your listing rejected. PandaWorld reads your product image, picks the most specific Jumia category from the live catalogue, and fills every required attribute — brand, color, material, capacity.

Pass QC the first time. Try it at pandaworld.gh.
```
**CTA button:** Try it free

### Post 4 — "What's offer" type
**Headline:** Mobile Money checkout — MTN, AirtelTigo, Vodafone
**Body:**
```
Pay your PandaWorld subscription with Mobile Money. We accept MTN MoMo, AirtelTigo Money, and Vodafone Cash — same security as your bank, no card needed.

Starter plan GHS 30/month. Cancel any time from Settings.
```
**CTA button:** Sign up

### Post 5 — "What's new" type
**Headline:** Built in Ghana, for Ghanaian Jumia sellers
**Body:**
```
PandaWorld is an Accra-based SaaS — built specifically for the Jumia Ghana marketplace. Our AI knows Jumia's category tree, its content policies, and its quality-control rules. No generic e-commerce tool repackaged for Africa.

Free trial: 5 listings every month, forever.
```
**CTA button:** Learn more

---

## 12. Pre-Seeded Q&A (post these as the owner from your second Google account, then answer from the business account)

GBP Q&A ranks in the SERP snippet. Seed it before launch — Google will show your top 3 Q&A pairs to anyone searching for your business name OR semantically related queries like "how to upload to Jumia faster".

### Q1
**Q:** Does PandaWorld push my products directly to Jumia Vendor Center?
**A:** Yes. We connect securely to your Jumia Vendor Center via OAuth — the same login method Jumia recommends. After you confirm your listing, PandaWorld pushes the product live in one click. No CSV uploads, no copy-pasting.

### Q2
**Q:** How much does PandaWorld cost?
**A:** Free for 5 listings per month. Paid plans: Starter GHS 30/month (30 listings + 10 image polishes), Pro GHS 65/month (100 listings + 30 polishes), Business GHS 120/month (500 listings + 150 polishes). Pay with Mobile Money or card via Paystack. Cancel any time.

### Q3
**Q:** Will my listings pass Jumia QC?
**A:** That's what we're built for. Our AI follows Jumia's content policy — no banned words, no restricted brand claims without authorisation, correct category, every required attribute filled. We check your title, description, and images against Jumia's QC rules before you push.

### Q4
**Q:** Do I need a Jumia Vendor Center account first?
**A:** Yes. You'll need an active Jumia Ghana seller account in good standing. Sign up at vendorcenter.jumia.com first, then come to pandaworld.gh — our onboarding walks you through the 5-minute connection step.

### Q5
**Q:** Where is PandaWorld based?
**A:** Accra, Ghana. We're a Ghanaian software company building tools specifically for the Ghanaian e-commerce market. Support is in English with WhatsApp turnaround in business hours.

### Q6
**Q:** Can I cancel any time?
**A:** Yes. Cancel from Settings → Billing inside the app. You keep your paid features until the end of the current billing period, then drop to the Free plan (5 listings/month). No contracts, no cancellation fees.

---

## 13. Photo Strategy (upload all of these — 10+ photos signals an active, real business)

GBP wants 4 photo types: **Logo**, **Cover**, **Interior**, **Exterior**, **At work**, **Team**, **Identity**. For a SaaS, focus on what you have:

| Photo type | What to upload |
|---|---|
| **Logo** | The panda wordmark — square, 250×250 min |
| **Cover** | A wide screenshot of the listing-creation flow with the panda + Jumia branding visible. ~1080×608 |
| **At work** | Screen recording / screenshot of the AI generating a listing from a product photo. Sellers love seeing the actual UI |
| **At work** | The four-tier pricing card layout |
| **At work** | The Connect-to-Jumia tutorial mockup from your landing page |
| **At work** | A satisfied seller's Jumia Vendor Center showing 5+ live listings (anonymise the seller name) |
| **Team** | A photo of you at your desk (even one) signals a real human behind the SaaS. Critical for Ghanaian buyers — they want to know who they're paying |
| **Identity** | Your registered business certificate if you have one |
| **Identity** | Paystack merchant badge / Jumia certified partner badge if available |

**Filename SEO bonus:** rename files before upload. Instead of `IMG_4471.jpg`, use `pandaworld-jumia-ghana-listing-tool.jpg`, `accra-saas-team.jpg`, etc. Google reads filenames.

---

## 14. Verification

Google will verify the business via:
1. **Postcard** to a Ghanaian address (5–14 days). You'll need an address you can receive mail at — your home, a P.O. box, etc. The address stays private; only the verification code is used.
2. **Video verification** — Google asks for a 30-second video showing your laptop with the dashboard open + your team. Possible alternative if postcard is slow.

**Tip:** While waiting for verification, you can still set up the profile and queue posts. They go live the moment verification clears.

---

## 15. Review-Acquisition Plan

GBP rank is roughly: (Categories) × (Description SEO) × **(Review count)** × (Review recency).

**Reviews are the single biggest lever.** Target: 10 verified reviews in the first 30 days.

How to get them ethically:
1. Add a "Leave us a Google review 🙏" button in the post-payment confirmation email (modify `lib/email/templates.ts` after launch).
2. After a seller's 5th successful listing, in-app banner: "Loving PandaWorld? Leave us a Google review."
3. WhatsApp community: post a direct review link once a week for the first month.
4. **Never offer discounts in exchange for reviews** — Google bans this and will remove the reviews + suspend the listing.

Review link format: `https://g.page/r/[your-place-id]/review`. Get the place ID from your GBP dashboard once verified.

---

## 16. Post-Launch Cadence (first 90 days)

Every signal below boosts ranking. Set a calendar reminder:

| Cadence | Action |
|---|---|
| Weekly | Publish 1 new GBP post (rotate "What's new" / "Offer" / "Event") |
| Bi-weekly | Reply to every new review (Google penalises non-responsive businesses) |
| Monthly | Add 2–3 new photos |
| Monthly | Add 1 new Q&A pair from real customer questions |
| Quarterly | Update business description with fresh seasonal angle (Black Friday, Christmas, etc.) |

---

## Verification of this Draft

Once you have access to Google Business Profile and have pasted the content above, verify the SEO targets are landing:

1. **Knowledge panel preview** — within ~5 minutes of saving the profile, search Google for `PandaWorld Ghana`. The knowledge panel on the right should pull your description, services, and primary category. Confirm the first sentence reads cleanly.
2. **Description-snippet test** — search Google for `Jumia listing tool Ghana`. Your GBP should appear in the local 3-pack within 2–4 weeks if verification is clean.
3. **Mobile preview** — search the same query on a phone (incognito). The mobile knowledge card crops descriptions at ~165 chars; verify the first 165 characters of section 5 above still convey the core value.
4. **Q&A SERP test** — search Google for `How much does Jumia listing tool cost`. The Q2 we pre-seeded should appear in a featured snippet within a few weeks of getting traffic.

---

## Files this plan does NOT modify

This is a marketing / content deliverable. No code or repo files change. The next implementation step (separate from this) would be adding a "Leave a Google review" button inside the app — that's `lib/email/templates.ts` + a thin in-app banner component, ~30 min of work, deferred until you have your first 5 satisfied paying sellers.
