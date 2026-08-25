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

// Determinate steps for the parts we know finish fast (harvest, apply);
// the AI call is the one open-ended wait, so it holds its width and pulses
// instead of pretending to know how close it is to done.
function setProgress(pct, { pulsing = false } = {}) {
  const track = $("progressTrack");
  const bar = $("progressBar");
  track.hidden = false;
  bar.style.width = `${pct}%`;
  bar.classList.toggle("pulse", pulsing);
}
function hideProgress() {
  $("progressTrack").hidden = true;
  $("progressBar").classList.remove("pulse");
  $("progressBar").style.width = "0%";
}
function renderResults(results) {
  const ul = $("results");
  ul.innerHTML = "";
  for (const r of results || []) {
    const li = document.createElement("li");
    li.className = r.skipped ? "skip" : r.ok ? "ok" : "bad";
    const mark = r.skipped ? "–" : r.ok ? "✓" : "✕";
    li.innerHTML = `<span class="mark">${mark}</span>
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

let toastTimer = null;
function showToast(text, kind = "ok", ms = 3000) {
  const el = $("toast");
  clearTimeout(toastTimer);
  el.textContent = text;
  el.className = `toast ${kind}`;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add("show"));
  toastTimer = setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => { el.hidden = true; }, 200); // matches the CSS transition
  }, ms);
}

function setCreditsText(credits, unlimited) {
  $("creditsText").textContent = unlimited ? "∞ credits" : credits == null ? "— credits" : `${credits} credits`;
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
    // Only a genuine 401 (invalid/revoked key) should disconnect the seller —
    // a network blip or a server hiccup (status 0 or 5xx) shouldn't wipe
    // their saved key and boot them back to the connect screen.
    if (resp?.status === 401) {
      await chrome.storage.local.remove("apiKey");
      showConnectScreen(resp?.error || "Your key is no longer valid — reconnect.");
    } else {
      $("creditsText").textContent = "couldn't load";
    }
    return false;
  }
  setPlanText(resp.data.plan);
  setCreditsText(resp.data.credits, resp.data.unlimitedCredits);
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

// ── Field help — click-only reveal of an in-flow text block (no hover
// trigger, nothing that can clip against the panel's own width). ──────────
function setHelpOpen(btn, open) {
  btn.classList.toggle("open", open);
  btn.setAttribute("aria-expanded", String(open));
  const text = document.getElementById(btn.getAttribute("aria-describedby"));
  if (text) text.hidden = !open;
}
document.querySelectorAll(".helpIcon").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    setHelpOpen(btn, !btn.classList.contains("open"));
  });
});
document.addEventListener("click", () => {
  document.querySelectorAll(".helpIcon.open").forEach((b) => setHelpOpen(b, false));
});

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
    if (ok) {
      await refreshView();
      showToast("Connected to PandaWorldAI");
    }
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
    setProgress(15);
    const harvest = await sendToTab(tab.id, { type: "HARVEST" });
    if (!harvest?.ok) {
      setStatus("Could not read the page. Reload the Jumia tab and try again.", "err");
      hideProgress();
      return;
    }
    if (!harvest.fields.length) {
      setStatus("No fields found — did you pick a category to open the form?", "err");
      hideProgress();
      return;
    }
    if (!harvest.image && !harvest.imageUrl) {
      setStatus("No product photo detected — upload one on Jumia, then try again.", "err");
      hideProgress();
      return;
    }
    setStatus(`Found ${harvest.fields.length} fields. Asking AI…`);
    // The AI call is the one genuinely unpredictable wait (a single vision
    // request, no sub-steps to report) — hold the bar here and pulse it
    // rather than guessing at a percentage that would just be wrong.
    setProgress(35, { pulsing: true });

    // Every Advanced Option rides along as extra freeform context, same as
    // the notes box — the AI fill pass reads notes as authoritative guidance
    // (lib/ai/extension-fill.ts) and, for a constrained dropdown like
    // Warranty Duration, is told to match it against the field's real
    // harvested options — no separate backend fields needed.
    const extraNotes = [];
    const writingStyle = $("writingStyle").value;
    if (writingStyle && writingStyle !== "SEO Optimized") extraNotes.push(`Writing style: ${writingStyle}`);
    const refundPolicy = $("refundPolicy").value;
    if (refundPolicy) extraNotes.push(`Refund policy: ${refundPolicy}`);
    const warrantyDuration = $("warrantyDuration").value;
    if (warrantyDuration) extraNotes.push(`Warranty duration: ${warrantyDuration}`);
    const warrantyAddress = $("warrantyAddress").value.trim();
    if (warrantyAddress) extraNotes.push(`Warranty address: ${warrantyAddress}`);
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
      setStatus(fill?.error || "Something went wrong — please try again.", "err");
      hideProgress();
      return;
    }

    setStatus("Filling the form…");
    setProgress(85);
    const apply = await sendToTab(tab.id, {
      type: "APPLY",
      values: fill.data.values,
      overwrite: $("overwriteExisting").checked,
    });
    renderResults(apply?.results);
    renderWarnings(fill.data.warnings || []);
    setProgress(100);
    setTimeout(hideProgress, 700);

    const results = apply?.results || [];
    const okCount = results.filter((r) => r.ok).length;
    const skippedCount = results.filter((r) => r.skipped).length;
    if (fill.data.creditsRemaining != null || fill.data.unlimitedCredits) {
      setCreditsText(fill.data.creditsRemaining, fill.data.unlimitedCredits);
    }
    const skipNote = skippedCount ? ` (${skippedCount} already had content, left as-is)` : "";
    setStatus(`Filled ${okCount}/${Object.keys(fill.data.values).length} fields${skipNote}. Review, then submit on Jumia.`, "ok");
  } catch (e) {
    console.error("[PandaWorld] autofill failed:", e);
    setStatus("Something went wrong — please try again.", "err");
    hideProgress();
  } finally {
    btn.disabled = false;
  }
});

function sendMessageOnce(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (chrome.runtime.lastError) {
        resolve(null); // content script not present
      } else {
        resolve(resp);
      }
    });
  });
}

/** Re-injects both content scripts (isolated + MAIN world, matching
 *  manifest.json's content_scripts entries) into an already-open tab.
 *  Fails harmlessly (returns false) on a page Chrome won't allow scripting
 *  into (e.g. not actually a Jumia Vendor Center page). */
async function injectContentScripts(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content/content.js"] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content/mainworld.js"], world: "MAIN" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Send a message to the Jumia tab's content script, auto-recovering when
 * it isn't there to receive it. Every extension update severs the
 * connection for any Jumia tab that was already open when the update
 * happened — normally the seller has to manually reload that tab before
 * Autofill works again. Instead: on a failed send, inject the content
 * scripts fresh into the tab and retry once, so an update never blocks a
 * seller who hasn't reloaded yet.
 */
async function sendToTab(tabId, msg) {
  const first = await sendMessageOnce(tabId, msg);
  if (first !== null) return first;
  const injected = await injectContentScripts(tabId);
  if (!injected) return null;
  return sendMessageOnce(tabId, msg);
}
