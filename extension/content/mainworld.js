/**
 * MAIN-world bridge (runs in the page's own JS context, not the isolated
 * content-script world).
 *
 * Why this exists: Jumia Vendor Center uses CKEditor 5. CKEditor keeps its
 * content in an internal model and ignores DOM writes (innerHTML / execCommand),
 * so the only reliable way to set a rich-text field is the editor's own API,
 * `editor.setData(html)`. That editor instance lives on the page's JS heap —
 * unreachable from an isolated content script — so we run here in MAIN world
 * (declared via manifest `"world": "MAIN"`, which also bypasses page CSP).
 *
 * Protocol: the content script tags each target editable with
 * `data-pw-html="<uri-encoded html>"`, then dispatches a `pw-apply-richtext`
 * event on `document`. We handle it synchronously and write back
 * `data-pw-done` so the content script can report success.
 */
(function () {
  if (window.__pwCkBridge) return;
  window.__pwCkBridge = true;

  function findEditor(el) {
    // The CKEditor instance is exposed as `.ckeditorInstance` on the editable
    // (or a nearby ancestor). Search up, then across the editor host.
    let cur = el;
    for (let i = 0; i < 6 && cur; i++) {
      if (cur.ckeditorInstance) return cur.ckeditorInstance;
      cur = cur.parentElement;
    }
    const host = el.closest("ckeditor, .ck-editor, .editor-wrapper");
    if (host) {
      const nodes = host.querySelectorAll("*");
      for (const n of nodes) if (n.ckeditorInstance) return n.ckeditorInstance;
    }
    return null;
  }

  document.addEventListener("pw-apply-richtext", function () {
    document.querySelectorAll("[data-pw-html]").forEach(function (el) {
      let outcome = "err";
      try {
        const html = decodeURIComponent(el.getAttribute("data-pw-html") || "");
        const editor = findEditor(el);
        if (editor && typeof editor.setData === "function") {
          editor.setData(html);
          outcome = "ck";
        } else {
          // Fallback for non-CKEditor editors: DOM write in the page context.
          el.focus();
          document.execCommand("selectAll", false, null);
          const ok = document.execCommand("insertHTML", false, html);
          outcome = ok ? "dom" : "domfail";
        }
      } catch (e) {
        outcome = "err:" + (e && e.message ? e.message : "unknown");
      }
      el.removeAttribute("data-pw-html");
      el.setAttribute("data-pw-done", outcome);
    });
  });
})();
