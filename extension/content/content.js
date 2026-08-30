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

  // ── Capture the most recently chosen file (for image harvest) ──────────────
  let lastFile = null;
  document.addEventListener(
    "change",
    (e) => {
      const t = e.target;
      if (t && t.tagName === "INPUT" && t.type === "file" && t.files && t.files[0]) {
        lastFile = t.files[0];
        console.debug(LOG, "captured file:", lastFile.name, lastFile.type, lastFile.size);
      }
    },
    true, // capture phase — catches inputs added after load
  );

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "HARVEST") {
      harvest().then(sendResponse);
      return true;
    }
    if (msg?.type === "APPLY") {
      applyValues(msg.values || {}, { overwrite: !!msg.overwrite }).then(sendResponse);
      return true;
    }
    return false;
  });

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

    let image = null;
    let imageUrl = null;
    try {
      const got = await harvestImage();
      image = got.dataUrl;
      imageUrl = got.httpUrl;
      diagnostics.push(got.dataUrl || got.httpUrl ? `Image harvested via ${got.source}` : "No image found — use the fallback drop zone");
    } catch (e) {
      diagnostics.push(`Image harvest error: ${e.message}`);
    }

    console.debug(LOG, "harvest diagnostics:", diagnostics);
    return { ok: true, image, imageUrl, fields, diagnostics };
  }

  // Matches Jumia's Edit-Product URL (…/products/edit/<id>) — the only place
  // the CDN-photo fallback below runs. On Add-Products a plain https:// <img>
  // is far more likely to be Jumia's own chrome (logo, nav icons) than a real
  // product photo, so that fallback only makes sense once we know we're on
  // an existing listing.
  const EDIT_PAGE_RE = /\/products\/edit\//i;

  async function harvestImage() {
    if (lastFile) {
      return { dataUrl: await fileToDataUrl(lastFile), httpUrl: null, source: "file input" };
    }
    // Fallback 1: a freshly-uploaded preview. Restrict to blob:/data: URLs
    // (what an upload preview uses) so we never grab Jumia's logo or a CDN icon.
    const preview = [...document.querySelectorAll("img")].filter((img) => {
      const src = img.currentSrc || img.src || "";
      return /^blob:|^data:/i.test(src) && (img.naturalWidth || 0) > 120;
    });
    for (const img of preview) {
      const src = img.currentSrc || img.src;
      try {
        return { dataUrl: await urlToDataUrl(src), httpUrl: /^https?:/.test(src) ? src : null, source: "preview img" };
      } catch {
        /* try next */
      }
    }

    // Fallback 2: an already-uploaded photo hosted on Jumia's own dedicated
    // product-image CDN path — confirmed live: uploaded photos land at
    // https://vendorcenter.jumia.com/product-set-images/YYYY/MM/DD/... .
    // That's an unambiguous, POSITIVE signal (nothing else on the page is
    // ever served from that path), so unlike the broader fallback below,
    // it's safe to run on ANY page, not just an Edit-Product one. That
    // matters because Jumia swaps a freshly-uploaded photo's <img src> from
    // a blob: preview to this permanent CDN URL fairly quickly — even
    // mid-session on the Add-Products flow, well before the seller clicks
    // Autofill — and fallback 1 above only ever matches a blob:/data: src,
    // so once that swap happens the photo goes invisible to it. Picks the
    // largest by rendered area if more than one candidate matches.
    const cdnCandidates = [...document.querySelectorAll("img")].filter((img) => {
      const src = img.currentSrc || img.src || "";
      return /product-set-images/i.test(src);
    });
    const bestCdn = cdnCandidates.sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight)[0];
    if (bestCdn) {
      const src = bestCdn.currentSrc || bestCdn.src;
      return { dataUrl: null, httpUrl: src, source: "product-set-images CDN photo" };
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
    // the page can still pass those filters — picks the one with the
    // LARGEST rendered area rather than just the first match, on the theory
    // that a real product photo is the most prominent image on the page.
    // Restricted to Edit pages only (unlike fallback 2 above): without a
    // real photo present yet, this broader https://-image heuristic risks
    // grabbing Jumia's own logo/chrome on a still-blank Add-Products form.
    if (EDIT_PAGE_RE.test(location.pathname)) {
      const BAD_SRC_RE = /\.svg(\?|$)|logo|icon(?!ography)|placeholder|avatar|sprite|badge/i;
      const candidates = [...document.querySelectorAll("img")].filter((img) => {
        const src = img.currentSrc || img.src || "";
        return (
          /^https?:/i.test(src) &&
          (img.naturalWidth || 0) > 200 &&
          !BAD_SRC_RE.test(src) &&
          !img.closest("nav, header, footer, aside")
        );
      });
      const best = candidates.sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight)[0];
      if (best) {
        const src = best.currentSrc || best.src;
        return { dataUrl: null, httpUrl: src, source: "existing product photo" };
      }
    }

    return { dataUrl: null, httpUrl: null, source: "none" };
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

  /**
   * Return trimmed label text from an element, or null if it isn't label-like:
   * skips anything that contains a form control, a button, a toolbar, or an
   * icon (i.e. field wrappers and editor toolbars), and skips helper/example
   * text ("Ex: …", "Required to increase listing quality", size hints).
   */
  function isVisible(elm) {
    if (!elm || !elm.getClientRects) return false;
    return elm.getClientRects().length > 0;
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
   * entirely, and harvestImage()/applyValues() never write to them, so
   * images are always left exactly as the seller has them.
   */
  function isNarrativeLabel(label) {
    const l = (label || "").toLowerCase();
    return (l.includes("name") && !l.includes("brand")) || l.includes("description") || l.includes("highlight");
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
    await sleep(400);
    for (const r of results) {
      if (!r.ok || !r.field || r.field.type !== "text") continue;
      const current = (r.field.el.value || "").trim();
      if (current === r.value.trim()) continue;
      console.warn(LOG, `"${r.label}" drifted from "${r.value}" to "${current}" after writing — reasserting`);
      const reok = writeInput(r.field.el, r.value);
      r.ok = reok;
      r.reason = reok ? "" : "reasserted but writer reported no change";
    }
    // Drop the internal-only fields carried above for the reassertion pass —
    // the caller only expects {label, ok, reason, skipped?}.
    const publicResults = results.map(({ label, ok, reason, skipped }) => ({ label, ok, reason, skipped }));

    console.debug(LOG, "apply results:", publicResults);
    return { ok: true, results: publicResults };
  }

  function writeValue(field, value) {
    const { el, type } = field;
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
    if (setter) setter.call(el, value);
    else el.value = value;
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
   */
  async function writeCombobox(el, value, field) {
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
