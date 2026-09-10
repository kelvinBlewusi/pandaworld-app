# PandaWorld Jumia Autofill

A Manifest V3 Chrome extension that autofills the **Jumia Vendor Center**
Add-Products form from AI. Design background in
[`docs/chrome-extension-plan.md`](../docs/chrome-extension-plan.md).

No build step — it's plain JS/HTML/CSS. Loads unpacked as-is for local dev, and this same source is what gets zipped and uploaded to the [Chrome Web Store listing](https://chromewebstore.google.com/detail/pandaworldai-ai-jumia-lis/cnhlcgjodedpppipancmomdfcgijmcae) for real users — there's no separate build/publish pipeline, just re-zip this folder.

## What works

- Side panel UI: a connect screen (paste your API key), an "open Jumia" prompt
  when you're not on a Vendor Center tab, a status row (plan + credit balance,
  disconnect), notes box, Autofill button, per-field results/warnings, and a
  Dashboard/Help/Logout footer — see `panel/`.
- Content script that harvests the rendered fields + up to 4 uploaded product
  photos (several angles of the same product, not just one — see
  `harvestImages()` in `content/content.js`).
- DOM writers: React-safe inputs, native `<select>`, CKEditor 5 rich-text, and
  click-driven comboboxes (Jumia's checkbox/radio-row attribute pickers —
  Color family, Production country, Warranty Duration, etc. — opened, scraped,
  and selected from programmatically; see `enrichComboboxOptions()` /
  `writeCombobox()`).
- Real auth (`pw_live_...` API keys, see `lib/security/extension-keys.ts`) and
  a credit ledger (`lib/billing/extension-credits.ts`) — 10 free credits on
  sign-up, 2.5 spent per real autofill, top-ups via Paystack on the dashboard.
- Backend endpoints: `POST /api/extension/fill` (autofill),
  `GET /api/extension/account` (plan + credit balance for the panel's status
  row).
- **Live AI** (real Gemini reading the uploaded photo) when creds + a photo are
  present; deterministic **mock** fallback otherwise (mock fills don't spend
  credits).
- Price, Sale Price, and the Sale Start/End Date window are all notes-only
  fillable (never guessed from the photo) — a seller who writes e.g. "price
  250, sale price 200 from Sept 20 to Sept 30" in their notes gets all four
  filled from that one sentence. Jumia's own form disables Sale Price until
  Price has a value, and disables Sale Start/End Date until Sale Price does
  — `finalizeAiValues()` in `lib/extension/fill.ts` drops any of these
  top-down if the field it depends on didn't actually get filled, and
  `writeValue()` in `content/content.js` waits briefly for a field to
  become enabled before writing it, since Angular needs a beat after the
  earlier write to lift the `disabled` attribute.
- Warranty Duration mirrors the panel's Advanced Options selection exactly
  (forced server-side, not just AI-guessed — see
  `parseAdvancedWarrantyOptions()` in `lib/extension/fill.ts`). Warranty
  Type stays blank by default — it's never auto-set to "N/A" — and only
  gets a "Repair by Vendor" (or "Replacement by Vendor") default when the
  seller actually set a Warranty duration/address or asked for one in their
  own notes; a real, more specific answer the AI already gave is left as-is.
- Search grounding (Gemini's `google_search` tool, always on for the fill
  call — see `groundWithSearch` in `gemini-client.ts`) is what a photo alone
  can't provide for exact-value fields like Model/Country of origin/
  Certifications: the prompt tells the AI to search once it can identify
  the specific brand/model with confidence (`buildSearchGroundingInstruction()`
  in `content-style-rules.ts`). A "Generic"-branded item with no
  identifiable model has nothing to search for, so those fields staying
  blank in that case is expected, not a gap.

## What's still deferred

- No automated check that Description/Highlights actually cleared their
  1500/800-character minimums (see `lib/ai/content-style-rules.ts`) before a
  result ships — a model that under-delivers despite the prompt instruction
  only gets caught by a human noticing, not by a retry.
- `all_frames` is off in `manifest.json` — if a category ever renders its form
  inside an iframe, the content script won't reach it.
- Jumia's Add/Edit-Products form becomes a 3-step wizard (Product Information
  / Variants / Product Specification) whenever the visible viewport is
  narrowed — including by opening this extension's own side panel, so most
  sellers hit this layout, not a rare case. Every step's fields stay mounted
  in the DOM the whole time (confirmed live), just hidden — `isVisible()` in
  `content/content.js` treats that as visible enough to harvest and fill, so
  plain text/select/rich-text fields on a step the seller hasn't clicked into
  yet still get filled in one pass, no navigation required. Combobox-type
  attribute pickers (Certifications, Material family, Production country,
  Warranty Duration/Type) need their trigger genuinely on-screen to open its
  overlay, so `applyValues()` walks the wizard's own `.action-next` control
  forward (confirmed live, structurally separate from the `.submit` button —
  their class names never overlap) to reach each one, then returns to step 1
  so the seller reviews from the top. A no-op on the classic single-page
  layout, since `.action-next` only gets clicked when it's actually visible.
  `writeCombobox()` fails instantly on a hidden trigger rather than burning
  ~4s per field on a 30-attempt retry loop that can only ever time out —
  confirmed live: without that, 5 hidden comboboxes added ~20s of the page
  visibly doing nothing before the wizard-walk above ever got a turn.

## Run it

### 1. Start the backend
```bash
npm run dev          # http://localhost:3002
```
**Live AI turns on automatically** when (a) a Gemini backend is configured
(Vertex service account or `GOOGLE_API_KEY` in `.env.local`) and (b) a product
photo was uploaded on Jumia so the extension can read it. Otherwise it falls
back to a deterministic **mock** so the loop never hard-fails. Force mock with
`EXTENSION_FORCE_MOCK=true npm run dev`.

> For real AI, **upload an actual product photo on the Jumia page first** — the
> extension reads that image; without it you'll get a mock fill.

### 2. Load the extension
1. Go to `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this `extension/` folder.
3. Click the extension's toolbar icon → the side panel opens.
4. The panel always calls the production site (`https://pandaworldai.site`) —
   there's no in-panel override. For local dev: add `http://localhost:3002/*`
   (or your Vercel preview origin) to `host_permissions` in `manifest.json`,
   change the `apiBase` constant near the top of `panel/panel.js` to match,
   then reload the extension.
5. Paste an API key from `/extension/dashboard` (sign up if you don't have one)
   and click **Connect**.

### 3. Try it on Jumia
1. Open `https://vendorcenter.jumia.com/products/add/new` — the panel switches
   from the "open Jumia" prompt to the autofill form automatically.
2. Upload a product photo and **pick a category** (this expands the form).
3. Optionally type product details, e.g. `price 250, water resistant, leather strap`.
4. Click **✨ Autofill this listing**.
5. Watch the fields populate. **Review, then submit yourself** — the extension
   never submits for you.

> If the panel says "content script not present", **reload the Jumia tab** (the
> content script only injects on load).

## Debugging

Everything logs to the console with a `[PandaWorld]` prefix.

- **Content script logs** (harvest/apply diagnostics): open DevTools **on the
  Jumia page**.
- **Panel logs**: right-click inside the side panel → Inspect.
- **Backend logs**: your `npm run dev` terminal locally, or Vercel's runtime
  logs in production. Look for `[ext/fill]` (the route's own summary — fields
  found/filled, warnings), `[ext/ai-fill]` (which model/backend actually
  served the call and how long it took), and `[gemini] backend=` (confirms
  Vertex vs. AI Studio — check this after any model/backend change in
  `lib/billing/ai-models.ts` or `lib/ai/gemini-client.ts`, since a
  misconfigured `preferBackend` fails silently by falling back rather than
  erroring).

The harvester is heuristic against a DOM we don't control, so **selector tuning
is expected**. The `diagnostics[]` returned from each harvest (shown in the
panel's warnings and logged) tells you exactly which fields/labels matched — use
it to refine `content/content.js` → `findLabel()` / `findFields()` against the
real page.

## Known limitations

- Field/label detection is heuristic against a DOM we don't control (see
  `findLabel()`'s fallback chain in `content/content.js`) — it can still miss
  or mislabel an edge case Jumia's category templates haven't hit yet.
- Rich-text write is CKEditor 5's real `editor.setData()` API, not a DOM write
  (see the "Rich-text note" below) — `execCommand('insertHTML')`/`innerHTML`
  are only the last-resort fallback for when the MAIN-world bridge can't find
  an editor instance on the editable at all.
- Images are sent as base64 in the POST body, up to 4 per autofill — no
  storage-upload path exists, so a very photo-heavy listing means a
  correspondingly large request.

## Files

```
manifest.json          MV3 manifest (side panel, host permissions, content scripts)
background/worker.js   opens the panel; owns the API call
content/content.js     harvest (images + fields) + DOM writers (isolated world)
content/mainworld.js   MAIN-world bridge: calls CKEditor's setData() for rich text
panel/                 side-panel UI (html/css/js)
```

**Rich-text note:** Jumia Vendor Center uses **CKEditor 5**, which ignores DOM
writes. `content/mainworld.js` runs in the page's own JS context (manifest
`"world": "MAIN"`) to call the real `editor.setData()`. The isolated content
script tags the editable with the HTML and dispatches `pw-apply-richtext`; the
bridge writes it and reports back via a `data-pw-done` attribute.
Backend: [`app/api/extension/fill/route.ts`](../app/api/extension/fill/route.ts),
logic in [`lib/extension/fill.ts`](../lib/extension/fill.ts),
tests in [`__tests__/extension-fill.test.ts`](../__tests__/extension-fill.test.ts).
