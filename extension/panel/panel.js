/**
 * Side panel orchestration.
 *
 * States:
 *   1. Not connected (no API key saved) → connect banner.
 *   2. Connected, not on a Jumia Add-Products tab → "open Jumia" banner.
 *   3. Connected, on a Jumia tab → the autofill form.
 *
 * Flow on "Autofill":
 *   1. find the active Jumia tab
 *   2. ask the content script to HARVEST (image + rendered fields)
 *   3. ask the background worker to call the API with that payload
 *   4. ask the content script to APPLY the returned values
 *   5. render per-field results + warnings
 */

const $ = (id) => document.getElementById(id);
const DEFAULT_API = "https://pandaworldai.site";
const JUMIA_HOST_RE = /^https:\/\/vendorcenter\.jumia\.com\//;

let apiBase = DEFAULT_API;

// ── Settings persistence ─────────────────────────────────────────────────────
async function loadSettings() {
  const { apiBase: savedBase, apiKey } = await chrome.storage.local.get(["apiBase", "apiKey"]);
  apiBase = savedBase || DEFAULT_API;
  $("apiBase").value = apiBase;
  return { apiKey: apiKey || "" };
}

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

function setCreditsText(credits) {
  $("creditsText").textContent = credits == null ? "— credits" : `${credits} credits`;
}
function setPlanText(plan) {
  $("planPill").textContent = `Plan: ${plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : "—"}`;
}

// ── View state ───────────────────────────────────────────────────────────────
function showConnectBanner(errorText) {
  $("statusRow").hidden = true;
  $("connectBanner").hidden = false;
  $("jumiaBanner").hidden = true;
  $("mainForm").hidden = true;
  const err = $("connectError");
  if (errorText) {
    err.textContent = errorText;
    err.hidden = false;
  } else {
    err.hidden = true;
  }
}
function showConnected() {
  $("statusRow").hidden = false;
  $("connectBanner").hidden = true;
}
function showJumiaBanner() {
  $("jumiaBanner").hidden = false;
  $("mainForm").hidden = true;
}
function showMainForm() {
  $("jumiaBanner").hidden = true;
  $("mainForm").hidden = false;
}

// ── Account status (Plan · Credits) ─────────────────────────────────────────
async function refreshAccount(apiKey) {
  const resp = await chrome.runtime.sendMessage({ type: "ACCOUNT", apiBase, apiKey });
  if (!resp?.ok) {
    // Key is invalid/revoked — drop it and go back to the connect banner.
    await chrome.storage.local.remove("apiKey");
    showConnectBanner(resp?.error || "Your key is no longer valid — reconnect.");
    return false;
  }
  setPlanText(resp.data.plan);
  setCreditsText(resp.data.credits);
  return true;
}

// ── Jumia tab detection ──────────────────────────────────────────────────────
async function activeJumiaTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab && JUMIA_HOST_RE.test(tab.url || "")) return tab;
  const all = await chrome.tabs.query({ currentWindow: true });
  return all.find((t) => JUMIA_HOST_RE.test(t.url || "")) || null;
}
async function refreshJumiaState() {
  const { apiKey } = await chrome.storage.local.get(["apiKey"]);
  if (!apiKey) return; // not connected — connect banner already showing
  const tab = await activeJumiaTab();
  if (tab) showMainForm();
  else showJumiaBanner();
}

// ── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  const { apiKey } = await loadSettings();
  $("getKeyLink").href = `${apiBase}/extension/dashboard`;
  $("footerDashboard").dataset.href = `${apiBase}/extension/dashboard`;
  $("footerHelp").dataset.href = `${apiBase}/extension#how-it-works`;

  if (!apiKey) {
    showConnectBanner();
    return;
  }
  showConnected();
  const ok = await refreshAccount(apiKey);
  if (ok) await refreshJumiaState();
}
boot();

// Keep the banner/form in sync as the seller switches tabs while the panel
// stays open — MV3 side panels persist per-window, so this is the only way
// the view updates without the seller manually reopening the panel.
chrome.tabs.onActivated.addListener(() => refreshJumiaState());
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.status === "complete") refreshJumiaState(); });

// ── Connect ──────────────────────────────────────────────────────────────────
$("saveKey").addEventListener("click", async () => {
  const key = $("apiKey").value.trim();
  if (!key) {
    showConnectBanner("Paste your API key first.");
    return;
  }
  const btn = $("saveKey");
  btn.disabled = true;
  try {
    await chrome.storage.local.set({ apiKey: key });
    showConnected();
    const ok = await refreshAccount(key);
    if (ok) await refreshJumiaState();
  } finally {
    btn.disabled = false;
  }
});

// ── Disconnect (icon button + footer link) ──────────────────────────────────
async function logout() {
  await chrome.storage.local.remove("apiKey");
  $("apiKey").value = "";
  showConnectBanner();
}
$("logoutBtn").addEventListener("click", logout);
$("footerLogout").addEventListener("click", (e) => { e.preventDefault(); logout(); });

// ── Footer links (open in a new browser tab, not the panel) ────────────────
$("footerDashboard").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: e.currentTarget.dataset.href });
});
$("footerHelp").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: e.currentTarget.dataset.href });
});

// ── Open Jumia banner button ─────────────────────────────────────────────────
$("openJumia").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://vendorcenter.jumia.com/" });
});

// ── Advanced settings (API base URL — dev/testing only) ────────────────────
$("saveSettings").addEventListener("click", async () => {
  const newBase = $("apiBase").value.trim() || DEFAULT_API;
  await chrome.storage.local.set({ apiBase: newBase });
  apiBase = newBase;
  $("getKeyLink").href = `${apiBase}/extension/dashboard`;
  $("footerDashboard").dataset.href = `${apiBase}/extension/dashboard`;
  $("footerHelp").dataset.href = `${apiBase}/extension#how-it-works`;
  const { apiKey } = await chrome.storage.local.get(["apiKey"]);
  if (apiKey) await refreshAccount(apiKey);
});

// ── Main action ──────────────────────────────────────────────────────────────
$("autofill").addEventListener("click", async () => {
  const btn = $("autofill");
  btn.disabled = true;
  $("results").innerHTML = "";
  $("warnings").innerHTML = "";
  try {
    const { apiKey } = await chrome.storage.local.get(["apiKey"]);
    if (!apiKey) {
      showConnectBanner("Add your API key first.");
      return;
    }

    const tab = await activeJumiaTab();
    if (!tab) {
      showJumiaBanner();
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

    const fill = await chrome.runtime.sendMessage({
      type: "FILL",
      apiBase,
      apiKey,
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
    if (fill.data.creditsRemaining != null) setCreditsText(fill.data.creditsRemaining);
    setStatus(`Filled ${okCount}/${Object.keys(fill.data.values).length} fields. Review, then submit on Jumia.`, "ok");
  } catch (e) {
    setStatus(`Error: ${e.message}`, "err");
  } finally {
    btn.disabled = false;
  }
});

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
