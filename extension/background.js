// Manages a dedicated, minimized background window that hosts the Ezoic
// Real-Time page, so the user doesn't have to keep a tab open themselves.
// The popup and the auto-poll both go through this one managed tab, which
// removes the "which of several matching tabs do I message?" ambiguity we
// used to hit when the user's own tab and a leftover/test tab both matched.

const REALTIME_URL = 'https://analytics.ezoic.com/reports/realtime';
const MANAGED_TAB_ID_KEY = 'ezoicManagedTabId';

function getManagedTabId() {
  return new Promise((resolve) => {
    chrome.storage.local.get([MANAGED_TAB_ID_KEY], (data) => resolve(data[MANAGED_TAB_ID_KEY] || null));
  });
}

function setManagedTabId(tabId) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [MANAGED_TAB_ID_KEY]: tabId }, resolve);
  });
}

function getTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => resolve(chrome.runtime.lastError ? null : tab));
  });
}

function createManagedWindow() {
  return new Promise((resolve) => {
    chrome.windows.create({ url: REALTIME_URL, focused: false, state: 'minimized', type: 'popup' }, (win) => {
      resolve(win && win.tabs && win.tabs[0] ? win.tabs[0] : null);
    });
  });
}

// Returns the tab id of the managed background tab, creating one if it
// doesn't exist yet (first run) or was closed since.
async function ensureManagedTab() {
  const existingId = await getManagedTabId();
  if (existingId) {
    const tab = await getTab(existingId);
    if (tab) return tab.id;
  }
  const tab = await createManagedWindow();
  if (!tab) throw new Error('Could not create the background Ezoic tab.');
  await setManagedTabId(tab.id);
  return tab.id;
}

chrome.runtime.onInstalled.addListener(() => {
  ensureManagedTab().catch((err) => console.error('[Ezoic Earnings Tracker] setup failed:', err));
});
chrome.runtime.onStartup.addListener(() => {
  ensureManagedTab().catch((err) => console.error('[Ezoic Earnings Tracker] setup failed:', err));
});

chrome.tabs.onRemoved.addListener(async (closedTabId) => {
  const managedId = await getManagedTabId();
  if (closedTabId !== managedId) return;
  await setManagedTabId(null);
  ensureManagedTab().catch((err) => console.error('[Ezoic Earnings Tracker] recreate failed:', err));
});

// Relays a manual refresh request from the popup to the managed tab, waiting
// for it to exist first (covers the very first click after install).
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'REQUEST_REFRESH') {
    (async () => {
      try {
        const tabId = await ensureManagedTab();
        chrome.tabs.sendMessage(tabId, { type: 'REFRESH' }, (response) => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, reason: 'error', message: chrome.runtime.lastError.message });
            return;
          }
          sendResponse(response);
        });
      } catch (err) {
        sendResponse({ ok: false, reason: 'error', message: String(err && err.message ? err.message : err) });
      }
    })();
    return true; // keep the message channel open for the async response
  }
  return false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.ezoicEarnings) return;
  const state = changes.ezoicEarnings.newValue;
  const sum = state && typeof state.sum === 'number' ? state.sum : 0;
  chrome.action.setBadgeText({ text: '$' + sum.toFixed(2) });
  chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
});
