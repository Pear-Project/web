// Scrapes the "Projected Revenue" chart on Ezoic's Real-Time analytics page
// and appends one data point to stats/ezoic-revenue.json. Meant to run on a
// schedule via .github/workflows/update-ezoic-revenue.yml.
//
// There is no working Ezoic reporting API access on this account (BDA calls
// come back empty - see update-stats.yml's ad_revenue handling), so this
// reads the same live dashboard a human would look at, the same way the
// pearOS Ezoic Live Earnings Tracker Chrome extension does: each chart point
// has a hidden accessibility tooltip Highcharts fills in on hover with the
// exact dollar values, since Highcharts itself isn't exposed as a page
// global here. See that extension's content.js for the reference
// implementation and notes on the quirks (a chart that keeps re-rendering
// live mid-sweep, a transient hover-highlight marker group that must not be
// mistaken for the real series, etc.) - the sweep logic below is a direct
// port of it into a headless Playwright page.
//
// Auth: analytics.ezoic.com is signed into via Google SSO, which can't be
// driven unattended in CI. Instead this loads a previously-captured session
// (see ezoic_login_capture.mjs) from EZOIC_SESSION_PATH. That session will
// expire eventually - when it does, this script fails loudly rather than
// silently writing empty data.

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT_FILE = path.join(REPO_ROOT, 'stats', 'ezoic-revenue.json');
const SESSION_PATH = process.env.EZOIC_SESSION_PATH || '/tmp/ezoic-session.json';
const REALTIME_URL = 'https://analytics.ezoic.com/reports/realtime';
const MAX_HISTORY_DAYS = 30;

// Runs inside the page - reads the chart's hidden per-point tooltip text via
// synthetic hover, exactly like the Chrome extension's content.js.
async function sweepPageForRevenue() {
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
      // Re-query fresh each time instead of reusing a NodeList captured
      // once: this chart auto-refreshes live and can replace its point
      // elements mid-sweep, which would otherwise leave us hovering
      // detached nodes.
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
      await new Promise((res) => setTimeout(res, 60));

      const texts = Array.from(found.svg.querySelectorAll('text')).map((t) => t.textContent);
      const tooltip = texts[texts.length - 1] || '';
      const timeMatch = tooltip.match(/^([\d:apAPM\s]+)/);
      if (!timeMatch) continue;
      const time = timeMatch[1].trim();
      if (i === 0) window.__lastRawTooltip = tooltip; // for CI debugging if parsing comes back empty

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

    document.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));

    const seen = new Set();
    return rows.filter((row) => {
      if (seen.has(row.time)) return false;
      seen.add(row.time);
      return true;
    });
  }

  function parseTimeLabel(label) {
    const m = label.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!m) return null;
    let h = parseInt(m[1], 10) % 12;
    const min = parseInt(m[2], 10);
    if (/PM/i.test(m[3])) h += 12;
    return h * 60 + min;
  }

  function computeWindowSpan(rows) {
    if (rows.length < 2) return null;
    let entries = rows.map((r) => ({ label: r.time, minutes: parseTimeLabel(r.time) })).filter((e) => e.minutes !== null);
    if (entries.length < 2) return null;
    entries.sort((a, b) => a.minutes - b.minutes);

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
    return { spanHours: span / 60, startLabel: entries[0].label, endLabel: entries[entries.length - 1].label };
  }

  const rows = await sweepChart();
  if (!rows || rows.length === 0) return { ok: false, reason: 'chart-not-found' };

  const sum = rows.reduce((acc, r) => acc + r.total, 0);
  const byPlatform = {};
  for (const row of rows) {
    for (const [platform, value] of Object.entries(row.byPlatform)) {
      byPlatform[platform] = (byPlatform[platform] || 0) + value;
    }
  }
  const span = computeWindowSpan(rows);

  return {
    ok: true,
    sum,
    byPlatform,
    spanHours: span ? span.spanHours : null,
    pointCount: rows.length,
    projected24h: span ? sum * (24 / span.spanHours) : null,
    startLabel: span ? span.startLabel : null,
    endLabel: span ? span.endLabel : null,
    rawTooltipSample: window.__lastRawTooltip || null,
  };
}

function loadHistory() {
  if (!existsSync(OUTPUT_FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(OUTPUT_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveHistory(history) {
  const cutoff = Date.now() - MAX_HISTORY_DAYS * 24 * 60 * 60 * 1000;
  const trimmed = history.filter((entry) => new Date(entry.ts).getTime() >= cutoff);
  writeFileSync(OUTPUT_FILE, JSON.stringify(trimmed, null, 2) + '\n');
}

async function main() {
  if (!existsSync(SESSION_PATH)) {
    throw new Error(`No session file at ${SESSION_PATH} - set EZOIC_SESSION_PATH or check the decode step.`);
  }

  const browser = await chromium.launch();
  const context = await browser.newContext({ storageState: SESSION_PATH });
  const page = await context.newPage();

  try {
    await page.goto(REALTIME_URL, { waitUntil: 'networkidle', timeout: 60000 });

    const url = page.url();
    if (/accounts\.google\.com|\/login/i.test(url)) {
      throw new Error(
        `Ezoic session looks expired - got redirected to ${url}. Re-run ezoic_login_capture.mjs locally and update the EZOIC_SESSION_STATE secret.`
      );
    }

    // Let the dashboard finish its own initial data load/render.
    await page.waitForTimeout(5000);

    const result = await page.evaluate(sweepPageForRevenue);
    if (!result.ok) {
      throw new Error(`Could not read the chart (reason: ${result.reason}). The dashboard layout may have changed.`);
    }

    console.log('Swept result:', JSON.stringify(result, null, 2));

    const history = loadHistory();
    history.push({
      ts: new Date().toISOString(),
      sum: result.sum,
      projected24h: result.projected24h,
      byPlatform: result.byPlatform,
      spanHours: result.spanHours,
      pointCount: result.pointCount,
      startLabel: result.startLabel,
      endLabel: result.endLabel,
    });
    saveHistory(history);

    console.log(`Wrote ${history.length} entries to ${OUTPUT_FILE}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
