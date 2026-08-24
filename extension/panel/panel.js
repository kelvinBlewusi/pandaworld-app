/**
 * Side panel orchestration.
 *
 * States:
 *   1. Not connected (no API key saved) → connect screen (Try for Free /
 *      paste an API key). The "open Jumia" banner sits above it whenever
 *      the active tab isn't Vendor Center, connected or not.
 *   2. Connected, not on a Jumia Add-Products tab → just the banner.
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
// Fixed — matches manifest.json's host_permissions, which is locked to just
// this origin (plus vendorcenter.jumia.com). No user-facing override; a dev
// pointing at localhost or a preview deployment needs to edit this constant
// AND add that origin to host_permissions, then reload the extension.
const apiBase = "https://pandaworldai.site";
const JUMIA_HOST_RE = /^https:\/\/vendorcenter\.jumia\.com\//;

// ── Settings persistence ─────────────────────────────────────────────────────
async function loadSettings() {
  const { apiKey } = await chrome.storage.local.get(["apiKey"]);
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
  // Matches the reference's compact pill — just the plan name, no "Plan:" prefix.
  $("planPill").textContent = (plan || "free").toUpperCase();
}

// ── View state ───────────────────────────────────────────────────────────────
function showConnectScreen(errorText) {
  $("statusRow").hidden = true;
  $("connectScreen").hidden = false;
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
  $("connectScreen").hidden = true;
}
function showMainForm() {
  $("jumiaBanner").hidden = true;
  $("mainForm").hidden = false;
}
function hideMainForm() {
  $("mainForm").hidden = true;
}

// ── Account status (Plan · Credits) ─────────────────────────────────────────
async function refreshAccount(apiKey) {
  const resp = await chrome.runtime.sendMessage({ type: "ACCOUNT", apiBase, apiKey });
  if (!resp?.ok) {
    // Key is invalid/revoked — drop it and go back to the connect screen.
    await chrome.storage.local.remove("apiKey");
    showConnectScreen(resp?.error || "Your key is no longer valid — reconnect.");
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
async function refreshView() {
  const tab = await activeJumiaTab();
  $("jumiaBanner").hidden = !!tab;

  const { apiKey } = await chrome.storage.local.get(["apiKey"]);
  if (!apiKey) return; // connect screen stays as-is regardless of tab
  if (tab) showMainForm();
  else hideMainForm();
}

// ── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  const { apiKey } = await loadSettings();
  $("getKeyLink").href = `${apiBase}/extension/dashboard`;
  $("privacyLink").href = `${apiBase}/privacy`;
  $("footerDashboard").dataset.href = `${apiBase}/extension/dashboard`;
  $("footerHelp").dataset.href = `${apiBase}/extension#how-it-works`;

  if (!apiKey) {
    showConnectScreen();
  } else {
    showConnected();
    await refreshAccount(apiKey);
  }
  await refreshView();
}
boot();

// Keep the banner/form in sync as the seller switches tabs while the panel
// stays open — MV3 side panels persist per-window, so this is the only way
// the view updates without the seller manually reopening the panel.
chrome.tabs.onActivated.addListener(() => refreshView());
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.status === "complete") refreshView(); });

// ── Try for Free — sends them to our own sign-up flow in a new tab ─────────
$("tryFree").addEventListener("click", () => {
  chrome.tabs.create({ url: `${apiBase}/sign-up?redirect_url=/extension/dashboard` });
});

// ── Connect ──────────────────────────────────────────────────────────────────
$("saveKey").addEventListener("click", async () => {
  const key = $("apiKey").value.trim();
  if (!key) {
    showConnectScreen("Paste your API key first.");
    return;
  }
  const btn = $("saveKey");
  btn.disabled = true;
  try {
    await chrome.storage.local.set({ apiKey: key });
    showConnected();
    const ok = await refreshAccount(key);
    if (ok) await refreshView();
  } finally {
    btn.disabled = false;
  }
});

// ── Disconnect (icon button + footer link) ──────────────────────────────────
async function logout() {
  await chrome.storage.local.remove("apiKey");
  $("apiKey").value = "";
  showConnectScreen();
  await refreshView();
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

// ── Main action ──────────────────────────────────────────────────────────────
$("autofill").addEventListener("click", async () => {
  const btn = $("autofill");
  btn.disabled = true;
  $("results").innerHTML = "";
  $("warnings").innerHTML = "";
  try {
    const { apiKey } = await chrome.storage.local.get(["apiKey"]);
    if (!apiKey) {
      showConnectScreen("Add your API key first.");
      return;
    }

    const tab = await activeJumiaTab();
    if (!tab) {
      await refreshView();
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

    // Writing style + refund policy ride along as extra freeform context,
    // same as the notes box — the AI fill pass already reads notes as
    // guidance (lib/ai/extension-fill.ts), no separate backend fields needed.
    const extraNotes = [];
    const writingStyle = $("writingStyle").value;
    if (writingStyle && writingStyle !== "SEO Optimized") extraNotes.push(`Writing style: ${writingStyle}`);
    const refundPolicy = $("refundPolicy").value;
    if (refundPolicy) extraNotes.push(`Refund policy: ${refundPolicy}`);
    const notes = [$("notes").value.trim(), ...extraNotes].filter(Boolean).join(". ");

    const fill = await chrome.runtime.sendMessage({
      type: "FILL",
      apiBase,
      apiKey,
      payload: {
        market: "GH",
        notes,
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
