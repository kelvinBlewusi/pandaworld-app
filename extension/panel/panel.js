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
// Matches lib/constants/support.ts SUPPORT_EMAIL — the extension bundle has
// no build step to import that file, so it's duplicated here.
const SUPPORT_EMAIL = "help.pandaworldai@gmail.com";
// Matches manifest.json's content_scripts/host_permissions exactly: only
// the two pages that actually render a product form. Vendor Center has
// plenty of other pages (Orders, Manage Products, Promotions, …) where
// there's no form to read and no content script even gets injected —
// this must agree with the manifest or the panel would claim "ready" on a
// page it can't actually act on.
const JUMIA_HOST_RE = /^https:\/\/vendorcenter\.jumia\.com\/products\/(add\/new|edit\/)/;
// Whether the account may use Polish images (features.imagePolish). The
// button shows either way; without it a tap says to upgrade.
let polishAllowed = false;

// ── Settings persistence ─────────────────────────────────────────────────────
async function loadSettings() {
  const { apiKey } = await chrome.storage.local.get(["apiKey"]);
  return { apiKey: apiKey || "" };
}

// ── UI helpers ───────────────────────────────────────────────────────────────
function setStatus(text, kind = "") {
  const s = $("status");
  s.hidden = false;
  s.textContent = text;
  s.className = `status ${kind}`; // full replace — also clears any "fadeOut" left from a prior run
}

// Auto-dismiss for the completed-fill summary (status text + checklist) —
// read it, then get out of the panel's way instead of sitting there
// forever. Only ever scheduled after a successful fill; error statuses
// stay put since they're actionable ("reload the tab", etc).
let resultsFadeTimer = null;
function clearResultsFadeTimer() {
  clearTimeout(resultsFadeTimer);
  resultsFadeTimer = null;
}
function scheduleResultsFade(ms = 10000) {
  clearResultsFadeTimer();
  resultsFadeTimer = setTimeout(() => {
    $("status").classList.add("fadeOut");
    $("results").classList.add("fadeOut");
    resultsFadeTimer = setTimeout(() => {
      $("status").hidden = true;
      $("results").hidden = true;
    }, 400); // matches the CSS transition duration above
  }, ms);
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
  ul.hidden = false;
  ul.classList.remove("fadeOut");
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
    const text = document.createElement("span");
    text.className = "wText";
    text.textContent = `⚠️ ${w}`;
    const close = document.createElement("button");
    close.className = "wClose";
    close.type = "button";
    close.setAttribute("aria-label", "Dismiss");
    close.textContent = "×";
    close.addEventListener("click", () => d.remove());
    d.append(text, close);
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
  $("calcSection").hidden = true;
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
  // The Pro and Business tools; the server checks again on use. Polish
  // shows to everyone, and a seller without the pack is told to upgrade
  // when they tap it (owner's request, 2026-10-06). A server that doesn't
  // send `features` yet lets admins use it.
  const features = resp.data.features;
  polishAllowed = !!(features ? features.imagePolish : resp.data.isAdmin);
  $("polishSection").hidden = false;
  setUpCalculator(features?.feeCalculator ? resp.data.country : null);
  return true;
}

// ── Price calculator (Pro and Business) ─────────────────────────────────────
//
// The site's calculator for the seller's own country (/embed/calculator),
// in a frame, with no way to switch country. Loaded the first time it's
// opened; the page reports its height so the frame fits it.

let calcCountry = null;
function setUpCalculator(country) {
  $("calcSection").hidden = !country;
  if (!country) return;
  $("calcCountry").textContent = `Jumia ${country.name}`;
  if (calcCountry === country.code) return;
  calcCountry = country.code;
  $("calcFrame").removeAttribute("src");
  if ($("calcSection").open) loadCalculator();
}
function loadCalculator() {
  const frame = $("calcFrame");
  if (calcCountry && !frame.getAttribute("src")) {
    frame.src = `${apiBase}/embed/calculator?country=${encodeURIComponent(calcCountry)}`;
  }
}
$("calcSection").addEventListener("toggle", () => {
  if ($("calcSection").open) loadCalculator();
});
window.addEventListener("message", (e) => {
  if (e.origin !== new URL(apiBase).origin || e.data?.type !== "pandaworld:embed-height") return;
  const height = Number(e.data.height);
  if (height > 0) $("calcFrame").style.height = `${Math.min(height, 2400)}px`;
});

// ── Jumia tab detection ──────────────────────────────────────────────────────
/**
 * The Vendor Center tab the seller is actually looking at, or null.
 *
 * Deliberately the ACTIVE tab only. This used to fall back to scanning
 * every tab in the window for any Vendor Center tab, which broke both ways
 * whenever one was open in the background: the "Open Jumia" banner stayed
 * hidden on unrelated sites (so the panel looked ready when it wasn't), and
 * Autofill would happily run — "Reading the form…" and all — against a tab
 * the seller couldn't even see, writing into a listing they weren't
 * looking at. Acting on the visible tab is the only safe reading.
 */
async function activeJumiaTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab && JUMIA_HOST_RE.test(tab.url || "") ? tab : null;
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
  $("polishUpgrade").href = `${apiBase}/pricing`;
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
// `info.url` as well as a completed load: Vendor Center is an Angular SPA,
// and navigating in or out of it can change the URL with no fresh page
// load, which would otherwise leave the banner showing the previous page's
// verdict.
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.status === "complete" || info.url) refreshView(); });
// Switching browser windows changes which tab is "active" for us too.
chrome.windows?.onFocusChanged?.addListener(() => refreshView());

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
$("footerReport").addEventListener("click", (e) => {
  e.preventDefault();
  const version = chrome.runtime.getManifest().version;
  const subject = encodeURIComponent("PandaWorldAI extension — problem report");
  const body = encodeURIComponent(`Describe what happened:\n\n\n— extension v${version}`);
  chrome.tabs.create({ url: `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}` });
});

// ── Open Jumia banner button ─────────────────────────────────────────────────
$("openJumia").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://vendorcenter.jumia.com/" });
});

// ── Main action ──────────────────────────────────────────────────────────────
$("autofill").addEventListener("click", async () => {
  const btn = $("autofill");
  btn.disabled = true;
  clearResultsFadeTimer();
  $("results").hidden = false;
  $("results").classList.remove("fadeOut");
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
      // Say why, rather than silently doing nothing — refreshView() alone
      // just swaps the banner in, which reads as the button being broken.
      setStatus("Open a Jumia Vendor Center tab to autofill a listing.", "err");
      hideProgress();
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
    if (!harvest.images || !harvest.images.length) {
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
    // the notes box. The AI fill pass reads notes as authoritative guidance
    // (lib/ai/extension-fill.ts) — but Warranty duration/address specifically
    // are ALSO parsed back out of this exact "Warranty duration: X"/"Warranty
    // address: Y" sentence format server-side (parseAdvancedWarrantyOptions
    // in lib/extension/fill.ts) and force-applied regardless of what the AI
    // itself returns, so keep this format ("Label: value", in this order) if
    // you touch it — no separate backend fields needed, but the label text
    // and ordering are load-bearing.
    const extraNotes = [];
    const writingStyle = $("writingStyle").value;
    if (writingStyle && writingStyle !== "SEO Optimized") extraNotes.push(`Writing style: ${writingStyle}`);
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
        images: harvest.images,
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
    scheduleResultsFade();
  } catch (e) {
    console.error("[PandaWorld] autofill failed:", e);
    setStatus("Something went wrong — please try again.", "err");
    hideProgress();
  } finally {
    btn.disabled = false;
  }
});

// ── Polish images (Pro and Business packs) ──────────────────────────────────
//
// Reads the rough photos uploaded on the form (HARVEST_IMAGES: the photos
// only, none of the form's fields), sends up to 3 to
// /api/extension/polish-images, which
// returns 4 generated product shots, shows them here, and asks the content
// script to put them in Jumia's image slots (PLACE_IMAGES). Every image can
// also be saved from the grid, in case the slots can't be filled.
//
// The request goes straight from the panel, not through the background
// worker like FILL: generating four images takes around half a minute,
// and Chrome may stop an idle worker after 30 seconds.

function setPolishStatus(text, kind = "") {
  const s = $("polishStatus");
  s.hidden = !text;
  s.textContent = text || "";
  s.className = `status ${kind}`;
  $("polishUpgrade").hidden = true;
}

/** Polish isn't in this seller's packs: say so, with the way to get it. */
function showPolishUpgrade() {
  setPolishStatus("Upgrade to use this feature.", "err");
  $("polishUpgrade").hidden = false;
}

/** Load an image (data: or https) into a canvas-ready bitmap. */
async function loadBitmap(src) {
  const blob = await (await fetch(src)).blob();
  return createImageBitmap(blob);
}

/**
 * A JPEG data URL of the image, longest side at most `maxSide`, on white
 * (no transparency). `square` makes it 1:1, as Jumia wants: "pad" centres
 * it on white (a product shot on white), "crop" takes the centre (a
 * scene). The model doesn't reliably return squares.
 */
async function toJpegDataUrl(src, maxSide, quality, square) {
  const bmp = await loadBitmap(src);
  let sx = 0, sy = 0, sw = bmp.width, sh = bmp.height;
  if (square === "crop") {
    const side = Math.min(bmp.width, bmp.height);
    sx = (bmp.width - side) / 2; sy = (bmp.height - side) / 2; sw = side; sh = side;
  }
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.round(sw * scale), h = Math.round(sh * scale);
  const canvas = document.createElement("canvas");
  canvas.width = square === "pad" ? Math.max(w, h) : w;
  canvas.height = square === "pad" ? Math.max(w, h) : h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, sx, sy, sw, sh, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  return canvas.toDataURL("image/jpeg", quality);
}

function renderPolishGrid(images) {
  const grid = $("polishGrid");
  grid.innerHTML = "";
  for (const img of images) {
    const fig = document.createElement("figure");
    const el = document.createElement("img");
    el.src = img.dataUrl;
    el.alt = img.label;
    const cap = document.createElement("figcaption");
    const label = document.createElement("span");
    label.textContent = img.label;
    const save = document.createElement("a");
    save.href = img.dataUrl;
    save.download = img.name;
    save.textContent = "Save";
    cap.append(label, save);
    fig.append(el, cap);
    grid.appendChild(fig);
  }
  grid.hidden = images.length === 0;
}

$("polishBtn").addEventListener("click", async () => {
  if (!polishAllowed) {
    showPolishUpgrade();
    return;
  }
  const btn = $("polishBtn");
  btn.disabled = true;
  $("polishGrid").hidden = true;
  try {
    const { apiKey } = await chrome.storage.local.get(["apiKey"]);
    const tab = await activeJumiaTab();
    if (!apiKey || !tab) {
      setPolishStatus("Open the Add Products page on Jumia first.", "err");
      return;
    }

    setPolishStatus("Reading your photos…");
    const harvest = await sendToTab(tab.id, { type: "HARVEST_IMAGES" });
    if (!harvest?.images?.length) {
      setPolishStatus("No product photo found — upload at least one on Jumia, then try again.", "err");
      return;
    }
    // Shrunk before sending: phone photos are several MB each, past what
    // one request can carry, and the model needs nowhere near that much.
    const sources = await Promise.all(harvest.images.slice(0, 3).map(async (i) =>
      i.dataUrl ? { dataUrl: await toJpegDataUrl(i.dataUrl, 1536, 0.85) } : { httpUrl: i.httpUrl },
    ));

    setPolishStatus(`Creating 4 product images from ${sources.length} photo${sources.length === 1 ? "" : "s"}… about 30 seconds.`);
    $("polishProgress").hidden = false;
    const res = await fetch(`${apiBase}/api/extension/polish-images`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ images: sources, notes: $("notes").value.trim() }),
    });
    const data = await res.json().catch(() => null);
    if (res.status === 403 && data?.upgrade) {
      polishAllowed = false;
      showPolishUpgrade();
      return;
    }
    if (!res.ok || !data?.images) {
      setPolishStatus(data?.error || `Something went wrong (HTTP ${res.status}) — please try again.`, "err");
      return;
    }

    if (data.creditsRemaining != null || data.unlimitedCredits) {
      setCreditsText(data.creditsRemaining, data.unlimitedCredits);
    }

    // As JPEG, which Jumia takes, whatever format the model returned.
    const shots = data.images.filter((s) => s.url);
    const images = await Promise.all(shots.map(async (s) => ({
      label:   s.label,
      name:    `pandaworld-${s.id}.jpg`,
      dataUrl: await toJpegDataUrl(s.url, 2000, 0.92, s.id === "main" || s.id === "angle" ? "pad" : "crop"),
    })));
    renderPolishGrid(images);

    setPolishStatus("Putting them in Jumia's image slots…");
    const placed = await sendToTab(tab.id, {
      type:   "PLACE_IMAGES",
      images: images.map((i) => ({ dataUrl: i.dataUrl, name: i.name })),
    });
    const missed = data.images.length - shots.length;
    const missedNote = missed ? ` (${missed} couldn't be made)` : "";
    if (placed?.ok && placed.placed >= images.length) {
      setPolishStatus(`Done — ${placed.placed} image${placed.placed === 1 ? "" : "s"} added to the listing${missedNote}. Check them on Jumia before you submit.`, "ok");
    } else if (placed?.ok && placed.placed > 0) {
      setPolishStatus(`${placed.placed} of ${images.length} images added to the listing${missedNote}. Save the rest below and add them on Jumia.`, "ok");
    } else {
      setPolishStatus(`Your ${images.length} images are ready${missedNote}, but I couldn't put them in the slots (${placed?.error || "no image slots found"}). Save them below and add them on Jumia.`, "err");
    }
  } catch (e) {
    console.error("[PandaWorld] polish failed:", e);
    setPolishStatus("Something went wrong — please try again.", "err");
  } finally {
    $("polishProgress").hidden = true;
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
