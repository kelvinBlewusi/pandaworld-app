# PandaWorld Chrome Extension — Jumia Vendor Center Autofill

> Design doc. Status: **proposal, pre-build.** Branch: `claude/jumia-vendor-extension-hwrzah`.
> Purpose: decide the architecture before writing code. Nothing here is committed to yet.

## Context

Today PandaWorld is a standalone web app: seller uploads a photo *on our site*, the AI
pipeline builds a full listing, and we push it to Jumia via the official OAuth API
(`pushProductsToJumia`, `lib/jumia/api.ts:668`).

The proposal is a **second product surface** — a Chrome extension that works *inside*
Jumia Vendor Center (`vendorcenter.jumia.com`). The seller does their listing on Jumia's
own page; our AI rides shotgun and fills the form for them.

**The seller's flow (from the founder's spec + screenshots):**
1. Seller opens `vendorcenter.jumia.com/products/add/new`.
2. Seller uploads product photos **onto Jumia's form** (not ours).
3. Seller picks the **category** — this is what unlocks the full form.
4. Seller (optionally) types extra notes into our panel: price, extra features, anything.
5. Seller clicks **Autofill**.
6. Our AI reads the uploaded photo + the fields that Jumia just rendered, and fills them —
   SEO-optimized, visually formatted, Jumia-QC-compliant.
7. Seller **reviews and submits to Jumia themselves.** We never submit for them.

## Verdict

✅ **Feasible, and we're unusually well-positioned** — the AI "brain" (Gemini pipeline +
Jumia content policy + restricted-word filter + brand/attribute defaults) already exists.
The extension is a **thin DOM client** over that pipeline, not a new AI system.

⚠️ **Two hard technical problems** gate the whole thing (reading the uploaded image off
Jumia's DOM; writing into Jumia's rich-text editors). A one-category POC must prove both
before we invest in auth + full category coverage.

⚠️ **One strategic risk**: Jumia is adding native AI ("AI will suggest the category…",
"Ask Gemini" in-browser). We compete on **Ghana-market tuning + QC-compliance**, not on
"we write descriptions."

---

## 1. The Jumia flow we're automating

Reconstructed from the Vendor Center screenshots. The "Add Products → Single Product" page
has a 3-step left rail:

| Step | Fields | Notes |
|---|---|---|
| **1. Product Information** | 8 image slots (Main + 7), **Name** *, **Category** * | Category is a drawer/tree picker. *"AI will suggest the category based on the product name."* Selecting it **expands the form** to reveal everything below. |
| — expanded — | **Brand** *, Color, Color family, **Weight (kg)** *, **Product description** *, **Highlights** * | Description + Highlights are **rich-text editors** (ProseMirror/TipTap family — same one we use in `components/jumia/RichTextField.tsx`). |
| **2. Variants** | price, stock, variation, seller SKU, GTIN, sale price | **Price and stock live here**, entered by the seller. Confirmed by the API payload shape (`mapListingToJumiaProducts`, `lib/jumia/api.ts:561`). |
| **3. Product Specification** | category-specific attrs (e.g. Sport/activity), **From the Manufacturer**, **What's in the box**, **Product warranty**, **Warranty Address** | Mostly rich-text. Fields vary per category. |

Image rules Jumia enforces: 500×500–2000×2000 px, white background recommended, no
watermarks, ≤2 MB.

**Key insight:** the form is **category-driven and dynamic.** The set of fields for Watches
≠ Phones ≠ Fashion. So the extension cannot hardcode a field list — it must read whatever
Jumia rendered *after* the seller picks a category.

---

## 2. Division of labor (the core design principle)

The seller does the two things that are hard to automate reliably and cheap for a human;
the AI does the tedious, error-prone typing.

| Who | Does | Why |
|---|---|---|
| **Seller** | Upload images, pick category, set price/stock, review, submit | Category picking is a custom tree picker (fragile to automate) **and** it's the schema trigger. Price is a business decision. Submit keeps a human in the loop (ToS + trust). |
| **Extension + AI** | Read image + read rendered fields → fill Name, Brand, Color, Weight, Description, Highlights, spec attributes, warranty, what's-in-box | This is the 15–30 min of tedium per product, and where QC rejections come from. |

---

## 3. Architecture

**Extension = thin client. All AI + all secrets stay on the PandaWorld server.**

```
┌─────────────────────────── Chrome (MV3) ───────────────────────────┐
│  Side panel (chrome.sidePanel)          Content script              │
│  ├ optional notes box (price/features)   injected on                │
│  ├ "Autofill" button                     vendorcenter.jumia.com/*   │
│  └ status / credits                      ├ harvest uploaded image   │
│                                          ├ harvest rendered fields  │
│  Background service worker               └ write values into DOM    │
│  └ holds Clerk session, calls API                                   │
└───────────────────────────────┬─────────────────────────────────────┘
                                 │ HTTPS + Clerk session token
                                 ▼
┌────────────── PandaWorld backend (Next.js on Vercel) ───────────────┐
│  NEW  app/api/extension/fill/route.ts                               │
│   1. auth (Clerk) + quota check (lib/billing/quota.ts)             │
│   2. aiPassA_describeProduct(image)        [reuse, lib/actions/ai] │
│   3. NEW fill pass: given the rendered field schema, return a       │
│      value per field, applying:                                     │
│        - jumia-content-policy.ts (prose rules)                      │
│        - restricted-words.ts (banned terms)                        │
│        - brand → Generic fallback (as in resolveBrand)             │
│        - what's-in-box "1x Item" formatting                        │
│   4. incrementUsage() → returns { fields: [...], warnings: [...] } │
└─────────────────────────────────────────────────────────────────────┘
```

### Why thin client (and NOT "call Gemini from the extension")

- 🔒 **Security — non-negotiable.** Extension code is fully readable by anyone who installs
  it. A Google/Vertex key shipped in the extension is stolen and the bill drained within
  days. Keys stay server-side. (We're already on Vertex AI with service-account auth —
  commits `6022a45`, `94444fa` — which is the right server-side posture.)
- ♻️ **Reuse the pipeline we trust.** Same Gemini calls, same QC-compliance. Extension output
  matches the API-push output exactly.
- 💳 **Billing already exists.** 1 autofill = 1 listing credit against the same per-period
  quota. No new metering to build.

---

## 4. Sequence (one autofill)

```
Seller: uploads photos on Jumia  ─┐
Seller: picks category "Watches" ─┤ form expands
Seller: (optional) types "price 250, water resistant, leather strap"
Seller: clicks Autofill
  │
  ├─ content script harvests:
  │     • the uploaded image (bytes or blob URL) — see §6
  │     • field descriptors: [{label:"Brand", type:"combobox", required:true,
  │                            options:[...]}, {label:"Product description",
  │                            type:"richtext", required:true}, ...]
  │     • seller notes string
  │
  ├─ background worker → POST /api/extension/fill  (Clerk token)
  │     body: { image, fields:[...descriptors], notes, market:"GH" }
  │
  ├─ server: quota check → Gemini describe → fill-to-schema pass → policy scrub
  │     returns: { values: { "Brand":"Casio", "Product description":"<p>…</p>",
  │                          "Highlights":["…","…"], ... },
  │               dropdownPicks: { "Color family":"Black" },
  │               warnings: ["Brand 'Xowba' not in Jumia list → used Generic"] }
  │
  └─ content script writes each value with the right widget handler (§7),
     shows a per-field ✓, seller reviews + edits + submits to Jumia.
```

---

## 5. Backend endpoint contract

`POST /api/extension/fill` — new, thin wrapper over the existing pipeline.

**Request**
```jsonc
{
  "market": "GH",
  "notes": "price 250, water resistant, leather strap",   // optional seller input
  "image": "data:image/jpeg;base64,...",                  // or a fetchable URL
  "fields": [                                              // harvested from the DOM
    { "label": "Name",                "type": "text",     "required": true },
    { "label": "Brand",               "type": "combobox", "required": true,  "options": ["Casio","Fossil","Generic", "..."] },
    { "label": "Color family",        "type": "select",   "required": false, "options": ["Black","White","..."] },
    { "label": "Weight (kg)",         "type": "text",     "required": true },
    { "label": "Product description", "type": "richtext", "required": true },
    { "label": "Highlights",          "type": "richtext", "required": true },
    { "label": "What's in the box",   "type": "richtext", "required": false }
  ]
}
```

**Response**
```jsonc
{
  "values": {
    "Name": "Casio Analog Leather Strap Watch — Water Resistant",
    "Brand": "Casio",
    "Color family": "Black",
    "Weight (kg)": "0.2",
    "Product description": "<p>...</p>",          // HTML for richtext fields
    "Highlights": "<ul><li>...</li></ul>",
    "What's in the box": "<p>1x Watch<br>1x Box<br>1x Manual</p>"
  },
  "warnings": [
    "Brand 'Xowba' not found in Jumia's list — filled 'Generic'. Change if wrong."
  ],
  "creditsRemaining": 63
}
```

Design choices:
- The AI fills **exactly the fields we send it**, keyed by the on-screen label. No hardcoded
  category schema — generalizes to every category automatically.
- Rich-text fields come back as **sanitized HTML** so we can render real bullets/paragraphs
  ("visually appealing").
- `warnings[]` surfaces anything the seller should double-check (brand fallback, a required
  field we couldn't confidently fill) — feeds the "review" step honestly.

---

## 6. Hard problem #1 — reading the uploaded image off Jumia's DOM

The seller uploads to Jumia, not to us, so we must get the bytes from Jumia's page.

**Primary:** hook the file input. Jumia's uploader is (almost certainly) a hidden
`<input type="file">` behind a styled drop zone. Listen for its `change`, grab
`input.files[0]`, read via `FileReader` → base64. One upload, zero extra seller effort.

**Fallback A:** read the preview. After upload, Jumia renders a thumbnail — either a
`blob:` URL (fetchable in-page) or an already-uploaded CDN URL (fetchable with host
permission). Read `<img src>` from the image slot.

**Fallback B:** our own drop zone. If the input is inside a closed shadow DOM or a
cross-origin iframe (can't be read), the panel shows "drop your main photo here." Costs a
second upload but never breaks.

⚠️ Ship with **Primary + Fallback B**. Don't over-invest in Fallback A until we see the real
DOM.

---

## 7. Hard problem #2 — writing values into Jumia's fields

Jumia's form is React + a ProseMirror-family rich-text editor. Naive `el.value = x` or
`el.innerHTML = x` **will not work** — React/ProseMirror overwrite it. Per widget:

| Widget | Fields | Write strategy |
|---|---|---|
| **Plain input** | Name, Weight | Use the **native setter** — `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, val)` then dispatch `input` + `change`. (React tracks its own value; the native setter is the known workaround.) |
| **Combobox / autocomplete** | Brand, Color, Color family | Focus → type the value → wait for the option list → click the option whose text matches. Match AI value against `options[]`; if no match, fall back (Brand → "Generic", same rule as `resolveBrand`). |
| **Rich text (ProseMirror)** | Description, Highlights, What's in box, From Manufacturer, Warranty | Focus the editor → clear → **simulate a paste** of HTML via a synthetic `ClipboardEvent` with a `DataTransfer` carrying `text/html`, or `document.execCommand('insertHTML', …)`. This routes through the editor's own input handling so its internal model updates. Needs real per-editor testing — this is the single fiddliest piece. |

Each writer fires a small visual ✓ so the seller sees what changed.

---

## 8. Field mapping — Jumia form → existing pipeline output

Most Jumia fields map 1:1 to data the pipeline **already produces** (see `buildAttributes`,
`lib/jumia/api.ts:413`). This is why reuse is so high.

| Jumia form field | Existing pipeline source | Widget |
|---|---|---|
| Name | `listing.title` (brand-stripped via `stripBrandFromTitle`) | input |
| Brand | `listing.brand` → `resolveBrand` fallback | combobox |
| Color / Color family | `listing.color` / `listing.color_family` | combobox |
| Weight (kg) | `listing.weight_kg` | input |
| Product description | `listing.description` (auto-expanded 150–400w) | richtext |
| Highlights | `listing.highlights` (line-by-line bullets) | richtext |
| What's in the box | `what_is_in_the_box` intent → "1x Item" format | richtext |
| From the Manufacturer | `from_the_manufacturer` intent | richtext |
| Product warranty / address | `warranty_text` / `warranty_address` defaults | richtext |
| Category-specific attrs | `listing.dynamic_attributes` (AI-detected) | mixed |

The intent-name → schema-field resolution the pipeline already does server-side (AGENTS.md
"Schema-aware default-fill") is the same logic we need here — just keyed on on-screen labels
instead of API attribute names.

---

## 9. Auth

Use **`@clerk/chrome-extension`** (official MV3 support). The extension authenticates
against the same Clerk instance as the web app, so one PandaWorld account works in both
places. The background worker attaches the Clerk session token to every `/api/extension/*`
call; the endpoint authorizes with the same Clerk middleware pattern as the rest of the app.

For the **POC only**, auth can be stubbed (hardcode a dev user / skip the check behind an env
flag) so we can prove the DOM mechanics first. Real Clerk-in-extension is the biggest *new*
build cost and should be phase 2.

---

## 10. Billing

Reuse the existing tier + quota system (`lib/billing/quota.ts`) — **no new billing.**

- 1 successful autofill = 1 listing credit (same unit as a web-app listing).
- `checkQuota()` before the AI call; `incrementUsage()` after success.
- Free tier gets a taste (5/mo); paid tiers get volume. Mirrors the ListsGenie "credits"
  model the founder referenced — but we already have the meter.
- The panel shows remaining credits (from the endpoint response), like ListsGenie's badge.

---

## 11. Security & permissions

- 🔒 **No API keys in the extension. Ever.** All Gemini/Vertex calls server-side.
- **Minimal host permissions:** `https://vendorcenter.jumia.com/*` (to read/fill the form)
  and `https://pandaworldai.site/*` (to call our API). Nothing broader.
- **Content script scoped** to the Add-Products URL, not all of Jumia.
- Send only the product image + field labels to our server — never the seller's Jumia
  session cookies or credentials.
- Store nothing sensitive in the extension beyond the Clerk session Clerk itself manages.

---

## 12. Compliance & trust model

- **Human-in-the-loop by design.** We fill; the seller reviews and clicks Submit. This is
  autofill assistance, not headless automation — materially safer re: Jumia's seller terms
  than a bot that submits on its own.
- Recommend a **one-line read of Jumia's seller ToS** for any explicit anti-automation
  clause before public launch. The review-and-submit model is the mitigation.
- The `warnings[]` array keeps us honest — we tell the seller what we guessed (brand
  fallback, low-confidence fields) rather than silently filling wrong data.

---

## 13. What we reuse vs. build

| Reuse (already exists) | Build (new) |
|---|---|
| `aiPassA_describeProduct` (image → product JSON) | `extension/` MV3 package (manifest, panel, worker) |
| `lib/ai/jumia-content-policy.ts` | Content script: image + field harvester |
| `lib/ai/restricted-words.ts` | Content script: DOM writers (input/combobox/richtext) |
| Brand → Generic fallback (`resolveBrand`) | `app/api/extension/fill/route.ts` (thin) |
| What's-in-box "1x Item" formatter | A "fill exactly these fields" Gemini pass in `lib/actions/ai.ts` |
| `lib/billing/quota.ts` (metering) | Clerk-in-extension wiring (`@clerk/chrome-extension`) |
| Clerk (same instance) | Panel UI (notes box, autofill button, credits, warnings) |

The genuinely new AI work is small: one prompt that takes `{image describe result, field
labels, seller notes}` and returns values keyed by label.

---

## 14. Competitive & monetization

**Why it's worth paying for:** the value isn't "AI writes a description" (any tool does
that, and Jumia is adding its own). The value is **"it fills the form *and the listing
passes Jumia QC the first time*."** Rejections — restricted words, brand-in-title, missing
required attrs, wrong box format — are the real recurring pain, and we've already encoded
every one of those rules. Time saved is the hook; fewer rejections is why they renew.

**The threat (be honest):** Jumia's own AI ("AI will suggest the category…", "Ask Gemini").
If they ship native autofill, a generic version of us is commoditized. Defend with:
- Ghana-market tuning + GHS defaults Jumia's global AI won't prioritize.
- Multi-photo **spec extraction / packaging OCR** (Cloud Vision, already on the roadmap in
  `docs/ai-planning-archive.md` Tier 1.2).
- The **QC-compliance guarantee** above.
- Being faster/better than Jumia's still-early AI.

**Pricing:** extension consumes the same listing quota as the web app. No separate SKU —
one subscription, two surfaces. Reduces churn (more ways to get value from one plan).

---

## 15. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Jumia changes their form DOM → selectors break | ⚠️ High (ongoing) | Harvest by **rendered label**, not brittle CSS paths; keep writers small + isolated; monitor + patch |
| ProseMirror write doesn't "take" | ⚠️ High | De-risk in the POC first; simulate paste through the editor's own event path |
| Image unreadable (shadow DOM / iframe) | Medium | Fallback drop zone in the panel |
| Jumia ships native AI autofill | Medium (strategic) | Compete on QC-compliance + local tuning, not generic copy |
| Jumia ToS anti-automation clause | Medium | Human-submits model; read ToS before launch |
| Clerk-in-extension complexity | Low | Official `@clerk/chrome-extension`; stub for POC |

---

## 16. Build plan

**Phase 0 — POC (de-risk the two hard problems). ~2–3 days.** One category (Watches, from
the screenshot). Auth stubbed. Goal: prove we can (a) read the uploaded image off Jumia's
form and (b) write clean SEO copy into the Description + Highlights ProseMirror editors, end
to end against a real Add-Products page.
- `extension/manifest.json`, side panel, content script (harvest + writers), background worker
- `app/api/extension/fill/route.ts` (auth stubbed) wrapping `aiPassA` + a fill pass

**Phase 1 — v1 (shippable). ~1–1.5 weeks.**
- Real Clerk auth (`@clerk/chrome-extension`)
- Quota wiring (`checkQuota`/`incrementUsage`)
- Combobox writers (Brand/Color) + all rich-text fields across steps 1 & 3
- `warnings[]` surfaced in the panel; per-field ✓
- Multi-category (harvest-by-label makes this mostly free)

**Phase 2 — polish & moat. Later.**
- Packaging OCR (Cloud Vision) for spec accuracy
- Optional background-removal helper for images (PhotoRoom/Gemini — already in codebase)
- Fill the Variants-step price field from seller notes

---

## 17. Open decisions (need founder input)

1. **First POC category** — Watches (matches screenshot) or Phones (richer attribute set →
   harder but more impressive)?
2. **Image source default** — auto-hook Jumia's uploader (smoother) vs. our own drop zone
   (more robust) as the primary?
3. **Chrome Web Store distribution** — public listing, or unlisted/self-hosted `.crx` for a
   controlled beta with early sellers?
4. **ToS check** — who reads Jumia's seller agreement for anti-automation language before
   public launch?

---

## 18. New files (when we build)

```
extension/
  manifest.json              # MV3, sidePanel, host_permissions (vendorcenter + pandaworldai)
  panel/                     # side-panel UI (notes box, Autofill, credits, warnings)
  content/
    harvest.ts               # read uploaded image + rendered field descriptors
    writers.ts               # input / combobox / richtext DOM writers
  background/
    worker.ts                # Clerk session + calls /api/extension/fill

app/api/extension/fill/route.ts   # thin wrapper over existing pipeline
lib/actions/ai.ts                 # + aiFillRenderedFields() pass (small addition)
```
