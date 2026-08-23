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
│  └ holds API key (storage.local), calls API                         │
└───────────────────────────────┬─────────────────────────────────────┘
                                 │ HTTPS + PandaWorld API key (Bearer)
                                 ▼
┌────────────── PandaWorld backend (Next.js on Vercel) ───────────────┐
│  NEW  app/api/extension/fill/route.ts                               │
│   1. auth (API key → userId) + quota check (lib/billing/quota.ts)  │
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
  ├─ background worker → POST /api/extension/fill
  │     header: Authorization: Bearer pw_live_...   (from chrome.storage.local)
  │     body:   { image, fields:[...descriptors], notes, market:"GH" }
  │
  ├─ server: key → userId → quota check → Gemini describe → fill-to-schema → policy scrub
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
Authenticated with `Authorization: Bearer pw_live_...` (see §9).

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

## 9. Auth — PandaWorld-issued API key (not Clerk-in-extension)

**Decision: the extension authenticates with a PandaWorld-issued API key the seller
generates in the web dashboard and pastes into the extension** (the ListsGenie pattern).
Clerk stays the login for the *web dashboard*; the *extension* uses the key. This is
simpler to build than `@clerk/chrome-extension` (no MV3 OAuth redirects / session sync) and
matches what sellers already expect from AI extensions.

**Critical distinction — what kind of key this is:**
- ✅ It's a **PandaWorld key** that only authorizes calls to *our* `/api/extension/*`
  endpoints. Those endpoints call Gemini/Vertex server-side. The key **cannot** call an AI
  provider directly and **cannot** touch billing or account settings.
- ❌ It is NOT the seller's own Google/OpenAI key, and NOT our Google/Vertex key. Those
  never go near the extension (see §11).

So shipping this key into the extension does **not** violate "no keys in the extension" —
that rule is about *AI-provider* keys. A scoped, revocable PandaWorld key is safe to hold
client-side.

### How it works
1. Seller signs in to the dashboard (Clerk) → **Settings → API Keys → Generate key.**
2. Dashboard shows the full key **once**: `pw_live_<keyId>_<secret>`. Seller copies it.
3. Seller pastes it into the extension panel → stored in `chrome.storage.local`.
4. Every autofill call sends `Authorization: Bearer pw_live_...`. The endpoint looks the key
   up, resolves the Clerk `userId`, and runs the same quota check as the web app.

### Doing it securely (industry standard)
- **Store only a hash.** Key = `pw_live_<keyId>_<secret>`. Persist `keyId` in plaintext
  (for O(1) lookup) + `sha256(secret)` (HMAC'd with a server pepper). Never store the raw
  key; show it once at creation. We **hash**, not encrypt — we never need to read it back,
  only compare. (Contrast `lib/security/token-crypto.ts`, which *encrypts* Jumia tokens
  because those must be replayed to Jumia.)
- **Scope narrowly:** autofill + check-credits only. No billing, no account mutation, no
  reading other users' data.
- **Client storage:** `chrome.storage.local` (per-extension, on-device). **Not**
  `chrome.storage.sync` — that would replicate the key to Google's cloud across the seller's
  devices, widening exposure.
- **Rotate / revoke / observe:** dashboard lists keys with `last_used_at`; seller can revoke
  or regenerate; optional `expires_at`.
- **Per-key rate limit** (reuse `lib/rate-limit.ts`, keyed by `keyId`). HTTPS bearer header
  only — never the key in a URL query (avoids access logs).
- **Honest UI copy.** "Encrypted & stored locally" (ListsGenie's phrasing) is mostly
  reassurance — `chrome.storage.local` isn't a vault against local malware. The real
  protection is **scope + revocability + server-side hashing**. Say that plainly.

For the **POC only**, auth can be stubbed behind an env flag so we prove the DOM mechanics
first; the key system lands in Phase 1 and is a much smaller build than Clerk-in-extension
would have been.

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

- 🔒 **No AI-provider keys in the extension. Ever.** The Google/Vertex key stays
  server-side; all Gemini calls happen on our backend. (The *PandaWorld* key the extension
  holds is a different thing — scoped, revocable, endpoint-only — see §9.)
- **PandaWorld key handling:** hash-at-rest server-side, scope to `/api/extension/*` only,
  `chrome.storage.local` (never `sync`), rotate/revoke from the dashboard, per-key rate
  limit. Full detail in §9.
- **Minimal host permissions:** `https://vendorcenter.jumia.com/*` (to read/fill the form)
  and `https://pandaworldai.site/*` (to call our API). Nothing broader.
- **Content script scoped** to the Add-Products URL, not all of Jumia.
- Send only the product image + field labels + the PandaWorld key to our server — never the
  seller's Jumia session cookies or credentials.

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
| `lib/billing/quota.ts` (metering) | API-key system: `extension_api_keys` table + dashboard UI + `authenticateExtensionKey()` helper |
| `lib/rate-limit.ts` (per-key limit) | Panel UI (paste-key screen, notes box, autofill button, credits, warnings) |
| Clerk (dashboard login only) | — |

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
| PandaWorld API key leaked (shared screen, malware) | Low–Medium | Scope to autofill only; hash at rest; rotate/revoke + last-used in dashboard; per-key rate limit; optional expiry |

---

## 16. Build plan

**Phase 0 — POC (de-risk the two hard problems). ~2–3 days.** One category (Watches, from
the screenshot). Auth stubbed. Goal: prove we can (a) read the uploaded image off Jumia's
form and (b) write clean SEO copy into the Description + Highlights ProseMirror editors, end
to end against a real Add-Products page.
- `extension/manifest.json`, side panel, content script (harvest + writers), background worker
- `app/api/extension/fill/route.ts` (auth stubbed) wrapping `aiPassA` + a fill pass

**Phase 1 — v1 (shippable). ~1–1.5 weeks.**
- API-key auth: `extension_api_keys` migration, dashboard **Settings → API Keys**
  (generate / show-once / revoke), `authenticateExtensionKey()` helper, paste-key screen in
  the panel
- Quota wiring (`checkQuota`/`incrementUsage`) + per-key rate limit
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
  panel/                     # side-panel UI (paste-key, notes box, Autofill, credits, warnings)
  content/
    harvest.ts               # read uploaded image + rendered field descriptors
    writers.ts               # input / combobox / richtext DOM writers
  background/
    worker.ts                # reads key from chrome.storage.local; calls /api/extension/fill

app/api/extension/fill/route.ts        # thin wrapper over existing pipeline
app/(main)/settings/api-keys/          # dashboard: generate / show-once / revoke keys
app/api/extension/keys/route.ts        # create/list/revoke keys (Clerk-authed, dashboard only)
lib/security/extension-keys.ts         # generate + hash + authenticateExtensionKey(req)
lib/actions/ai.ts                      # + aiFillRenderedFields() pass (small addition)
supabase/migrations/XXXX_extension_api_keys.sql   # id, user_id, key_id, key_hash, key_prefix,
                                                  # name, last_used_at, revoked_at, expires_at
```
