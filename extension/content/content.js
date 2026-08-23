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
      sendResponse(applyValues(msg.values || {}));
      return false;
    }
    return false;
  });

  // ── Harvest ────────────────────────────────────────────────────────────────

  async function harvest() {
    const diagnostics = [];
    const fields = findFields().map((f) => ({
      label: f.label,
      type: f.type,
      required: f.required,
      options: f.options,
    }));
    diagnostics.push(`Found ${fields.length} fields: ${fields.map((f) => `${f.label}[${f.type}]`).join(", ") || "none"}`);

    let image = null;
    let imageUrl = null;
    try {
      const got = await harvestImage();
      image = got.dataUrl;
      imageUrl = got.httpUrl;
      diagnostics.push(got.dataUrl ? `Image harvested via ${got.source}` : "No image found — use the fallback drop zone");
    } catch (e) {
      diagnostics.push(`Image harvest error: ${e.message}`);
    }

    console.debug(LOG, "harvest diagnostics:", diagnostics);
    return { ok: true, image, imageUrl, fields, diagnostics };
  }

  async function harvestImage() {
    if (lastFile) {
      return { dataUrl: await fileToDataUrl(lastFile), httpUrl: null, source: "file input" };
    }
    // Fallback: read a preview <img> from the upload area.
    const imgs = [...document.querySelectorAll("img")].filter((img) => {
      const src = img.currentSrc || img.src || "";
      return /^blob:|^data:|jumia|cloudfront|akamai/i.test(src) && (img.naturalWidth || 0) > 60;
    });
    for (const img of imgs) {
      const src = img.currentSrc || img.src;
      try {
        return { dataUrl: await urlToDataUrl(src), httpUrl: /^https?:/.test(src) ? src : null, source: "preview img" };
      } catch {
        /* try next */
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
      'input, textarea, select, [contenteditable="true"], .ProseMirror',
    );

    nodes.forEach((el) => {
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
      else if (el.getAttribute("role") === "combobox" || el.getAttribute("aria-autocomplete")) type = "combobox";
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

  /** Best-effort label resolution for a control. */
  function findLabel(el) {
    // 1. <label for> association
    if (el.labels && el.labels[0]) return clean(el.labels[0].innerText);
    // 2. aria-label / aria-labelledby
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const ref = document.getElementById(labelledby);
      if (ref) return clean(ref.innerText);
    }
    // 3. Wrapping <label>
    const wrap = el.closest("label");
    if (wrap) return clean(wrap.innerText);
    // 4. A label-ish element within the field's container (walk up a few levels)
    let node = el;
    for (let i = 0; i < 4 && node; i++) {
      node = node.parentElement;
      if (!node) break;
      const cand = node.querySelector("label, .label, [class*='label'], .field-label");
      if (cand && cand.innerText.trim()) return clean(cand.innerText);
    }
    // 5. Nearest previous sibling text (last resort)
    let sib = el.previousElementSibling;
    for (let i = 0; i < 3 && sib; i++) {
      if (sib.innerText && sib.innerText.trim().length <= 40) return clean(sib.innerText);
      sib = sib.previousElementSibling;
    }
    return null;
  }

  function labelIsRequired(el) {
    // Look for an asterisk in the resolved label text.
    const wrap = el.closest("label") || el.parentElement;
    return !!(wrap && /\*/.test(wrap.innerText || ""));
  }

  const clean = (s) => (s || "").replace(/\s*\*\s*$/, "").replace(/\s+/g, " ").trim();

  // ── Apply values ─────────────────────────────────────────────────────────

  function applyValues(values) {
    const fields = findFields();
    const byLabel = new Map(fields.map((f) => [f.label.toLowerCase(), f]));
    const results = [];

    for (const [label, value] of Object.entries(values)) {
      const f = byLabel.get(label.toLowerCase());
      if (!f) {
        results.push({ label, ok: false, reason: "field not found on page" });
        continue;
      }
      try {
        const ok = writeValue(f, value);
        results.push({ label, ok, reason: ok ? "" : "writer reported no change" });
      } catch (e) {
        results.push({ label, ok: false, reason: e.message });
      }
    }
    console.debug(LOG, "apply results:", results);
    return { ok: true, results };
  }

  function writeValue(field, value) {
    const { el, type } = field;
    if (type === "richtext") return writeRichText(el, value);
    if (type === "select") return writeSelect(el, value);
    return writeInput(el, value); // text / textarea / combobox
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
   * Write HTML into a ProseMirror/contenteditable editor.
   * Primary: select-all + execCommand('insertHTML') — ProseMirror's DOM
   * observer picks up the mutation. Fallback: simulate a paste event carrying
   * text/html, which routes through PM's own paste parser.
   */
  function writeRichText(el, html) {
    el.focus();
    selectAll(el);

    // Primary — execCommand insertHTML (still supported in Chrome for CE).
    let changed = false;
    try {
      changed = document.execCommand("insertHTML", false, html);
    } catch {
      changed = false;
    }

    // Fallback — synthetic paste with text/html.
    if (!changed || isEditorEmpty(el)) {
      try {
        selectAll(el);
        const dt = new DataTransfer();
        dt.setData("text/html", html);
        dt.setData("text/plain", htmlToText(html));
        const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
        el.dispatchEvent(ev);
      } catch {
        /* last resort below */
      }
    }

    // Last resort — direct innerHTML (some editors sync via MutationObserver).
    if (isEditorEmpty(el)) {
      el.innerHTML = html;
    }

    el.dispatchEvent(new Event("input", { bubbles: true }));
    return !isEditorEmpty(el);
  }

  function selectAll(el) {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
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

  function htmlToText(html) {
    const d = document.createElement("div");
    d.innerHTML = html;
    d.querySelectorAll("li").forEach((li) => (li.textContent = `• ${li.textContent}\n`));
    d.querySelectorAll("p, br, div").forEach((n) => n.insertAdjacentText("afterend", "\n"));
    return (d.innerText || d.textContent || "").trim();
  }

  console.debug(LOG, "content script ready on", location.href);
})();
