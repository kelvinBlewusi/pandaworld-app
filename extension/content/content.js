/**
 * Content script — runs on vendorcenter.jumia.com.
 *
 * Phase 0 proves the two hard problems:
 *   HARVEST → read the uploaded image + the fields Jumia rendered.
 *   APPLY   → write AI values back, including into ProseMirror rich-text.
 *
 * Everything here is heuristic against a DOM we don't control, so it logs
 * verbose diagnostics (console + a diagnostics[] returned to the panel) to
 * make refining against the real page fast. Selector tuning is expected.
 */

(() => {
  const LOG = "[PandaWorld]";

  // ── Capture chosen files per upload slot (for multi-image harvest) ─────────
  // Jumia's Add/Edit form renders several independent file inputs — one per
  // image slot (confirmed live: up to 8 thumbnail slots, several already
  // filled on an Edit page). Keyed by the input ELEMENT so re-uploading into
  // the same slot replaces its entry instead of accumulating duplicates;
  // Map preserves insertion order, which keeps the seller's own upload order
  // (main photo first) when harvestImages() reads it back.
  //
  // What's kept is the current product's own photos only. Vendor Center is
  // a single-page app, so this script outlives each form: the record is
  // cleared when the page moves to another path, and harvestImages() skips
  // a slot that's no longer on the page. And only the seller's uploads
  // count, not the images Polish places (placeImages, below), so polishing
  // again starts from the seller's photos. Without all three, starting a
  // new product in the same tab polished the previous product again, from
  // its photos and its polished images (live, 2026-10-02).
  const capturedFiles = new Map();
  let placingImages = false;
  document.addEventListener(
    "change",
    (e) => {
      const t = e.target;
      if (placingImages) return;
      if (t && t.tagName === "INPUT" && t.type === "file" && t.files && t.files[0]) {
        forgetOtherProducts();
        capturedFiles.set(t, t.files[0]);
        console.debug(LOG, "captured file:", t.files[0].name, t.files[0].type, t.files[0].size);
      }
    },
    true, // capture phase — catches inputs added after load
  );
  let capturedOnPath = location.pathname;
  function forgetOtherProducts() {
    if (location.pathname !== capturedOnPath) {
      capturedOnPath = location.pathname;
      capturedFiles.clear();
    }
    for (const input of Array.from(capturedFiles.keys())) {
      if (!input.isConnected) capturedFiles.delete(input);
    }
  }

  // Every message handler below responds via sendResponse — if the promise
  // it's chained to ever rejects uncaught, sendResponse is never called and
  // the panel hangs waiting forever with no error surfaced (confirmed live:
  // this is exactly how one unguarded writeInput() throw inside applyValues
  // turned into "the whole fill silently did nothing," see writeInput's own
  // comment above for the full chain). Always resolve with SOMETHING.
  const onReject = (sendResponse) => (e) => sendResponse({ ok: false, error: e?.message || String(e) });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "HARVEST") {
      harvest().then(sendResponse).catch(onReject(sendResponse));
      return true;
    }
    if (msg?.type === "APPLY") {
      applyValues(msg.values || {}, { overwrite: !!msg.overwrite })
        .then(sendResponse)
        .catch(onReject(sendResponse));
      return true;
    }
    if (msg?.type === "PLACE_IMAGES") {
      placeImages(msg.images || []).then(sendResponse).catch(onReject(sendResponse));
      return true;
    }
    return false;
  });

  // ── Place images (the panel's Polish images, admin-only prototype) ─────────
  //
  // Puts generated images into the form's image slots the way a file picker
  // would: a File set on each slot's own <input type=file>, then the change
  // event the page listens for. Image i goes in slot i, so the polished
  // main image takes the rough photo's place in the first slot.
  //
  // Jumia only adds the next empty slot once the previous upload is in, so
  // each image waits for its slot to appear. It used to fall back to the
  // last slot there was, which put the 4th image over the 3rd (live,
  // 2026-10-02). Slots are found by position, looked up again each time,
  // because the page re-renders them as uploads land.

  function imageFileInputs() {
    return [...document.querySelectorAll('input[type="file"]')]
      .filter((el) => !el.disabled && (!el.accept || /image|jpe?g|png/i.test(el.accept)));
  }

  async function placeImages(images) {
    if (!imageFileInputs().length) {
      return { ok: false, placed: 0, error: "no image upload slots found on this page" };
    }
    let placed = 0;
    const errors = [];
    for (let i = 0; i < images.length; i++) {
      const input = await waitForSlot(i, 20000);
      if (!input) {
        errors.push(`slot ${i + 1} didn't appear`);
        break;
      }
      try {
        const blob = await (await fetch(images[i].dataUrl)).blob();
        const file = new File([blob], images[i].name || `pandaworld-${i + 1}.jpg`, { type: "image/jpeg" });
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        // Dispatch runs the listeners before it returns, so the capture
        // above sees the flag and leaves this file out.
        placingImages = true;
        try {
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        } finally {
          placingImages = false;
        }
        placed++;
        await sleep(900); // let the page start this upload before the next slot
      } catch (e) {
        errors.push(e?.message || String(e));
        console.warn(LOG, "place image failed:", e);
      }
    }
    return { ok: placed > 0, placed, error: errors[0] };
  }

  /** The image input at position `index`, once the page has rendered it. */
  async function waitForSlot(index, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const input = imageFileInputs()[index];
      if (input) return input;
      if (Date.now() > deadline) return null;
      await sleep(300);
    }
  }

  // ── Harvest ────────────────────────────────────────────────────────────────

  async function harvest() {
    const diagnostics = [];
    const rawFields = findFields();
    await enrichComboboxOptions(rawFields);
    await closeAnyLingeringOverlay();
    const fields = rawFields.map((f) => {
      const field = {
        label: f.label,
        type: f.type,
        required: f.required,
        options: f.options,
        multi: f.multi,
        variantIndex: f.variantIndex,
      };
      // On an Edit-Product page, Name/Description/Highlights may already
      // carry real seller content — hand it to the AI so it can decide to
      // keep, enhance, or replace it, instead of the extension deciding
      // blindly on its own (see isNarrativeLabel above). Included even when
      // the field has an embedded image — the AI never sees or touches the
      // image itself (currentTextValue is plain text only), and
      // mergePreservedImages splices it back into whatever text comes back
      // at write time, so reviewing the text is still safe.
      if (isNarrativeLabel(f.label) && fieldHasValue(f)) {
        const current = currentTextValue(f);
        if (current) field.currentValue = current.slice(0, 4000);
      }
      return field;
    });
    diagnostics.push(`Found ${fields.length} fields: ${fields.map((f) => `${f.label}[${f.type}]${f.required ? "*" : ""}`).join(", ") || "none"}`);

    // When we recognise few/no fields, dump the raw controls on the page so we
    // can see what's actually there and tune the label heuristics.
    if (fields.length < 3) {
      const raw = [...document.querySelectorAll('input, textarea, select, [contenteditable="true"], .ProseMirror')]
        .slice(0, 20)
        .map((el) => {
          const tag = el.tagName.toLowerCase();
          const t = el.getAttribute("type") || (el.isContentEditable ? "contenteditable" : "");
          const ph = el.getAttribute("placeholder") || "";
          return `${tag}${t ? "/" + t : ""}${el.id ? "#" + el.id : ""}${ph ? ` ph="${ph.slice(0, 24)}"` : ""} → label:"${findLabel(el) || "?"}"`;
        });
      diagnostics.push(`Raw controls (first 20): ${raw.length ? raw.join(" | ") : "none found"}`);
    }

    // If we found no rich-text field, dump the first editor's ancestry so we can
    // see exactly how Jumia attaches the label above it.
    if (!fields.some((f) => f.type === "richtext")) {
      const ed = document.querySelector('.ProseMirror, [contenteditable="true"]');
      if (ed) {
        const chain = [];
        let n = ed;
        for (let up = 0; n && up < 6; up++) {
          const cls = (n.className || "").toString().split(/\s+/).filter(Boolean).slice(0, 2).join(".");
          const prev = n.previousElementSibling;
          const prevTxt = prev ? (prev.innerText || "").trim().split("\n")[0].slice(0, 30) : "";
          chain.push(`${n.tagName.toLowerCase()}${cls ? "." + cls : ""}⟨prev:"${prevTxt}"⟩`);
          n = n.parentElement;
        }
        diagnostics.push(`Editor ancestry: ${chain.join(" ▸ ")}`);
      } else {
        diagnostics.push("No contenteditable/.ProseMirror editor found at all.");
      }
    }

    let images = [];
    try {
      const got = await harvestImages();
      images = got.images;
      diagnostics.push(
        images.length
          ? `${images.length} image(s) harvested via ${got.source}`
          : "No image found — use the fallback drop zone",
      );
    } catch (e) {
      diagnostics.push(`Image harvest error: ${e.message}`);
    }

    console.debug(LOG, "harvest diagnostics:", diagnostics);
    // Console's own tree view is awkward to copy text out of — run
    // copy(window.__pandaworldLastHarvest) in DevTools to put this on the
    // clipboard as real text instead.
    window.__pandaworldLastHarvest = { fields, diagnostics };
    return { ok: true, images, fields, diagnostics };
  }

  // Matches Jumia's Edit-Product URL (…/products/edit/<id>) — the only place
  // the CDN-photo fallback below runs. On Add-Products a plain https:// <img>
  // is far more likely to be Jumia's own chrome (logo, nav icons) than a real
  // product photo, so that fallback only makes sense once we know we're on
  // an existing listing.
  const EDIT_PAGE_RE = /\/products\/edit\//i;

  // Sends this many images at most, from whichever single tier below first
  // yields any — a seller's own upload order (main photo first) is preserved
  // since capturedFiles/DOM order both read oldest-first. Bounded rather than
  // unlimited: every extra image is more Gemini input tokens (real per-call
  // cost), and Jumia's own form tops out around 8 slots in practice — a
  // handful of angles is already far more context than the single photo this
  // sent before, without letting one very-photo-heavy listing blow up cost.
  const MAX_IMAGES = 4;

  /** Dedupe a list of <img> elements by src, keeping the first occurrence. */
  function dedupeImgsBySrc(imgs) {
    const seen = new Set();
    return imgs.filter((img) => {
      const src = img.currentSrc || img.src;
      if (seen.has(src)) return false;
      seen.add(src);
      return true;
    });
  }

  async function harvestImages() {
    // Tier 1: files captured straight from the upload <input>s — the most
    // reliable source, and the only one that can't be a same-origin decoy.
    forgetOtherProducts();
    if (capturedFiles.size) {
      const out = [];
      for (const file of capturedFiles.values()) {
        if (out.length >= MAX_IMAGES) break;
        try {
          out.push({ dataUrl: await fileToDataUrl(file), httpUrl: null });
        } catch {
          /* skip this one, try the rest */
        }
      }
      if (out.length) return { images: out, source: "file input" };
    }

    // Fallback 1: freshly-uploaded previews the input listener missed.
    // Restrict to blob:/data: URLs (what an upload preview uses) so we
    // never grab Jumia's logo or a CDN icon.
    const preview = dedupeImgsBySrc(
      [...document.querySelectorAll("img")].filter((img) => {
        const src = img.currentSrc || img.src || "";
        return /^blob:|^data:/i.test(src) && (img.naturalWidth || 0) > 120;
      }),
    );
    if (preview.length) {
      const out = [];
      for (const img of preview) {
        if (out.length >= MAX_IMAGES) break;
        const src = img.currentSrc || img.src;
        try {
          out.push({ dataUrl: await urlToDataUrl(src), httpUrl: /^https?:/.test(src) ? src : null });
        } catch {
          /* try next */
        }
      }
      if (out.length) return { images: out, source: "preview img" };
    }

    // Fallback 2: photos already hosted on Jumia's own dedicated product-image
    // CDN path — confirmed live: uploaded photos land at
    // https://vendorcenter.jumia.com/product-set-images/YYYY/MM/DD/... .
    // That's an unambiguous, POSITIVE signal (nothing else on the page is
    // ever served from that path), so unlike the broader fallback below,
    // it's safe to run on ANY page, not just an Edit-Product one. That
    // matters because Jumia swaps a freshly-uploaded photo's <img src> from
    // a blob: preview to this permanent CDN URL fairly quickly — even
    // mid-session on the Add-Products flow, well before the seller clicks
    // Autofill — and fallback 1 above only ever matches a blob:/data: src,
    // so once that swap happens the photo goes invisible to it. Takes every
    // matching photo (not just the largest), by rendered area.
    const cdnCandidates = dedupeImgsBySrc(
      [...document.querySelectorAll("img")].filter((img) => {
        const src = img.currentSrc || img.src || "";
        return /product-set-images/i.test(src);
      }),
    ).sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight);
    if (cdnCandidates.length) {
      const out = cdnCandidates
        .slice(0, MAX_IMAGES)
        .map((img) => ({ dataUrl: null, httpUrl: img.currentSrc || img.src }));
      return { images: out, source: "product-set-images CDN photo" };
    }

    // Fallback 3: Edit-Product-only, broader heuristic — kept as a last
    // resort in case Jumia's CDN path ever differs from fallback 2's
    // expectation (e.g. a different market/category). There's no blob:/
    // data: preview here — it's already hosted on Jumia's own image CDN as
    // a normal https:// <img src>, on a different origin than ours, so
    // fetching it from here would hit that origin's CORS policy. We don't
    // need to: the fill route already knows how to fetch a plain imageUrl
    // server-side (no browser CORS involved there), so just hand back the
    // URL and skip the local fetch entirely.
    //
    // Production evidence (Vercel logs): naturalWidth > 120 alone wasn't
    // enough — it was consistently picking up a 559-byte resource (an icon
    // or logo, not a photo; a real product photo is many KB). Excludes SVGs
    // (never a real product photo on a catalog like this) and obvious
    // icon/logo/placeholder filename patterns, and — since several images on
    // the page can still pass those filters — takes them by LARGEST rendered
    // area first, on the theory that a real product photo is more prominent
    // than page chrome. Restricted to Edit pages only (unlike fallback 2
    // above): without a real photo present yet, this broader https://-image
    // heuristic risks grabbing Jumia's own logo/chrome on a still-blank
    // Add-Products form.
    if (EDIT_PAGE_RE.test(location.pathname)) {
      const BAD_SRC_RE = /\.svg(\?|$)|logo|icon(?!ography)|placeholder|avatar|sprite|badge/i;
      const candidates = dedupeImgsBySrc(
        [...document.querySelectorAll("img")].filter((img) => {
          const src = img.currentSrc || img.src || "";
          return (
            /^https?:/i.test(src) &&
            (img.naturalWidth || 0) > 200 &&
            !BAD_SRC_RE.test(src) &&
            !img.closest("nav, header, footer, aside")
          );
        }),
      ).sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight);
      if (candidates.length) {
        const out = candidates
          .slice(0, MAX_IMAGES)
          .map((img) => ({ dataUrl: null, httpUrl: img.currentSrc || img.src }));
        return { images: out, source: "existing product photo" };
      }
    }

    return { images: [], source: "none" };
  }

  // ── Field discovery ──────────────────────────────────────────────────────

  /**
   * The repeated DOM containers Jumia renders for a multi-variant listing —
   * one per variant, each holding its own Variation / Seller SKU / GTIN /
   * Quantity / Price controls.
   *
   * Found structurally rather than by class name (which Jumia can rename
   * freely): take every control labelled exactly "Variation" as an anchor,
   * then for each, climb to the largest ancestor that still contains only
   * that one anchor. That ancestor is precisely the variant's own block.
   * Returns [] for a single-variant listing, which keeps the whole
   * variant-qualifying path below inert — zero behaviour change there.
   */
  function findVariantBlocks(rawFields) {
    const anchors = rawFields.filter((f) => /^variation$/i.test(f.label));
    if (anchors.length < 2) return [];
    return anchors.map((anchor) => {
      let node = anchor.el;
      while (node.parentElement) {
        const parent = node.parentElement;
        if (anchors.filter((a) => parent.contains(a.el)).length > 1) break;
        node = parent;
      }
      return node;
    });
  }

  /**
   * Returns [{ label, type, required, options, el, variantIndex }] for each
   * writable field.
   *
   * Fields are de-duplicated by label, which is what a multi-variant listing
   * used to fall over: every variant block repeats the same labels
   * ("Variation", "Seller SKU", "Quantity", "Price"), so only the FIRST
   * variant's fields survived and the rest were silently discarded — the AI
   * never saw them and they were never filled. So when more than one variant
   * block is present, each variant's fields get their label qualified
   * ("Variation (Variant 2)"), making them distinct end to end: distinct in
   * the prompt, in the AI's JSON, and when applyValues maps values back onto
   * elements. Every label match in this codebase is a substring test, so the
   * suffix rides along harmlessly through hintFor, isSellerOwned, and the
   * rest.
   */
  function findFields() {
    const raw = [];
    const nodes = document.querySelectorAll(
      // The last two catch dropdown triggers built as a <div>/<button> rather
      // than an <input> — Jumia's attribute pickers open an overlay from one
      // of these when they aren't a plain text field.
      'input, textarea, select, [contenteditable="true"], .ProseMirror, [role="combobox"], [role="listbox"]',
    );

    nodes.forEach((el) => {
      // The [role="combobox"]/[role="listbox"] additions above match ANY
      // such widget on the page, not just the product form — including
      // Jumia's own site-wide chrome (e.g. its language switcher near the
      // WhatsApp contact button), which was getting swept in and opened
      // during harvest as if it were a real form field. Real product fields
      // are never inside these regions, so this costs nothing to exclude.
      if (el.closest("nav, header, footer, aside")) return;

      const tag = el.tagName.toLowerCase();
      if (tag === "input") {
        const t = (el.type || "text").toLowerCase();
        if (["file", "hidden", "submit", "button", "checkbox", "radio", "image", "search"].includes(t)) return;
      }
      // Skip the inner editable of a ProseMirror we'll also match via .ProseMirror
      if (el.getAttribute("contenteditable") === "true" && el.closest(".ProseMirror") && !el.classList.contains("ProseMirror")) return;

      const label = findLabel(el);
      if (!label) return;

      let type;
      if (el.classList.contains("ProseMirror") || el.getAttribute("contenteditable") === "true") type = "richtext";
      else if (tag === "select") type = "select";
      else if (tag === "textarea") type = "textarea";
      else if (isComboboxEl(el)) type = "combobox";
      else type = "text";

      const required =
        el.required === true ||
        el.getAttribute("aria-required") === "true" ||
        labelIsRequired(el);

      const options = type === "select" ? [...el.options].map((o) => o.text.trim()).filter(Boolean) : undefined;

      raw.push({ label, type, required, options, el });
    });

    // Second pass: qualify per-variant labels, then de-duplicate. Ordering
    // matters — de-duplicating BEFORE qualifying is exactly what dropped
    // every variant past the first.
    const blocks = findVariantBlocks(raw);
    const out = [];
    const seen = new Set();
    for (const f of raw) {
      const vi = blocks.findIndex((b) => b.contains(f.el));
      const label = vi >= 0 ? `${f.label} (Variant ${vi + 1})` : f.label;
      const key = label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...f, label, variantIndex: vi >= 0 ? vi + 1 : undefined });
    }
    return out;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Mirrors lib/extension/fill.ts's SELLER_OWNED — the seller sets these
  // themselves and the AI never touches them, so harvest has no reason to
  // open them either. Category matters most here: its "dropdown" is actually
  // Jumia's full category-browser MODAL, not a small attribute overlay —
  // opening it mid-harvest was popping that whole modal up unprompted.
  const SELLER_OWNED = ["category", "price", "stock"];
  const isSellerOwnedLabel = (label) => SELLER_OWNED.some((k) => label.toLowerCase().includes(k));

  /**
   * Is this element a custom dropdown widget (as opposed to a plain text
   * input)? Jumia's category attribute pickers — Color family, Material
   * family, Production country, Warranty Duration, etc. — are NOT native
   * <select>s: they're a text-styled trigger that opens an overlay of
   * checkbox rows. They don't all carry role="combobox", so we also treat
   * the usual popup ARIA hints, and a readonly input (you can't type into
   * these — you can only pick), as combobox triggers.
   */
  function isComboboxEl(el) {
    const role = el.getAttribute("role");
    if (role === "combobox" || role === "listbox") return true;
    if (el.getAttribute("aria-autocomplete")) return true;
    if (el.hasAttribute("aria-haspopup")) return true;
    if (el.hasAttribute("aria-expanded")) return true;
    if (el.tagName === "INPUT" && el.readOnly) return true;
    return false;
  }

  /**
   * The rendered, clickable option rows of whatever dropdown is currently
   * open. Jumia's attribute dropdowns render each choice as a CHECKBOX ROW
   * (a <label>/<li>/<div> wrapping an <input type=checkbox> + its text) in an
   * overlay — not the role="option"/mat-option pattern — so we match both.
   * Restricted to visible elements so we only ever see the one open overlay,
   * never every checkbox on the page.
   */
  const ARIA_OPTION_SEL = [
    '[role="option"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitem"]',
    '[role="listbox"] li',
    '[role="menu"] li',
    'mat-option',
    '.cdk-overlay-container [role="option"]',
    '.cdk-overlay-container li',
  ].join(",");

  function collectOptionEls() {
    const set = new Set();
    document.querySelectorAll(ARIA_OPTION_SEL).forEach((o) => set.add(o));
    // Checkbox/radio-row pattern: the row (label/li/div) that wraps the input.
    document.querySelectorAll('label, li, [role="menuitemcheckbox"]').forEach((row) => {
      if (row.querySelector('input[type="checkbox"], input[type="radio"]')) set.add(row);
    });
    // Plain single-select list pattern — e.g. Warranty Duration's rows are
    // just text, no ARIA role and no checkbox, so neither branch above ever
    // matched them (confirmed: screenshots of that dropdown show no ☐ at
    // all, unlike Color/Material family). Trust the CONTAINER instead of the
    // row: any short-text LEAF element inside the CDK overlay portal is
    // almost certainly one of the currently-open dropdown's choices — safe
    // to assume there's only the one open overlay there now that
    // closeDropdown()/closeAnyLingeringOverlay() actually close the previous
    // one via its real backdrop before the next opens.
    document.querySelectorAll(".cdk-overlay-container *").forEach((row) => {
      if (row.children.length > 0) return; // leaf rows only, not wrappers
      if (row.matches("input, textarea, button, svg, path")) return;
      const t = (row.innerText || row.textContent || "").trim();
      if (t && t.length <= 40) set.add(row);
    });
    return [...set].filter(isVisible);
  }

  const optText = (o) => (o.innerText || o.textContent || "").trim().toLowerCase();

  /** The open-overlay option row matching `target` (exact text, then contains). */
  function matchOption(target) {
    const els = collectOptionEls();
    return (
      els.find((o) => optText(o) === target) ||
      els.find((o) => {
        const t = optText(o);
        return t && (t.includes(target) || target.includes(t));
      }) ||
      null
    );
  }

  /**
   * Type into a search/filter box inside the open overlay, if one exists —
   * needed for long lists (Production country, Color family, Material
   * family: dozens to 200+ entries) which are very likely VIRTUALIZED —
   * only the currently-visible slice exists in the DOM at all, so a target
   * far down the list is literally not there to match against until
   * something filters the list down. Scrolling wouldn't help without
   * knowing exactly how far to go; filtering does. Broadened beyond a
   * specific container class selector, which was probably too narrow to
   * find Jumia's real search box: any visible, non-checkbox/radio text
   * input that isn't the trigger itself is a candidate, preferring one
   * that's actually inside an overlay-ish container over a stray match
   * elsewhere on the page.
   */
  function filterOpenOverlay(value, triggerEl) {
    const candidates = [...document.querySelectorAll('input[type="text"], input[type="search"], input:not([type])')]
      .filter((el) => el !== triggerEl && isVisible(el) && !el.readOnly);
    const box =
      candidates.find((el) => el.closest('.cdk-overlay-container, [role="dialog"], [role="listbox"], [role="menu"]')) ||
      candidates[0];
    if (box) {
      try { writeInput(box, value); } catch { /* ignore */ }
      return true;
    }
    return false;
  }

  /**
   * The scrollable viewport inside the currently-open overlay, if any — the
   * smallest visible element whose content overflows it (an ancestor
   * wrapper can also overflow, so prefer the innermost one). This is
   * Angular CDK's virtual-scroll viewport when the list is virtualized.
   */
  function scrollableOverlayEl() {
    const candidates = [...document.querySelectorAll('.cdk-overlay-container *, [role="listbox"] *, [role="dialog"] *')]
      .filter((el) => isVisible(el) && el.scrollHeight > el.clientHeight + 4);
    candidates.sort((a, b) => a.clientHeight - b.clientHeight);
    return candidates[0] || null;
  }

  /**
   * Nudge a virtualized list's own scroll position down a bit and fire a
   * scroll event, so the next poll sees a freshly-rendered slice. This is
   * the fallback for when there's no reachable search box: a CDK virtual-
   * scroll viewport only renders the currently-visible portion of a long
   * list into the DOM — an option far down a 200-item list (Production
   * country) or a long themed list (Color/Material family) literally isn't
   * there to match against until scrolled into view. The proper fix is
   * Angular's own scrollToIndex() API, but that's only reachable from
   * inside the Angular app itself, not from a content script — this is
   * the standard workaround. Returns false once there's nowhere further to
   * scroll, so the caller knows to stop trying.
   */
  function nudgeScroll(viewport) {
    if (!viewport) return false;
    const before = viewport.scrollTop;
    viewport.scrollTop = Math.min(viewport.scrollTop + 320, viewport.scrollHeight);
    viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
    return viewport.scrollTop > before;
  }

  /** Open a dropdown trigger the way a real user click would. */
  function openDropdown(el) {
    el.focus();
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.click();
  }

  // The semi-transparent backdrop a framework's overlay system inserts to
  // catch "click outside to close" — Angular Material's CDK is the pattern
  // Jumia's checkbox-row dropdowns match. It is NOT a descendant of <body>,
  // so a synthetic click dispatched at body never reaches a listener bound
  // directly to the backdrop element itself — the overlay just silently
  // never closes. That's the real cause behind three symptoms at once:
  // dropdowns kept stacking open, options never got checked (matchOption()
  // was hitting the wrong still-open overlay), and the page stayed frozen
  // after a fill — an invisible, click-swallowing backdrop was still there
  // until the seller happened to click directly on it.
  const BACKDROP_SEL = '.cdk-overlay-backdrop, [class*="backdrop"], [class*="overlay-backdrop"]';
  const visibleBackdrops = () => [...document.querySelectorAll(BACKDROP_SEL)].filter(isVisible);

  /**
   * Close any open overlay so the next field is reachable — and actually
   * WAIT for it to be gone (poll, don't just fire-and-hope) before
   * returning. Clicks the real backdrop element directly (see above), with
   * Escape + a body click as a fallback for anything that isn't CDK-based.
   */
  async function closeDropdown(el) {
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    await sleep(40);
    for (const bd of visibleBackdrops()) {
      bd.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      bd.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      bd.click();
    }
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    document.body.click();
    el.blur();
    for (let attempt = 0; attempt < 8; attempt++) {
      if (!collectOptionEls().length && !visibleBackdrops().length) return;
      await sleep(80);
    }
  }

  /**
   * Last-resort sweep, run once at the very end of a whole harvest or apply
   * pass regardless of how each individual closeDropdown() call went — so a
   * per-field close that silently failed can never leave the real page
   * frozen behind a leftover backdrop after we're done.
   */
  async function closeAnyLingeringOverlay() {
    for (let attempt = 0; attempt < 5; attempt++) {
      const backdrops = visibleBackdrops();
      if (!backdrops.length && !collectOptionEls().length) return;
      document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
      backdrops.forEach((bd) => bd.click());
      await sleep(100);
    }
  }

  /**
   * A combobox's option list renders lazily in an overlay only once it's
   * opened — unlike a native <select>, there's no `.options` to read
   * up front. Best-effort: open each combobox briefly, scrape whatever
   * appears, close it again. This lets the AI (and finalizeAiValues' snap-
   * to-option check) work with Jumia's real choices instead of guessing free
   * text that then has nothing to click during APPLY.
   *
   * Skips seller-owned fields entirely (see SELLER_OWNED above) — they're
   * never AI-filled, so there's no reason to open them, and Category's
   * "dropdown" is actually Jumia's full category-browser modal.
   */
  async function enrichComboboxOptions(fields) {
    for (const f of fields) {
      if (f.type !== "combobox" || isSellerOwnedLabel(f.label)) continue;
      try {
        openDropdown(f.el);
        await sleep(180);
        const optionEls = collectOptionEls();
        const texts = optionEls
          .map((o) => (o.innerText || o.textContent || "").trim())
          .filter(Boolean);
        // Capped well above any real Jumia attribute list (the largest is
        // a ~195-country picker) — confirmed live: the previous 80-item cap
        // silently cut off Production country well before it got there, so
        // the AI could never even see, let alone pick, most real countries.
        if (texts.length) f.options = [...new Set(texts)].slice(0, 250);
        // Checkbox rows mean the widget accepts MORE than one choice
        // (Color family, Material family, Certifications); radio rows mean
        // exactly one. Recorded so the prompt can invite several values for
        // the former and insist on a single one for the latter — Color
        // family and Material family had never once been filled, partly
        // because the prompt only ever said "choose ONE of".
        f.multi = optionEls.some(
          (o) => o.matches?.('input[type="checkbox"]') || o.querySelector?.('input[type="checkbox"]'),
        );
      } catch {
        /* best effort — leave options undefined, AI falls back to free text */
      } finally {
        await closeDropdown(f.el);
      }
    }
  }

  // Must match findFields()'s own node query (which also picks up <div>/
  // <button> role="combobox"/"listbox" triggers, not just <input>) — these
  // two selectors decide where a label-boundary walk stops so a field never
  // steals its neighbour's label. When findFields() started discovering
  // div-based triggers but this list wasn't updated to match, the walk
  // could sail straight past a "Color family"/"Material family" trigger
  // (built as a div, not an input) as if it weren't a control at all,
  // grabbing "Color"/"Main material"'s label instead — the exact "Color vs
  // Color family" collision this code was already patched for once, now
  // regressed for any trigger that isn't a plain <input>.
  const CONTROL_SEL = 'input, textarea, select, .ProseMirror, [role="combobox"], [role="listbox"]';
  // Neighbours whose presence, when visible, ends the backward label walk.
  const STOP_SEL = 'input, textarea, select, .ProseMirror, [contenteditable="true"], [role="combobox"], [role="listbox"]';
  // A rich-text editor's own aria-label ("Editor editing area: main") is NOT
  // the field label — ignore these so we find the real one above it.
  const BAD_ARIA = /editor editing area|rich.?text|prosemirror/i;

  /**
   * A <label>'s OWN text, with every control's rendered content stripped out
   * first. Reading a wrapping <label>'s innerText directly is wrong whenever
   * the label has no separate heading element inside it: the label then
   * renders as whatever the control is currently displaying — confirmed live
   * across a whole listing, where Production country, Gender, Season, Hair
   * Type and Skin Type all reported their own SELECTED VALUE ("China",
   * "Female", "All Seasons", "All Hair Types", "All skin types") as their
   * label in the extension's results panel, and an EMPTY dropdown reported
   * its "Ex: …" placeholder instead. Both break the same way: the AI is
   * handed a field whose name is really a value, so it can't fill the real
   * attribute, and the seller sees nonsense field names in the panel.
   *
   * Cloning and removing the controls leaves only the text the label itself
   * contributes, which is the actual field name (or nothing, in which case
   * the caller falls through to the positional strategies below).
   */
  const LABEL_STRIP_SEL =
    'input, textarea, select, option, button, svg, .ProseMirror, [contenteditable="true"], ' +
    '[role="combobox"], [role="listbox"], [role="option"], [role="button"], [role="toolbar"]';

  function labelOwnText(labelEl) {
    if (!labelEl) return null;
    const clone = labelEl.cloneNode(true);
    clone.querySelectorAll(LABEL_STRIP_SEL).forEach((n) => n.remove());
    const raw = (clone.textContent || "").replace(/\s+/g, " ").trim();
    if (!raw) return null;
    const first = raw.split("\n")[0].trim();
    if (first.length < 1 || first.length > 40) return null;
    if (looksLikePlaceholderJunk(first)) return null;
    return clean(first);
  }

  /**
   * What the control is currently DISPLAYING — its selected option, typed
   * value, or (for a div-based dropdown trigger) its rendered text. Used
   * only by acceptLabel's value-echo guard below.
   */
  function controlOwnValue(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "select") return (el.options?.[el.selectedIndex]?.text || "").trim();
    if (tag === "input" || tag === "textarea") return (el.value || "").trim();
    return (el.innerText || el.textContent || "").trim();
  }

  /**
   * The single gate every label candidate passes through, whichever strategy
   * produced it. Two rules earn their place from live evidence:
   *
   *  - Length + placeholder-junk, previously enforced everywhere EXCEPT the
   *    aria-label branch. That gap let a 70-character placeholder ("Ex:
   *    Sevice center - Lagos [Type of warranty offered, …]") through as
   *    Warranty Type's "label" — no other strategy could have produced it,
   *    since they all cap at 40 characters.
   *  - The value-echo guard: a candidate identical to what the control is
   *    currently showing is a value, not a name. Production country,
   *    Warranty Duration, Gender, Hair Type, Season and Skin Type all
   *    reported their own selected value ("China", "N/A", "Female", "All
   *    Hair Types", "All Seasons", "All skin types") as their label, so the
   *    AI never saw the real attribute names — which is also why Color
   *    family and Material family were never filled: their labels came
   *    through as Jumia's "Ex: …" placeholder rather than their real names.
   */
  function acceptLabel(raw, el) {
    const text = (raw || "").replace(/\s+/g, " ").trim();
    if (!text) return null;
    const first = text.split("\n")[0].trim();
    if (first.length < 1 || first.length > 40) return null;
    if (looksLikePlaceholderJunk(first)) return null;
    const cleaned = clean(first);
    if (!cleaned) return null;
    const own = clean(controlOwnValue(el));
    if (own && own.toLowerCase() === cleaned.toLowerCase()) return null;
    return cleaned;
  }

  /** Best-effort label resolution for a control. */
  function findLabel(el) {
    const isRich = el.classList.contains("ProseMirror") || el.getAttribute("contenteditable") === "true";

    // 1. <label for> association — via labelOwnText, since a <label for> can
    // just as easily wrap the control it names (see labelOwnText above).
    const forLabel = el.labels && el.labels[0] ? labelOwnText(el.labels[0]) : null;
    if (forLabel) return acceptLabel(forLabel, el);
    // 2. aria-label / aria-labelledby — but never a rich-text editor's own aria.
    const aria = el.getAttribute("aria-label");
    if (aria && !(isRich && BAD_ARIA.test(aria))) {
      const ok = acceptLabel(aria, el);
      if (ok) return ok;
    }
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const ref = document.getElementById(labelledby);
      if (ref && ref.innerText.trim() && !BAD_ARIA.test(ref.innerText)) {
        const ok = acceptLabel(ref.innerText, el);
        if (ok) return ok;
      }
    }
    // 3. Wrapping <label> — again via labelOwnText, so we get the label's own
    // text rather than whatever the control it wraps happens to be showing.
    const wrap = labelOwnText(el.closest("label"));
    if (wrap) {
      const ok = acceptLabel(wrap, el);
      if (ok) return ok;
    }

    // 4. Walk backwards in document (reading) order until we hit a label-like
    // snippet. Most structure-agnostic match; stops if it reaches another form
    // control, so it never steals the previous field's label. This is what
    // reliably finds "Product description" above a ProseMirror toolbar.
    const docOrder = previousLabelInDocOrder(el);
    if (docOrder) {
      const ok = acceptLabel(docOrder, el);
      if (ok) return ok;
    }

    // 5. Find the field's "cell" — climb while the parent still holds just this
    // one control — then take the closest label-like text before the control.
    // This keeps each field's label to itself (fixes Color vs Color family) and
    // walks a ProseMirror editor up past its toolbar to "Product description".
    let cell = el;
    while (cell.parentElement && countControls(cell.parentElement) <= 1) {
      cell = cell.parentElement;
    }
    const inside = closestLabelBefore(cell, el);
    if (inside) {
      const ok = acceptLabel(inside, el);
      if (ok) return ok;
    }

    // 6. Nearest preceding sibling of the cell.
    let sib = cell.previousElementSibling;
    for (let hop = 0; sib && hop < 4; hop++) {
      const ok = acceptLabel(labelTextOf(sib), el);
      if (ok) return ok;
      sib = sib.previousElementSibling;
    }
    return null;
  }

  /** Previous element in whole-document reading order (deepest-last descent). */
  function prevEl(node) {
    if (node.previousElementSibling) {
      let n = node.previousElementSibling;
      while (n.lastElementChild) n = n.lastElementChild;
      return n;
    }
    return node.parentElement;
  }

  /**
   * Walk backwards from `el` in document order, returning the first label-like
   * text. Stops (returns null) on reaching another form control, so a field
   * never borrows the previous field's label.
   */
  function previousLabelInDocOrder(el) {
    let node = prevEl(el);
    for (let steps = 0; node && steps < 400; steps++) {
      // Stop only at a VISIBLE neighbouring field (control or editor) — hidden
      // source textareas that editors keep around must not stop the walk.
      if (
        node !== el &&
        node.matches &&
        node.matches(STOP_SEL) &&
        !node.contains(el) &&
        isVisible(node)
      ) {
        return null;
      }
      const t = labelTextOf(node);
      if (t) return t;
      node = prevEl(node);
    }
    return null;
  }

  /** Count distinct form controls under a node (ProseMirror counts as one). */
  function countControls(node) {
    let n = 0;
    node.querySelectorAll(CONTROL_SEL).forEach((c) => {
      if (c.getAttribute("contenteditable") === "true" && !c.classList.contains("ProseMirror")) return;
      n++;
    });
    return n;
  }

  /** The label-like element inside `cell` that sits closest before `el`. */
  function closestLabelBefore(cell, el) {
    const cands = cell.querySelectorAll("label, legend, span, div, p, h1, h2, h3, h4, h5, h6, strong, b");
    let best = null;
    for (const c of cands) {
      // Keep only candidates that appear BEFORE the control in document order.
      if (c.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
        const t = labelTextOf(c);
        if (t) best = t; // last match before el = closest
      }
    }
    return best;
  }

  // Jumia's Add/Edit-Products form renders as a 3-step wizard (Product
  // Information / Variants / Product Specification) whenever the visible
  // viewport is narrowed — confirmed live, Sep 2026: this includes opening
  // our OWN side panel or DevTools, so most sellers using this extension hit
  // it, not a rare device-specific case. Confirmed via a live console check
  // that Jumia keeps every step's fields mounted in the DOM at all times
  // rather than destroying/recreating them per step: `document.querySelector
  // ('input[formcontrolname="variation"]')` resolved a real element while
  // the Variants step wasn't active, just with a zero-size
  // getBoundingClientRect() (its ancestor is display:none, not removed).
  // Without this, labelTextOf() below (isVisible()'s only real gatekeeper
  // for label discovery, since Jumia never uses a real <label> element —
  // every field caption here is a styled <p class="label">, found only via
  // the doc-order/closest-before fallback strategies in findLabel(), both of
  // which route through isVisible()) rejects every hidden step's own label
  // text, so findFields() drops the field entirely before the AI ever sees
  // it — confirmed live via screenshot: an entire "Variants" step (Variation,
  // Seller SKU, GTIN Barcode, Quantity) and "Product Specification" step
  // (Material family, Model, Warranty Duration, …) silently never got filled.
  // Treating a hidden-only-because-of-this-wizard element as "visible enough
  // to harvest and write" fixes that — the actual writers (writeInput/
  // writeSelect/writeRichText) have no visibility gate of their own and work
  // fine on a display:none element already, since they just set the native
  // value and dispatch the events Angular's reactive forms listen for.
  // isVisible()'s OTHER callers (open-overlay/backdrop detection) are
  // unaffected: a hidden step's controls can never be "the currently open
  // overlay" in the first place, so this relaxation never changes their
  // result. (One real gap this doesn't close: combobox-type attribute
  // pickers — Certifications, Material family, Production country, Warranty
  // Duration/Type — still need a genuinely visible, on-screen trigger to
  // open their overlay; clicking one while hidden may silently do nothing,
  // same as it silently does nothing today by never being attempted at all.)
  //
  // BUG FIXED HERE (confirmed live via console dump, Sep 2026): the first
  // version of this checked `elm.closest(STEPPER_SECTION_SEL)` — true for
  // ANY descendant of a step container, not just "the step itself is
  // hidden". Every step's CKEditor fields (Description/Highlights on
  // Product Information; From the Manufacturer/etc. on Product
  // Specification) have their OWN legitimately-hidden toolbar internals — a
  // closed "Insert media" popup form, a collapsed heading dropdown — that
  // are hidden for a real, unrelated reason even while their step IS the
  // one currently on screen. Blanket-trusting any step-container descendant
  // made those register as "visible" too: a hidden "Media URL" popup input
  // started getting harvested as a bogus real field, and the noise it added
  // to the label-discovery walk knocked Description/Highlights off the
  // field list entirely — confirmed live: neither appeared in the 28-field
  // harvest at all. Gating on the STEP CONTAINER's own rect (not the
  // element's ancestor chain generally) fixes this: the override only fires
  // when the whole step is the hidden one, so a currently-active step's own
  // closed popups/dropdowns still correctly fail isVisible() exactly like
  // before this feature existed.
  const STEPPER_SECTION_SEL =
    "#variants, #product-specification, #product-information, " +
    ".product-variation, .product-specification, .product-information";

  /**
   * Return trimmed label text from an element, or null if it isn't label-like:
   * skips anything that contains a form control, a button, a toolbar, or an
   * icon (i.e. field wrappers and editor toolbars), and skips helper/example
   * text ("Ex: …", "Required to increase listing quality", size hints).
   */
  function isVisible(elm) {
    if (!elm || !elm.getClientRects) return false;
    if (elm.getClientRects().length > 0) return true;
    // CKEditor's own toolbar/dropdown-panel internals (a closed "Insert
    // media" popup, a collapsed heading menu, …) must never get the
    // hidden-step leniency below — they're legitimately hidden regardless
    // of which wizard step they belong to. Confirmed live: without this
    // exclusion, a "Media URL" popup input leaked in as a bogus real field
    // whenever ITS step (Product Information or Product Specification —
    // whichever one wasn't the currently active step) was the hidden one.
    // The real editable area (.ck-editor__main) is never inside a toolbar,
    // so this doesn't affect Description/Highlights/etc. at all.
    if (elm.closest && elm.closest(".ck-toolbar, .ck-dropdown__panel")) return false;
    const stepContainer = elm.closest && elm.closest(STEPPER_SECTION_SEL);
    return !!(stepContainer && stepContainer.getClientRects().length === 0);
  }

  /**
   * A REAL, strict visibility check — deliberately separate from isVisible()
   * above, which treats a hidden wizard step's fields as "visible enough to
   * harvest/write". Clicking Jumia's own "Next" control must never rely on
   * that relaxed definition: we only ever click something that is actually
   * on-screen right now, confirmed by its own rendered size.
   */
  function isReallyVisible(elm) {
    return !!(elm && elm.getClientRects && elm.getClientRects().length > 0);
  }

  /**
   * The wizard's own "Next" control, confirmed live via inspected markup:
   * `<button class="... action-next ...">Next<mat-icon>navigate_next</mat-
   * icon></button>`, sitting inside a `.mobile-actions` block that is
   * structurally separate from `.desktop-actions`' `.submit` button — their
   * class names never appear on the same element and never will, so
   * matching on `.action-next` can never be confused with the control that
   * actually submits the listing (the one thing this extension must never
   * click on a seller's behalf).
   *
   * Both action sets exist in the DOM at all times — Jumia toggles which
   * one is visible via CSS at the current viewport width, it doesn't
   * destroy/recreate them — so this selector matches something even on the
   * classic wide single-page layout. Gating on isReallyVisible() is what
   * makes that safe: a real click only ever happens when the button is
   * genuinely on-screen, so this is a no-op there, exactly like before this
   * feature existed.
   */
  function findNextStepButton() {
    const btn = document.querySelector("button.action-next");
    return btn && isReallyVisible(btn) ? btn : null;
  }

  /** Same idea as findNextStepButton, for returning to the first step once done. */
  function findBackStepButton() {
    const btn = document.querySelector("button.action-back");
    return btn && isReallyVisible(btn) && !btn.disabled ? btn : null;
  }

  /** True when text looks like Jumia's own helper/placeholder copy ("Ex: …",
   *  "Required to increase listing quality", size hints) rather than a real
   *  field label — checked against just the first line, same as
   *  labelTextOf below. */
  function looksLikePlaceholderJunk(text) {
    const first = (text || "").trim().split("\n")[0].trim();
    return /^(ex:|e\.g\.)|required to increase|recommended|maximum|pixels|watermark/i.test(first);
  }

  function labelTextOf(elm) {
    if (!elm || !elm.querySelector) return null;
    if (elm.matches('input, textarea, select, [contenteditable="true"]')) return null;
    // A real label is visible — rejects hidden source textareas / stray nodes.
    if (!isVisible(elm)) return null;
    // Reject anything that is part of a button, link, or editor toolbar.
    if (elm.closest('button, a, [role="button"], [role="toolbar"]')) return null;
    if (elm.querySelector('input, textarea, select, [contenteditable="true"], button, svg, [role="toolbar"]')) return null;
    const raw = (elm.innerText || elm.textContent || "").trim();
    if (!raw) return null;
    const first = raw.split("\n")[0].trim();
    if (first.length < 1 || first.length > 40) return null;
    if (looksLikePlaceholderJunk(first)) return null;
    // Reject the editor's own generic captions so we keep climbing to the real
    // field label (e.g. "Product description") sitting above the toolbar.
    if (/^(rich ?text editor|editor|paragraph|normal text|heading \d)$/i.test(first)) return null;
    if (/editor editing area/i.test(first)) return null;
    return clean(first);
  }

  function labelIsRequired(el) {
    // Look for an asterisk in the resolved label text.
    const wrap = el.closest("label") || el.parentElement;
    return !!(wrap && /\*/.test(wrap.innerText || ""));
  }

  const clean = (s) => (s || "").replace(/\s*\*\s*$/, "").replace(/\s+/g, " ").trim();

  // ── Apply values ─────────────────────────────────────────────────────────

  // Jumia's own placeholder-ish default values — not real seller content,
  // so fill-empty-only shouldn't treat them as "already filled". Confirmed:
  // the Variation field defaults to a literal "..." until the seller sets a
  // real variant name.
  const PLACEHOLDER_VALUES = new Set(["...", "…"]);

  /** True if the field already carries a real (non-placeholder) value. */
  function fieldHasValue(field) {
    const { el, type } = field;
    if (type === "richtext") return !isEditorEmpty(el);
    const v = (el.value || "").trim();
    return !!v && !PLACEHOLDER_VALUES.has(v);
  }

  /**
   * Free-text/rich-content fields whose fate (keep as-is / enhance / rewrite)
   * is the AI's call, not a blind client-side skip — see harvest()'s
   * currentValue capture below and lib/ai/content-style-rules.ts on the
   * server. Structured attribute fields (Color family, Warranty Type,
   * Production country, …) are deliberately NOT included here: there's no
   * "enhance" version of a fixed dropdown pick, so those keep the plain
   * "already has a value — leave it" gate in applyValues(). Product photos
   * are never in scope at all — findFields() excludes file/image inputs
   * entirely, and harvestImages()/applyValues() never write to them, so
   * images are always left exactly as the seller has them.
   */
  function isNarrativeLabel(label) {
    const l = (label || "").toLowerCase();
    return (l.includes("name") && !l.includes("brand")) || l.includes("description") || l.includes("highlight");
  }

  /**
   * Confirmed live: submitting an edited listing with an AI-regenerated
   * Seller SKU failed with "Product Sid [...] and Seller SKU [...] do not
   * match. Valid Seller SKU is [...]" — Jumia ties the Seller SKU to the
   * product's SID once a listing exists, so it's not an editable attribute
   * like Color or Warranty Type, it's closer to an immutable identifier.
   * Unlike every other field, this needs protecting from the "Overwrite
   * existing content" checkbox too, not just the default gate below — a
   * seller ticking that box wants richer prose, not a broken submission.
   *
   * Variation confirmed live too (screenshot, Sep 2026): on an
   * already-registered variant, Jumia renders BOTH Variation and Seller SKU
   * in the exact same greyed-out, un-typeable style — Variation is tied to
   * the same (SID, variant) registration Seller SKU is, not a freely
   * editable attribute once that variant exists. With "Overwrite existing
   * content" checked, the AI was free to regenerate Variation with no
   * protection at all, breaking Jumia's registered (SID, Variation, Seller
   * SKU) triple even when Seller SKU itself was correctly left untouched —
   * same submission failure, different root field. A brand-new variant
   * (via "+ Add Variation", or a fresh /products/add/new listing) still
   * needs Variation AI-filled — fieldHasValue() below already draws that
   * exact line for Seller SKU, so reusing the same guard costs nothing new.
   *
   * GTIN Barcode was flagged as a suspected-similar case (also a real-world
   * identifier) but deliberately left unlocked pending real evidence either
   * way. Resolved: Jumia's own seller documentation (VendorHub's "GTIN
   * barcodes" article, all markets) documents gtin_barcode as a directly
   * editable field on the SAME edit-product screen — "Manage product > edit
   * product details > variations > gtin_barcode" — same as any other
   * attribute, updatable via the UI, a file upload, or the API. Its only
   * uniqueness rule blocks reusing one GTIN across two DIFFERENT products
   * ("you cannot create more than one product with the same gtin barcode");
   * it says nothing about locking an existing listing's own GTIN once set.
   * That's a structurally different constraint from Seller SKU/Variation's
   * confirmed SID-tie above, so GTIN Barcode correctly stays OUT of
   * isLockedIdentifierLabel below — locking it would block a legitimate
   * correction (e.g. a mistyped barcode) for no real reason.
   */
  function isLockedIdentifierLabel(label) {
    const l = (label || "").toLowerCase();
    return l.includes("seller sku") || l.includes("variation");
  }

  /** Plain-text snapshot of a narrative field's current content, sent to the
   *  AI so IT decides whether to keep, enhance, or replace it — rather than
   *  the extension either blindly skipping or blindly overwriting. Strips
   *  zero-width characters (CKEditor leaves word-joiners — U+2060 — behind
   *  as a paste artifact around inline widgets, confirmed to persist across
   *  a save) so they don't get read back as real content or throw off the
   *  server's kept-vs-changed comparison. */
  function currentTextValue(field) {
    const { el, type } = field;
    const raw = type === "richtext" ? el.innerText || "" : el.value || "";
    return raw.replace(/[\u2060\u200b\ufeff]/g, "").trim();
  }

  /**
   * True when a rich-text field currently has an image embedded IN it —
   * Jumia's Highlights/Description editors allow inserting a photo inline,
   * separate from the one top-level product-photo upload (which findFields()
   * excludes entirely and is never at risk). Confirmed via a live save+
   * reload test: the <img src> is a permanent Vendor Center CDN URL (not
   * blob:/data:), unchanged by save, so it's safe to capture now and splice
   * back in later — see mergePreservedImages below, which writeValue()
   * always runs before writing a richtext field with one of these, so the
   * image can never be silently wiped by a text rewrite.
   */
  function hasEmbeddedImage(field) {
    return field.type === "richtext" && !!field.el.querySelector("img");
  }

  /**
   * Splices this field's currently-embedded <img> tag(s) into freshly
   * generated HTML before it's written. Extracts just the bare `src` (no
   * CKEditor view-layer wrapper span, no width/class/alt) — the same shape
   * CKEditor's own getData() returns and setData() expects; it rebuilds its
   * own widget chrome around a plain <img> on the way back in. Placed as
   * the first child of the corresponding new <li>/<p>, in the image's
   * original order — matching where CKEditor put it (ahead of the text, in
   * the first bullet) — with any extra images beyond the number of new
   * items landing in the last one. Falls back to prepending at the very
   * front when the new HTML has no <li>/<p> structure to anchor to.
   */
  function mergePreservedImages(html, field) {
    const imgs = [...field.el.querySelectorAll("img")];
    if (!imgs.length) return html;
    const imgTags = imgs.map((img) => `<img src="${img.getAttribute("src")}">`);
    const wrapper = document.createElement("div");
    wrapper.innerHTML = html;
    const slots = [...wrapper.querySelectorAll("li, p")];
    if (!slots.length) return imgTags.join("") + wrapper.innerHTML;
    imgTags.forEach((tag, i) => slots[Math.min(i, slots.length - 1)].insertAdjacentHTML("afterbegin", tag));
    return wrapper.innerHTML;
  }

  /**
   * `overwrite` defaults to false: on an already-listed product (Edit page)
   * every field may already hold real, possibly hand-tuned seller content,
   * so the default is "complete what's missing," not "rewrite what's
   * there." On a fresh Add-Products form every field starts empty anyway,
   * so this is a no-op there — nothing to skip.
   *
   * Narrative fields (Name/Description/Highlights — see isNarrativeLabel)
   * are the one exception, always applied regardless of `overwrite`: the AI
   * was already shown whatever content they held (harvest()'s
   * currentValue) and asked to keep/enhance/replace it, so its returned
   * value IS the considered decision, not a blind guess to gate here.
   *
   * A field with an embedded image (hasEmbeddedImage) is handled specially
   * regardless of the above: writeValue() below always runs
   * mergePreservedImages() first, so the image rides along into whatever
   * gets written rather than being wiped by the rich-text field's
   * wholesale-replace write — see hasEmbeddedImage's doc comment.
   */
  /**
   * Does this element look like the product-NAME input judged by its OWN
   * stable Angular attribute, independent of whatever findLabel() decided?
   *
   * Needed because the two can disagree: confirmed live (Vercel logs, Aug 26
   * 2026) the server returned a real title — "Pack Of 30 Award Medals - Gold
   * Colour, With Neck Ribbons" — on the very run whose Name field ended up
   * reading "Generic". So the bad value was never the AI's; some OTHER
   * label's value ("Generic" only ever comes from the server's Brand
   * default) was routed into the product-name input by a label mismatch.
   */
  function elIsProductNameInput(el) {
    const fc = (el.getAttribute?.("formcontrolname") || "").toLowerCase();
    return fc === "name" || fc === "productname" || fc === "product_name";
  }

  const labelIsProductName = (label) => {
    const l = (label || "").toLowerCase();
    return l.includes("name") && !l.includes("brand") && !l.includes("store");
  };

  async function applyValues(values, { overwrite = false } = {}) {
    const fields = findFields();
    const byLabel = new Map(fields.map((f) => [f.label.toLowerCase(), f]));
    const results = [];

    // Temporary diagnostic for the "Name shows Generic" investigation — the
    // server-side half is already proven clean, so what's needed next is the
    // label→element mapping this side actually built.
    console.info(
      LOG,
      "label → element map:",
      fields.map((f) => ({
        label: f.label,
        type: f.type,
        formcontrolname: f.el.getAttribute?.("formcontrolname") || null,
        id: f.el.id || null,
      })),
    );

    // Write the product-name field LAST, after every other field including
    // Brand. This is a real attempt at PREVENTING the drift confirmed live
    // (not just reacting to it via the re-assert pass below): in every
    // occurrence, Name ended up matching whatever Brand became in the same
    // batch, which is the signature of a "regenerate a suggested name from
    // brand/category unless the seller already touched it" side effect —
    // a common admin-form pattern. Angular has no reason to treat our write
    // as "the seller already touched it" (that's a real per-form internal
    // flag we can't set from outside), so if such a side effect exists, it
    // fires on ITS OWN schedule after Brand changes regardless of write
    // order — but writing Name after Brand at least means our value is the
    // LAST thing set before that side effect would have already run, rather
    // than being overwritten by it moments later. The re-assert pass further
    // below stays as the safety net for whatever this ordering doesn't
    // fully prevent — this narrows how often it needs to catch anything,
    // it doesn't replace it (the exact underlying mechanism is still
    // invisible to us — Jumia's own component code, not ours).
    const entries = Object.entries(values);
    entries.sort((a, b) => Number(labelIsProductName(a[0])) - Number(labelIsProductName(b[0])));

    for (const [label, value] of entries) {
      const f = byLabel.get(label.toLowerCase());
      if (!f) {
        results.push({ label, ok: false, reason: "field not found on page" });
        continue;
      }
      // Mis-route guard (see elIsProductNameInput above): the target IS the
      // product-name input, but we got here under some other field's label —
      // so this value belongs somewhere else and would clobber a title the
      // server already vetted. Refuse rather than write it.
      if (elIsProductNameInput(f.el) && !labelIsProductName(f.label)) {
        console.warn(LOG, `refused: label "${f.label}" resolved to the product-name input`);
        results.push({
          label,
          ok: false,
          reason: `would have overwritten the product name — left as-is`,
        });
        continue;
      }
      // Locked identifiers (see isLockedIdentifierLabel) skip whenever they
      // already have a value, ignoring `overwrite` entirely — unlike every
      // other field, "the seller wants richer content" is never a reason to
      // touch this one; Jumia's backend rejects the submission outright.
      if (isLockedIdentifierLabel(f.label) && fieldHasValue(f)) {
        results.push({ label, ok: false, skipped: true, reason: "locked to this listing — left as-is" });
        continue;
      }
      if (!overwrite && !isNarrativeLabel(f.label) && fieldHasValue(f)) {
        results.push({ label, ok: false, skipped: true, reason: "already has a value — left as-is" });
        continue;
      }
      try {
        const ok = await writeValue(f, value);
        results.push({ label, ok, reason: ok ? "" : "writer reported no change", field: f, value });
      } catch (e) {
        results.push({ label, ok: false, reason: e.message });
      }
    }
    await closeAnyLingeringOverlay();

    // Combobox-type attribute pickers (Certifications, Material family,
    // Production country, Warranty Duration/Type, …) need their trigger to
    // be genuinely on-screen to open its overlay — unlike text/select/
    // richtext fields, there's no native-value-setter shortcut that works
    // while hidden (see isVisible()'s big comment above). Anything that
    // failed for exactly that reason gets a second chance here: walk
    // Jumia's own wizard forward one step at a time (only when the layout
    // actually has one — findNextStepButton() returns null on the classic
    // single-page layout, so this whole block is a no-op there) and retry
    // once each field's step is actually visible. Bounded at 4 hops — more
    // than the 3 steps seen live, in case a future category adds one — so
    // a page that never settles can't spin this forever.
    let pendingCombos = results.filter(
      (r) => !r.ok && r.field?.type === "combobox" && !isReallyVisible(r.field.el),
    );
    for (let hop = 0; pendingCombos.length && hop < 4; hop++) {
      const next = findNextStepButton();
      if (!next) break;
      next.click();
      for (let attempt = 0; attempt < 20; attempt++) {
        await sleep(100);
        if (pendingCombos.some((r) => isReallyVisible(r.field.el))) break;
      }
      for (const r of pendingCombos) {
        if (!isReallyVisible(r.field.el)) continue;
        try {
          const ok = await writeValue(r.field, r.value);
          r.ok = ok;
          r.reason = ok ? "" : "writer reported no change";
        } catch (e) {
          r.reason = e.message;
        }
      }
      pendingCombos = pendingCombos.filter((r) => !r.ok);
    }
    // Leave the seller where they started (step 1) to review, same as the
    // classic single-page layout always has — never on whatever step the
    // walk above happened to end on.
    for (let hop = 0; hop < 4; hop++) {
      const back = findBackStepButton();
      if (!back) break;
      back.click();
      await sleep(150);
    }

    // Confirmed live (Aug 29 2026, console label→element map + Vercel logs
    // for the same request): writeInput's own synchronous check proved Name
    // held the AI's real title the instant it was written, yet the visible
    // field read "Generic" moments later — every time, always matching
    // whatever Brand became in the SAME batch. Something downstream of the
    // write (Angular change detection, or a Jumia-side form behavior this
    // extension has no visibility into) reverts it after the fact. Rather
    // than a guess at the platform mechanism, re-assert: give Angular a beat
    // to settle, then re-check every plain text/textarea field this batch
    // actually wrote and rewrite anything that drifted from what we set.
    // Scoped to text/textarea only — richtext goes through a different
    // read/write path, and re-clicking a combobox/select risks reopening an
    // overlay mid-verification instead of just confirming a value.
    //
    // Looped up to 3 rounds rather than a single check — confirmed live
    // (Sep 2026): "Variation" drifted to what looked like a Production-
    // Country value on a single-variant listing, got caught and reasserted
    // by exactly this mechanism, and STILL showed the wrong value in the
    // final screenshot — i.e. one reassertion isn't always enough, whatever
    // reverts the value can apparently fire again after the first fix
    // lands. Stops early the moment a full round finds nothing drifted, so
    // the common case (no drift, or one drift fixed on the first pass)
    // behaves exactly as before.
    for (let round = 0; round < 3; round++) {
      await sleep(400);
      let driftedAny = false;
      for (const r of results) {
        if (!r.ok || !r.field || r.field.type !== "text") continue;
        const current = (r.field.el.value || "").trim();
        if (current === r.value.trim()) continue;
        driftedAny = true;
        console.warn(LOG, `"${r.label}" drifted from "${r.value}" to "${current}" after writing — reasserting (round ${round + 1})`);
        const reok = writeInput(r.field.el, r.value);
        r.ok = reok;
        r.reason = reok ? "" : "reasserted but writer reported no change";
      }
      if (!driftedAny) break;
    }
    // Drop the internal-only fields carried above for the reassertion pass —
    // the caller only expects {label, ok, reason, skipped?}.
    const publicResults = results.map(({ label, ok, reason, skipped }) => ({ label, ok, reason, skipped }));

    console.debug(LOG, "apply results:", publicResults);
    // Same idea as __pandaworldLastHarvest above — run
    // copy(window.__pandaworldLastApply) in DevTools for clipboard-ready
    // text. Includes the raw AI values too, so it's possible to tell
    // "the AI never returned this field" apart from "it did, and the
    // write failed" — the two read identically from the page alone.
    window.__pandaworldLastApply = { values, results: publicResults };
    return { ok: true, results: publicResults };
  }

  async function writeValue(field, value) {
    const { el, type } = field;
    // Some fields on Jumia's own form start out disabled until an earlier
    // field gets a value — confirmed live: Sale Price stays disabled until
    // Price has one, Sale Start/End Date stay disabled until Sale Price
    // does. applyValues() already writes fields in the page's own
    // top-to-bottom order (see its `entries` loop), so the field this one
    // depends on has normally already been written by the time we get
    // here — but Angular's own change detection needs a beat to actually
    // flip the `disabled` attribute afterwards, so give it a short, bounded
    // chance instead of failing instantly against a control that's about to
    // open up. Generic (checks the DOM property, not any field name), so it
    // also covers any other cascading field pair Jumia adds later. A no-op
    // for anything not currently disabled — the common case — and safe on
    // richtext/combobox elements that don't even have a `.disabled`
    // property (reads as undefined, so the loop below never runs).
    for (let attempt = 0; attempt < 10 && el.disabled; attempt++) await sleep(100);
    if (el.disabled) throw new Error("field is disabled on the page — a dependency (e.g. Price) may need a value first");
    if (type === "richtext") {
      const merged = hasEmbeddedImage(field) ? mergePreservedImages(value, field) : value;
      return writeRichText(el, merged);
    }
    if (type === "select") return writeSelect(el, value);
    if (type === "combobox") return writeCombobox(el, value, field);
    return writeInput(el, value); // text / textarea
  }

  /** React-safe input write via the native value setter. */
  function writeInput(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    try {
      if (setter) setter.call(el, value);
      else el.value = value;
    } catch (e) {
      // Confirmed live via chrome://extensions error log: a native
      // type="number"/"date"/"range" input throws synchronously when the
      // value it's given can't be parsed for that type ("The specified
      // value 'N/A' cannot be parsed, or is out of range." — seen for
      // "N/A", "Ghana", "GHS" landing on a numeric field). This call was
      // reached unguarded from the post-write reassertion pass in
      // applyValues(), so the throw propagated out of that whole async
      // function — applyValues(...).then(sendResponse) has no .catch, so
      // sendResponse was never called and the ENTIRE fill result (every
      // field, including ones already written correctly, e.g. Seller SKU)
      // never reached the panel. One field's unwritable value must not be
      // able to take down the rest of the batch.
      console.warn(LOG, `writeInput failed for value ${JSON.stringify(value)}: ${e.message}`);
      return false;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return el.value === value;
  }

  function writeSelect(el, value) {
    const opt = [...el.options].find(
      (o) => o.text.trim().toLowerCase() === value.toLowerCase() || o.value.toLowerCase() === value.toLowerCase(),
    );
    if (!opt) return false;
    el.value = opt.value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  /**
   * Write into a custom dropdown — Jumia's category attribute pickers (Color
   * family, Material family, Production country, Warranty Duration, …). These
   * are NOT native <select>s: clicking the trigger opens an overlay whose
   * choices are CHECKBOX ROWS (a label/li/div wrapping an <input
   * type=checkbox> + text). Setting .value on the trigger does nothing — the
   * framework only registers a selection when the row (or its checkbox) is
   * actually clicked. So: open the overlay, optionally type into an in-overlay
   * search box to narrow a long list, find the row whose text matches, and
   * click it (plus its checkbox as a fallback).
   */
  /**
   * Split a combobox value into the individual choices to select. Jumia's
   * "family" pickers (Color family, Material family, Certifications) accept
   * MORE than one choice — they're checkbox lists, not radio lists — so the
   * AI can legitimately answer "Black, Brown". Only split when every part
   * matches a real option, so a single option that itself contains a comma
   * (e.g. "Ships from Accra, Ghana") is never shredded into nonsense.
   */
  function splitComboValues(value, field) {
    const whole = value.trim();
    if (!whole) return [];
    const opts = field?.options;
    const matchesOption = (v) => opts.some((o) => o.trim().toLowerCase() === v.trim().toLowerCase());
    // With a known option list, prefer an exact whole-string match.
    if (opts?.length && matchesOption(whole)) return [whole];
    const parts = whole.split(/\s*[,|]\s*/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) return [whole];
    if (opts?.length && !parts.every(matchesOption)) return [whole];
    return parts;
  }

  /**
   * Select one value in a combobox: open it, narrow it (search box, else
   * scroll-and-poll a virtualized list), click the matching row. Leaves the
   * overlay CLOSED on the way out so the next value starts from a clean
   * state — reopening per value is a little slower than keeping the overlay
   * up, but it's the only way that's safe for both single-select widgets
   * (which close themselves on pick) and multi-select ones (which don't).
   */
  async function writeComboboxOne(el, value) {
    const target = value.trim().toLowerCase();
    await closeDropdown(el);
    openDropdown(el);
    await sleep(160);

    // If the trigger itself is a typeable input, or the overlay has a search
    // box, type the target so a long list (e.g. Country) filters down to it.
    if (el.tagName === "INPUT" && !el.readOnly) {
      try { writeInput(el, value); } catch { /* ignore */ }
    }
    let filtered = filterOpenOverlay(value, el);
    let scrollViewport = null;
    let canScrollFurther = true;
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));

    // 30 attempts (not 10) — the search-box path usually resolves in the
    // first few either way, but scroll-and-poll through a long virtualized
    // list (Production country can run 200+ entries) needs more room.
    for (let attempt = 0; attempt < 30; attempt++) {
      await sleep(130);
      // A long list's search box can render a beat after the overlay opens
      // — keep trying to find and use it until it's actually filtered.
      if (!filtered) filtered = filterOpenOverlay(value, el);
      const match = matchOption(target);
      if (!match && !filtered && canScrollFurther) {
        // No search box found (or none helped) — fall back to nudging a
        // virtualized list's own scroll position so the next poll sees a
        // freshly-rendered slice further down.
        scrollViewport = scrollViewport || scrollableOverlayEl();
        canScrollFurther = nudgeScroll(scrollViewport);
      }
      if (match) {
        // `block: "nearest"` still scrolls the PAGE when the option's own
        // overlay isn't the nearest scrollable ancestor, which is what
        // walks the form upward a step each time a multi-select option is
        // ticked. Scroll the overlay's own viewport directly instead, and
        // leave the page where the seller left it.
        const viewport = scrollViewport || scrollableOverlayEl();
        if (viewport && viewport.contains(match)) {
          const vRect = viewport.getBoundingClientRect();
          const mRect = match.getBoundingClientRect();
          if (mRect.top < vRect.top || mRect.bottom > vRect.bottom) {
            viewport.scrollTop += mRect.top - vRect.top;
          }
        }
        const box = match.matches('input[type="checkbox"], input[type="radio"]')
          ? match
          : match.querySelector('input[type="checkbox"], input[type="radio"]');
        // Click the row (toggles its checkbox), then the checkbox itself if it
        // still didn't take — different widgets listen on one or the other.
        match.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        match.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        match.click();
        if (box && !box.checked) {
          try { box.click(); } catch { /* ignore */ }
        }
        await sleep(90);
        await closeDropdown(el);
        return true;
      }
    }

    await closeDropdown(el);
    return false;
  }

  /**
   * Write into a custom dropdown, selecting every value the AI returned —
   * one for an ordinary picker, several for a multi-select one like Color
   * family or Material family (see splitComboValues). Reports success if at
   * least one choice landed, so a partly-matched multi-select still counts
   * as filled rather than silently reading as a total failure.
   *
   * Fails fast when the trigger isn't genuinely on-screen — a field on a
   * hidden wizard step (see isVisible()'s big comment above) can never
   * actually open an overlay; Angular Material's CDK positioning needs a
   * real bounding rect. Without this check, writeComboboxOne's 30-attempt
   * retry loop (30 × 130ms ≈ 4s) would still run to completion and fail
   * anyway — confirmed live: with 5 hidden comboboxes on one listing, that
   * added ~20 seconds of the page visibly doing nothing before
   * applyValues()'s own wizard-walk (findNextStepButton, below the main
   * per-field loop) ever got a turn, which read as "the fill just isn't
   * doing anything" rather than "still working." Failing instantly here
   * lets that walk start immediately instead.
   */
  async function writeCombobox(el, value, field) {
    if (!isReallyVisible(el)) return false;
    const values = splitComboValues(value, field);
    let selected = 0;
    for (const v of values) {
      if (await writeComboboxOne(el, v)) selected++;
    }
    return selected > 0;
  }

  /**
   * Write HTML into a rich-text editor.
   *
   * Jumia uses CKEditor 5, which ignores DOM writes — so we hand the job to the
   * MAIN-world bridge (content/mainworld.js): tag the editable with the HTML,
   * dispatch a synchronous event, and read the outcome the bridge writes back.
   * The bridge calls the real `editor.setData()`; for any non-CKEditor editor it
   * falls back to a page-context execCommand write.
   */
  function writeRichText(el, html) {
    el.setAttribute("data-pw-html", encodeURIComponent(html));
    // Synchronous dispatch — the MAIN-world listener runs before this returns.
    document.dispatchEvent(new CustomEvent("pw-apply-richtext"));
    const done = el.getAttribute("data-pw-done") || "";
    el.removeAttribute("data-pw-done");
    if (done === "ck" || done === "dom") return true;
    // Bridge missing or failed — last-resort DOM write from the isolated world.
    if (isEditorEmpty(el)) {
      try {
        el.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand("insertHTML", false, html);
      } catch {
        el.innerHTML = html;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return !isEditorEmpty(el);
  }

  function isEditorEmpty(el) {
    const t = (el.innerText || "").replace(/\s+/g, "");
    return t.length === 0;
  }

  // ── Small helpers ──────────────────────────────────────────────────────────

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error("FileReader failed"));
      r.readAsDataURL(file);
    });
  }

  async function urlToDataUrl(url) {
    const res = await fetch(url);
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error("blob read failed"));
      r.readAsDataURL(blob);
    });
  }

  console.debug(LOG, "content script ready on", location.href);
})();
