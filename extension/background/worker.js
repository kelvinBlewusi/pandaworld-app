/**
 * Background service worker (MV3).
 *
 * Two jobs:
 *  1. Open the side panel when the toolbar icon is clicked.
 *  2. Own the network call to PandaWorld (POST /api/extension/fill). Doing
 *     the fetch here keeps the API key server-bound to one place and uses the
 *     extension's host_permissions (no page CORS). In Phase 1 this is where
 *     the pw_live_ key gets attached from chrome.storage.local.
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
  return false;
});

async function doFill({ apiBase, apiKey, payload }) {
  const base = (apiBase || "http://localhost:3002").replace(/\/+$/, "");
  const url = `${base}/api/extension/fill`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Auth is stubbed in Phase 0; the header is sent anyway so the seam
        // is exercised. Phase 1 validates this against extension_api_keys.
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, error: `Non-JSON response (${res.status}): ${text.slice(0, 200)}` };
    }
    if (!res.ok) return { ok: false, error: data?.error || `HTTP ${res.status}` };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: `Network error calling ${url} — ${e.message}` };
  }
}
