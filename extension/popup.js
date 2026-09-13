const STORAGE_KEY = 'ezoicEarnings';

function render(state) {
  const totalEl = document.getElementById('total');
  if (!totalEl) return; // popup markup not ready / mismatched build - bail out quietly

  const sum = state && typeof state.sum === 'number' ? state.sum : 0;
  totalEl.textContent = '$' + sum.toFixed(2);

  const breakdown = document.getElementById('breakdown');
  if (breakdown) {
    breakdown.innerHTML = '';
    if (state && state.byPlatform) {
      for (const [platform, value] of Object.entries(state.byPlatform)) {
        const row = document.createElement('div');
        row.className = 'row';
        row.innerHTML = '<span>' + platform + '</span><span>$' + value.toFixed(2) + '</span>';
        breakdown.appendChild(row);
      }
    }
  }

  const projectionEl = document.getElementById('projection');
  const windowMetaEl = document.getElementById('windowMeta');
  if (projectionEl && windowMetaEl) {
    if (state && typeof state.projected24h === 'number') {
      const spanText = state.spanHours ? state.spanHours.toFixed(1) + 'h' : 'n/a';
      projectionEl.textContent = '$' + state.projected24h.toFixed(2) + ' / 24h';
      windowMetaEl.textContent =
        'Based on $' +
        sum.toFixed(2) +
        ' across ' +
        state.pointCount +
        ' points spanning ' +
        spanText +
        ' (' +
        state.startLabel +
        ' → ' +
        state.endLabel +
        ').';
    } else {
      projectionEl.textContent = '—';
      windowMetaEl.textContent = 'Click "Refresh" to compute the projection from the visible chart.';
    }
  }

  const meta = document.getElementById('meta');
  if (meta) {
    if (state && state.lastUpdate) {
      meta.textContent = 'Last updated at ' + new Date(state.lastUpdate).toLocaleTimeString() + '.';
    } else {
      meta.textContent = 'Starting up the background tracker for the first time — this can take a few seconds.';
    }
  }
}

function showError(message) {
  const el = document.getElementById('error');
  if (el) el.textContent = message || '';
}

function init() {
  try {
    chrome.storage.local.get([STORAGE_KEY], (data) => render(data[STORAGE_KEY]));

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[STORAGE_KEY]) render(changes[STORAGE_KEY].newValue);
    });
  } catch (e) {
    // chrome.* APIs throw synchronously if the extension was just reloaded
    // while this popup was already open ("Extension context invalidated").
    // Closing and reopening the popup picks up a fresh, valid context.
    showError('Extension was reloaded — close this popup and reopen it.');
    return;
  }

  const refreshBtn = document.getElementById('refresh');
  if (!refreshBtn) return;

  refreshBtn.addEventListener('click', async () => {
    showError('');
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Refreshing...';

    try {
      // The background service worker owns a dedicated, minimized tab for
      // this - the popup no longer needs to know which tab it is, or care
      // whether the user has an Ezoic tab open at all.
      chrome.runtime.sendMessage({ type: 'REQUEST_REFRESH' }, (response) => {
        refreshBtn.disabled = false;
        refreshBtn.textContent = 'Refresh';

        if (chrome.runtime.lastError) {
          showError('Could not reach the background tracker. (' + chrome.runtime.lastError.message + ')');
          return;
        }
        if (!response || !response.ok) {
          const detail =
            response && (response.message || response.reason) ? ' (' + (response.message || response.reason) + ')' : '';
          showError('Could not compute the projection yet — try again in a moment.' + detail);
        }
      });
    } catch (e) {
      refreshBtn.disabled = false;
      refreshBtn.textContent = 'Refresh';
      const isInvalidated = e && /context invalidated/i.test(e.message || '');
      showError(
        isInvalidated
          ? 'Extension was reloaded — close this popup and reopen it.'
          : (e && e.message) || 'Could not reach the background tracker.'
      );
    }
  });
}

init();
