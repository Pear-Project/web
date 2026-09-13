// Ezoic Live Earnings Tracker - content script
// Runs on analytics.ezoic.com/reports/realtime. Highcharts on this page is not
// exposed as a global object, but each chart point has a hidden accessibility
// tooltip text node that Highcharts updates on hover/mouseover with the exact
// values ("Ezoic Platform: Projected Revenue: $0.02"). We simulate hovering
// every point currently on screen to read the exact dollar amounts.
//
// Every recompute (automatic poll or manual Refresh) starts from zero and
// re-sums whatever is currently visible on the chart - it does not add to a
// previous total. This is intentional: the chart's own window is the source
// of truth, so re-reading it always reflects exactly what's on screen right
// now, with no risk of double-counting across reloads or polls.

(function () {
  console.log('[Ezoic Earnings Tracker] content script loaded on', location.href);

  const STORAGE_KEY = 'ezoicEarnings';
  const POLL_INTERVAL_MS = 20000;
  const HOVER_DELAY_MS = 60;

  function findChartContainer() {
    const containers = document.querySelectorAll('.highcharts-container');
    for (const c of containers) {
      const svg = c.querySelector('svg');
      if (!svg) continue;
      const texts = Array.from(svg.querySelectorAll('text')).map((t) => t.textContent);
      const hasRevenue = texts.some((t) => t.includes('Projected Revenue'));
      const hasTimeAxis = texts.some((t) => /\d{1,2}:\d{2}\s*(AM|PM)/.test(t));
      if (hasRevenue && hasTimeAxis) return { container: c, svg };
    }
    return null;
  }

  function findSweepablePoints(svg) {
    // Pick the marker group with the MOST points, not just the first
    // non-empty one: Highcharts can render a small transient group (e.g. a
    // shared-tooltip hover highlight, 1-2 points) that also matches
    // "highcharts-markers" and would otherwise be picked by mistake.
    const groups = svg.querySelectorAll('g[class*="highcharts-markers"]');
    let best = null;
    for (const g of groups) {
      const pts = g.querySelectorAll('path.highcharts-point');
      if (!best || pts.length > best.length) best = pts;
    }
    return best && best.length > 0 ? best : null;
  }

  async function sweepChart() {
    const found = findChartContainer();
    if (!found) return null;
    const initialPoints = findSweepablePoints(found.svg);
    if (!initialPoints || initialPoints.length === 0) return null;
    const pointCount = initialPoints.length;

    const rows = [];
    for (let i = 0; i < pointCount; i++) {
      // Re-query fresh each time instead of reusing a NodeList captured once:
      // this chart auto-refreshes live, and can replace its point elements
      // mid-sweep, which would otherwise leave us hovering detached nodes.
      const currentPoints = findSweepablePoints(found.svg);
      if (!currentPoints || i >= currentPoints.length) continue;
      const point = currentPoints[i];

      const r = point.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window };
      point.dispatchEvent(new MouseEvent('mouseover', opts));
      point.dispatchEvent(new MouseEvent('mousemove', opts));
      await new Promise((res) => setTimeout(res, HOVER_DELAY_MS));

      const texts = Array.from(found.svg.querySelectorAll('text')).map((t) => t.textContent);
      const tooltip = texts[texts.length - 1] || '';
      const timeMatch = tooltip.match(/^([\d:apAPM\s]+)/);
      if (!timeMatch) continue;
      const time = timeMatch[1].trim();

      // The platform prefix ("Ezoic Platform: Projected Revenue: $X") only
      // shows up when comparing multiple platforms; viewing a single
      // platform can render it as plain "Projected Revenue: $X" instead, so
      // that prefix has to be optional here.
      const revenueRegex = /(?:([A-Za-z][A-Za-z ]*?): )?Projected Revenue:\s*\$([\d.]+)/g;
      let m;
      let total = 0;
      const byPlatform = {};
      while ((m = revenueRegex.exec(tooltip)) !== null) {
        const platform = (m[1] || 'Total').trim();
        const value = parseFloat(m[2]);
        byPlatform[platform] = value;
        total += value;
      }
      rows.push({ time, total, byPlatform });
    }

    // Hide the tooltip again so we don't leave a stuck hover state.
    document.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));

    // De-duplicate by time label: the chart can re-render mid-sweep (it's
    // live), which can occasionally return the same point twice.
    const seen = new Set();
    return rows.filter((row) => {
      if (seen.has(row.time)) return false;
      seen.add(row.time);
      return true;
    });
  }

  // Parses a "H:MM AM/PM" label into minutes-since-midnight (0-1439).
  function parseTimeLabel(label) {
    const m = label.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!m) return null;
    let h = parseInt(m[1], 10) % 12;
    const min = parseInt(m[2], 10);
    if (/PM/i.test(m[3])) h += 12;
    return h * 60 + min;
  }

  // Works out how many hours the current chart window actually spans, from
  // the point labels themselves, instead of assuming a fixed interval - the
  // dashboard's interval dropdown (1 Minute, 5 Minutes, ...) can change.
  function computeWindowSpan(rows) {
    if (rows.length < 2) return null;

    let entries = rows
      .map((r) => ({ label: r.time, minutes: parseTimeLabel(r.time) }))
      .filter((e) => e.minutes !== null);
    if (entries.length < 2) return null;
    entries.sort((a, b) => a.minutes - b.minutes);

    // Handle a window that crosses midnight: if there's a big gap, everything
    // before the gap actually belongs after the values on the other side.
    let maxGap = 0;
    let splitAt = -1;
    for (let i = 1; i < entries.length; i++) {
      const gap = entries[i].minutes - entries[i - 1].minutes;
      if (gap > maxGap) {
        maxGap = gap;
        splitAt = i;
      }
    }
    const wrapGap = 24 * 60 - entries[entries.length - 1].minutes + entries[0].minutes;
    if (wrapGap < maxGap && splitAt !== -1) {
      entries = entries
        .slice(splitAt)
        .concat(entries.slice(0, splitAt).map((e) => ({ label: e.label, minutes: e.minutes + 24 * 60 })));
    }

    const span = entries[entries.length - 1].minutes - entries[0].minutes;
    if (span <= 0) return null;
    return {
      spanHours: span / 60,
      startLabel: entries[0].label,
      endLabel: entries[entries.length - 1].label,
    };
  }

  function setState(state) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEY]: state }, resolve);
    });
  }

  // Recomputes everything from scratch, from whatever is currently visible
  // on the chart, and overwrites the stored state (no accumulation).
  async function recompute() {
    try {
      const rows = await sweepChart();
      console.log('[Ezoic Earnings Tracker] swept rows:', rows);
      if (!rows || rows.length === 0) return { ok: false, reason: 'chart-not-found' };

      const sum = rows.reduce((acc, r) => acc + r.total, 0);
      const byPlatform = {};
      for (const row of rows) {
        for (const [platform, value] of Object.entries(row.byPlatform)) {
          byPlatform[platform] = (byPlatform[platform] || 0) + value;
        }
      }
      const span = computeWindowSpan(rows);
      console.log('[Ezoic Earnings Tracker] span:', span, 'pointCount:', rows.length);

      const state = {
        sum,
        byPlatform,
        spanHours: span ? span.spanHours : null,
        pointCount: rows.length,
        projected24h: span ? sum * (24 / span.spanHours) : null,
        startLabel: span ? span.startLabel : null,
        endLabel: span ? span.endLabel : null,
        lastUpdate: Date.now(),
      };
      await setState(state);
      return { ok: true, state };
    } catch (err) {
      console.error('[Ezoic Earnings Tracker] recompute failed:', err);
      return { ok: false, reason: 'error', message: String(err && err.message ? err.message : err) };
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === 'REFRESH') {
      recompute()
        .catch((err) => ({ ok: false, reason: 'error', message: String(err && err.message ? err.message : err) }))
        .then((result) => {
          // If the extension was reloaded, this content script's context is
          // torn down and sendResponse itself can throw - nothing to do but
          // swallow it, since there's no popup left listening anyway.
          try {
            sendResponse(result);
          } catch (e) {
            /* extension context invalidated - ignore */
          }
        });
      return true; // keep the message channel open for the async response
    }
    return false;
  });

  async function init() {
    let tries = 0;
    while (!findChartContainer() && tries < 30) {
      await new Promise((res) => setTimeout(res, 1000));
      tries++;
    }

    const tick = () => {
      recompute().catch(() => {
        /* already logged inside recompute(); nothing more to do here */
      });
    };
    tick();
    setInterval(tick, POLL_INTERVAL_MS);
  }

  init();
})();
