# PandaWorld Jumia Autofill

A Manifest V3 Chrome extension that autofills the **Jumia Vendor Center**
Add-Products form from AI. Design background in
[`docs/chrome-extension-plan.md`](../docs/chrome-extension-plan.md).

No build step — it's plain JS/HTML/CSS and loads unpacked as-is.

## What works

- Side panel UI: a connect screen (paste your API key), an "open Jumia" prompt
  when you're not on a Vendor Center tab, a status row (plan + credit balance,
  disconnect), notes box, Autofill button, per-field results/warnings, and a
  Dashboard/Help/Logout footer — see `panel/`.
- Content script that harvests the rendered fields + the uploaded image.
- DOM writers: React-safe inputs, native `<select>`, and CKEditor 5 rich-text.
- Real auth (`pw_live_...` API keys, see `lib/security/extension-keys.ts`) and
  a credit ledger (`lib/billing/extension-credits.ts`) — 5 free credits on
  sign-up, 2.5 spent per real autofill, top-ups via Paystack on the dashboard.
- Backend endpoints: `POST /api/extension/fill` (autofill),
  `GET /api/extension/account` (plan + credit balance for the panel's status
  row).
- **Live AI** (real Gemini reading the uploaded photo) when creds + a photo are
  present; deterministic **mock** fallback otherwise (mock fills don't spend
  credits).

## What's still deferred

- Combobox / click-only dropdown option-picking (e.g. Color family) — the
  extension writes typed inputs, native selects, and rich text.
- Chrome Web Store listing (currently load-unpacked only).

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
4. For local dev, open **Advanced settings** at the bottom and set the API base
   URL to `http://localhost:3002` (it defaults to the production site).
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
- **Backend logs**: your `npm run dev` terminal (look for `[ext/fill]`).

The harvester is heuristic against a DOM we don't control, so **selector tuning
is expected**. The `diagnostics[]` returned from each harvest (shown in the
panel's warnings and logged) tells you exactly which fields/labels matched — use
it to refine `content/content.js` → `findLabel()` / `findFields()` against the
real page.

## Known limitations (Phase 0)

- Field/label detection may miss or mislabel fields on the real Jumia DOM until
  tuned — that's what this POC is for.
- ProseMirror write uses `execCommand('insertHTML')` with a paste-event fallback;
  if Jumia's editor rejects both, we log it and fall back to `innerHTML`.
- Large images are sent as base64 in the POST (fine for localhost; Phase 1 uploads
  to storage and sends a URL to stay under Vercel's body limit).
- `all_frames` is off; if the form renders inside an iframe we'll need to enable it.

## Files

```
manifest.json          MV3 manifest (side panel, host permissions, content scripts)
background/worker.js   opens the panel; owns the API call
content/content.js     harvest (image + fields) + DOM writers (isolated world)
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
