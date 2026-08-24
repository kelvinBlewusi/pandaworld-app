/**
 * Background service worker (MV3).
 *
 * Jobs:
 *  1. Open the side panel when the toolbar icon is clicked.
 *  2. Own the network calls to PandaWorld (POST /api/extension/fill, GET
 *     /api/extension/account). Doing the fetch here keeps the API key
 *     server-bound to one place and uses the extension's host_permissions
 *     (no page CORS).
 *
 * Every failure response includes `status` (HTTP status, or 0 for a network
 * error / non-JSON body) so panel.js can tell "your key is invalid" (401 —
 * should disconnect) apart from "the server hiccuped" (should NOT disconnect
 * a seller over a blip).
 */

// Open the side panel on action click.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "FILL") {
    doFill(msg).then(sendResponse);
    return true; // async response
  }
  if (msg?.type === "ACCOUNT") {
    doAccount(msg).then(sendResponse);
    return true;
  }
  return false;
});

async function callApi(url, init) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    return { ok: false, status: 0, error: `Network error — ${e.message}` };
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, status: res.status, error: `Unexpected server response (HTTP ${res.status})` };
  }
  if (!res.ok) return { ok: false, status: res.status, error: data?.error || `HTTP ${res.status}` };
  return { ok: true, status: res.status, data };
}

async function doFill({ apiBase, apiKey, payload }) {
  const base = (apiBase || "https://pandaworldai.site").replace(/\/+$/, "");
  return callApi(`${base}/api/extension/fill`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(payload),
  });
}

async function doAccount({ apiBase, apiKey }) {
  const base = (apiBase || "https://pandaworldai.site").replace(/\/+$/, "");
  return callApi(`${base}/api/extension/account`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
}
