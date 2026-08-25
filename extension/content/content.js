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
    const fields = rawFields.map((f) => ({
      label: f.label,
      type: f.type,
      required: f.required,
      options: f.options,
    }));
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

    // Fallback 2: an Edit-Product page's already-uploaded photo. There's no
    // blob:/data: preview here — it's already hosted on Jumia's own image
    // CDN as a normal https:// <img src>, on a different origin than ours,
    // so fetching it from here would hit that origin's CORS policy. We don't
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

  /** Returns [{ label, type, required, options, el }] for each writable field. */
  function findFields() {
    const out = [];
    const seen = new Set();
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
      const key = label.toLowerCase();
      if (seen.has(key)) return;

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

      seen.add(key);
      out.push({ label, type, required, options, el });
    });

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

  /** Type into a search box inside the open overlay, if one exists (long lists). */
  function filterOpenOverlay(value) {
    const box = document.querySelector(
      '.cdk-overlay-container input:not([type="checkbox"]):not([type="radio"]), ' +
        '[role="listbox"] input, [role="dialog"] input, [role="menu"] input',
    );
    if (box && isVisible(box)) {
      try { writeInput(box, value); } catch { /* ignore */ }
      return true;
    }
    return false;
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
        const texts = collectOptionEls()
          .map((o) => (o.innerText || o.textContent || "").trim())
          .filter(Boolean);
        if (texts.length) f.options = [...new Set(texts)].slice(0, 80);
      } catch {
        /* best effort — leave options undefined, AI falls back to free text */
      } finally {
        await closeDropdown(f.el);
      }
    }
  }

  const CONTROL_SEL = 'input, textarea, select, .ProseMirror';
  // Neighbours whose presence, when visible, ends the backward label walk.
  const STOP_SEL = 'input, textarea, select, .ProseMirror, [contenteditable="true"]';
  // A rich-text editor's own aria-label ("Editor editing area: main") is NOT
  // the field label — ignore these so we find the real one above it.
  const BAD_ARIA = /editor editing area|rich.?text|prosemirror/i;

  /** Best-effort label resolution for a control. */
  function findLabel(el) {
    const isRich = el.classList.contains("ProseMirror") || el.getAttribute("contenteditable") === "true";

    // 1. <label for> association
    if (el.labels && el.labels[0] && el.labels[0].innerText.trim()) return clean(el.labels[0].innerText);
    // 2. aria-label / aria-labelledby — but never a rich-text editor's own aria.
    const aria = el.getAttribute("aria-label");
    if (aria && !(isRich && BAD_ARIA.test(aria))) return clean(aria);
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const ref = document.getElementById(labelledby);
      if (ref && ref.innerText.trim() && !BAD_ARIA.test(ref.innerText)) return clean(ref.innerText);
    }
    // 3. Wrapping <label>
    const wrap = el.closest("label");
    if (wrap && wrap.innerText.trim()) return clean(wrap.innerText);

    // 4. Walk backwards in document (reading) order until we hit a label-like
    // snippet. Most structure-agnostic match; stops if it reaches another form
    // control, so it never steals the previous field's label. This is what
    // reliably finds "Product description" above a ProseMirror toolbar.
    const docOrder = previousLabelInDocOrder(el);
    if (docOrder) return docOrder;

    // 5. Find the field's "cell" — climb while the parent still holds just this
    // one control — then take the closest label-like text before the control.
    // This keeps each field's label to itself (fixes Color vs Color family) and
    // walks a ProseMirror editor up past its toolbar to "Product description".
    let cell = el;
    while (cell.parentElement && countControls(cell.parentElement) <= 1) {
      cell = cell.parentElement;
    }
    const inside = closestLabelBefore(cell, el);
    if (inside) return inside;

    // 6. Nearest preceding sibling of the cell.
    let sib = cell.previousElementSibling;
    for (let hop = 0; sib && hop < 4; hop++) {
      const txt = labelTextOf(sib);
      if (txt) return txt;
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
    if (/^(ex:|e\.g\.)|required to increase|recommended|maximum|pixels|watermark/i.test(first)) return null;
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
   * `overwrite` defaults to false: on an already-listed product (Edit page)
   * every field may already hold real, possibly hand-tuned seller content,
   * so the default is "complete what's missing," not "rewrite what's
   * there." On a fresh Add-Products form every field starts empty anyway,
   * so this is a no-op there — nothing to skip.
   */
  async function applyValues(values, { overwrite = false } = {}) {
    const fields = findFields();
    const byLabel = new Map(fields.map((f) => [f.label.toLowerCase(), f]));
    const results = [];

    for (const [label, value] of Object.entries(values)) {
      const f = byLabel.get(label.toLowerCase());
      if (!f) {
        results.push({ label, ok: false, reason: "field not found on page" });
        continue;
      }
      if (!overwrite && fieldHasValue(f)) {
        results.push({ label, ok: false, skipped: true, reason: "already has a value — left as-is" });
        continue;
      }
      try {
        const ok = await writeValue(f, value);
        results.push({ label, ok, reason: ok ? "" : "writer reported no change" });
      } catch (e) {
        results.push({ label, ok: false, reason: e.message });
      }
    }
    await closeAnyLingeringOverlay();
    console.debug(LOG, "apply results:", results);
    return { ok: true, results };
  }

  function writeValue(field, value) {
    const { el, type } = field;
    if (type === "richtext") return writeRichText(el, value);
    if (type === "select") return writeSelect(el, value);
    if (type === "combobox") return writeCombobox(el, value);
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
  async function writeCombobox(el, value) {
    const target = value.trim().toLowerCase();
    openDropdown(el);
    await sleep(160);

    // If the trigger itself is a typeable input, or the overlay has a search
    // box, type the target so a long list (e.g. Country) filters down to it.
    if (el.tagName === "INPUT" && !el.readOnly) {
      try { writeInput(el, value); } catch { /* ignore */ }
    }
    filterOpenOverlay(value);
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));

    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(130);
      const match = matchOption(target);
      if (match) {
        match.scrollIntoView({ block: "nearest" });
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
