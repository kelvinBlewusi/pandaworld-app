/**
 * Side panel orchestration.
 *
 * Flow on "Autofill":
 *   1. find the active Jumia tab
 *   2. ask the content script to HARVEST (image + rendered fields)
 *   3. ask the background worker to call the API with that payload
 *   4. ask the content script to APPLY the returned values
 *   5. render per-field results + warnings
 */

const $ = (id) => document.getElementById(id);
const DEFAULT_API = "http://localhost:3002";

// ── Settings persistence ─────────────────────────────────────────────────────
async function loadSettings() {
  const { apiBase, apiKey } = await chrome.storage.local.get(["apiBase", "apiKey"]);
  $("apiBase").value = apiBase || DEFAULT_API;
  $("apiKey").value = apiKey || "";
}
$("saveSettings").addEventListener("click", async () => {
  await chrome.storage.local.set({ apiBase: $("apiBase").value.trim(), apiKey: $("apiKey").value.trim() });
  setStatus("Settings saved.", "ok");
});
loadSettings();

// ── UI helpers ───────────────────────────────────────────────────────────────
function setStatus(text, kind = "") {
  const s = $("status");
  s.textContent = text;
  s.className = `status ${kind}`;
}
function renderResults(results) {
  const ul = $("results");
  ul.innerHTML = "";
  for (const r of results || []) {
    const li = document.createElement("li");
    li.className = r.ok ? "ok" : "bad";
    li.innerHTML = `<span class="mark">${r.ok ? "✓" : "✕"}</span>
      <span><b>${escapeHtml(r.label)}</b>${r.why || r.reason ? ` <span class="why">${escapeHtml(r.why || r.reason)}</span>` : ""}</span>`;
    ul.appendChild(li);
  }
}
function renderWarnings(warnings) {
  const box = $("warnings");
  box.innerHTML = "";
  for (const w of warnings || []) {
    const d = document.createElement("div");
    d.className = "w";
    d.textContent = `⚠️ ${w}`;
    box.appendChild(d);
  }
}
const escapeHtml = (s) => (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function renderDiag(diagnostics) {
  const wrap = document.getElementById("diagWrap");
  const box = $("diag");
  if (!diagnostics || !diagnostics.length) {
    wrap.hidden = true;
    return;
  }
  box.innerHTML = "";
  for (const d of diagnostics) {
    const p = document.createElement("div");
    p.className = "diagline";
    p.textContent = d;
    box.appendChild(p);
  }
  wrap.hidden = false;
}

// ── Main action ──────────────────────────────────────────────────────────────
$("autofill").addEventListener("click", async () => {
  const btn = $("autofill");
  btn.disabled = true;
  $("results").innerHTML = "";
  $("warnings").innerHTML = "";
  try {
    const tab = await activeJumiaTab();
    if (!tab) {
      setStatus("Open a Jumia Vendor Center Add-Products page first.", "err");
      return;
    }

    setStatus("Reading the form…");
    const harvest = await sendToTab(tab.id, { type: "HARVEST" });
    if (!harvest?.ok) {
      setStatus("Could not read the page. Reload the Jumia tab and try again.", "err");
      return;
    }
    renderDiag(harvest.diagnostics); // always show what we saw
    if (!harvest.fields.length) {
      setStatus("No fields found — did you pick a category to open the form?", "err");
      return;
    }
    setStatus(`Found ${harvest.fields.length} fields${harvest.image ? " + image" : " (no image detected)"}. Asking AI…`);

    const settings = await chrome.storage.local.get(["apiBase", "apiKey"]);
    const fill = await chrome.runtime.sendMessage({
      type: "FILL",
      apiBase: settings.apiBase || DEFAULT_API,
      apiKey: settings.apiKey || "",
      payload: {
        market: "GH",
        notes: $("notes").value.trim(),
        image: harvest.image || undefined,
        imageUrl: harvest.imageUrl || undefined,
        fields: harvest.fields,
      },
    });
    if (!fill?.ok) {
      setStatus(`AI request failed: ${fill?.error || "unknown error"}`, "err");
      return;
    }

    setStatus("Filling the form…");
    const apply = await sendToTab(tab.id, { type: "APPLY", values: fill.data.values });
    renderResults(apply?.results);
    renderWarnings([
      ...(fill.data.mock
        ? ["Mock fill this run — the note below says why (usually: no product photo uploaded, or AI creds missing on the server)."]
        : []),
      ...(fill.data.warnings || []),
    ]);

    const okCount = (apply?.results || []).filter((r) => r.ok).length;
    setStatus(`Filled ${okCount}/${Object.keys(fill.data.values).length} fields. Review, then submit on Jumia.`, "ok");
  } catch (e) {
    setStatus(`Error: ${e.message}`, "err");
  } finally {
    btn.disabled = false;
  }
});

async function activeJumiaTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab && /^https:\/\/vendorcenter\.jumia\.com\//.test(tab.url || "")) return tab;
  // Fallback: any Jumia vendor tab in the current window.
  const all = await chrome.tabs.query({ currentWindow: true });
  return all.find((t) => /^https:\/\/vendorcenter\.jumia\.com\//.test(t.url || "")) || null;
}

function sendToTab(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (chrome.runtime.lastError) {
        resolve(null); // content script not present (page needs reload)
      } else {
        resolve(resp);
      }
    });
  });
}
