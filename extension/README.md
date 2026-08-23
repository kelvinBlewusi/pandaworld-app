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
- DOM writers: React-safe inputs, native `<select>`, and ProseMirror rich-text.
- Backend endpoint `POST /api/extension/fill` returning a value per field.
- **Mock AI by default** so the whole loop runs with zero external deps.

## What's deliberately deferred to Phase 1

- Real auth (the API key box is present but **stubbed** server-side).
- Real quota metering.
- Real AI is behind a flag (see below) because `aiPassA_describeProduct()` needs
  an image **URL** (Phase 1 uploads the harvested image to storage first).
- Combobox option-picking (Brand/Color autocompletes) — Phase 0 writes text.

## Run it

### 1. Start the backend
```bash
npm run dev          # http://localhost:3002 (mock AI, no keys needed)
```
Mock mode needs nothing. To try live AI later:
```bash
EXTENSION_POC_REAL_AI=true npm run dev   # also needs a valid image URL + Google creds
```

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
manifest.json          MV3 manifest (side panel, host permissions, content script)
background/worker.js   opens the panel; owns the API call
content/content.js     harvest (image + fields) + DOM writers
panel/                 side-panel UI (html/css/js)
```
Backend: [`app/api/extension/fill/route.ts`](../app/api/extension/fill/route.ts),
logic in [`lib/extension/fill.ts`](../lib/extension/fill.ts),
tests in [`__tests__/extension-fill.test.ts`](../__tests__/extension-fill.test.ts).
