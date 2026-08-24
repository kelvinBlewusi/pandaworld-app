# PandaWorld Jumia Autofill — Phase 0 POC

A Manifest V3 Chrome extension that autofills the **Jumia Vendor Center**
Add-Products form from AI. This is the **Phase 0 proof-of-concept** described in
[`docs/chrome-extension-plan.md`](../docs/chrome-extension-plan.md). Its only job
is to de-risk the two hard problems before we invest further:

1. **Read the uploaded image** off Jumia's DOM.
2. **Write AI values into Jumia's fields** — including the ProseMirror rich-text
   editors (Description, Highlights, What's in the box, etc.).

No build step — it's plain JS/HTML/CSS and loads unpacked as-is.

## What works in Phase 0

- Side panel UI (notes box, Autofill button, per-field results, warnings).
- Content script that harvests the rendered fields + the uploaded image.
- DOM writers: React-safe inputs, native `<select>`, and CKEditor 5 rich-text.
- Backend endpoint `POST /api/extension/fill` returning a value per field.
- **Live AI** (real Gemini reading the uploaded photo) when creds + a photo are
  present; deterministic **mock** fallback otherwise.

## What's deliberately deferred to Phase 1

- Real auth (the API key box is present but **stubbed** server-side).
- Real quota metering.
- Combobox / click-only dropdown option-picking (e.g. Color family) — Phase 0
  writes typed inputs, native selects, and rich text.

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
4. In the panel's **Settings**, confirm the API base URL (`http://localhost:3002`).

### 3. Try it on Jumia
1. Open `https://vendorcenter.jumia.com/products/add/new`.
2. Upload a product photo and **pick a category** (this expands the form).
3. Optionally type notes, e.g. `price 250, water resistant, leather strap`.
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
