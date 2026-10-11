// Pulls per-day publisher revenue from the public RevDash share link and
// merges it into stats/ezoic-daily-revenue.json, keyed by calendar date.
//
// The share link (https://revdash.com/v/<hash>) is a public, unauthenticated
// dashboard, so unlike scrape_ezoic_daily_revenue.mjs this needs no browser
// and no Ezoic login session -- it can't expire, and it can backfill any
// date range instead of only whatever window the Ezoic UI defaults to.
// It POSTs the same `data/query` call the dashboard's own "Revenue Trend"
// widget makes.
//
// Re-fetching a day overwrites it (Ezoic revises recent days slightly), and
// merging by date key keeps older days that fall outside the window.
//
// EZOIC_DAILY_DAYS: how many days back to fetch (default 14). Raise it to
// backfill after an outage.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT_FILE = path.join(REPO_ROOT, 'stats', 'ezoic-daily-revenue.json');
const SHARE_HASH = process.env.REVDASH_SHARE_HASH || 'Ej6S3KVgURCrihg3w4udG3Q0T97mfgN76WSOsjZh7sU';
const QUERY_URL = `https://revdash.com/v/${SHARE_HASH}/data/query`;
const DAYS = parseInt(process.env.EZOIC_DAILY_DAYS || '14', 10);

const isoDay = (d) => d.toISOString().slice(0, 10);

function loadHistory() {
  if (!existsSync(OUTPUT_FILE)) return {};
  try {
    const parsed = JSON.parse(readFileSync(OUTPUT_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function main() {
  const end = new Date();
  const start = new Date(end.getTime() - DAYS * 86400000);

  const res = await fetch(QUERY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      columns: ['revenue_pub'],
      dateRange: { startDate: isoDay(start), endDate: isoDay(end) },
      reportTypes: ['date'],
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.success !== true || !Array.isArray(body.data)) {
    throw new Error(`RevDash query failed (HTTP ${res.status}): ${JSON.stringify(body)?.slice(0, 300)}`);
  }
  if (body.data.length === 0) {
    throw new Error('RevDash returned no rows -- the share link may have been disabled or the report changed.');
  }

  const history = loadHistory();
  let changed = 0;
  for (const row of body.data) {
    const day = row.date || row.report_day;
    const revenue = Number(row.revenue_pub);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '') || !Number.isFinite(revenue)) continue;
    const rounded = Math.round(revenue * 100) / 100;
    if (history[day] !== rounded) changed++;
    history[day] = rounded;
  }

  // Keep the file in date order so diffs stay readable.
  const sorted = Object.fromEntries(Object.entries(history).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(OUTPUT_FILE, JSON.stringify(sorted, null, 2) + '\n');
  console.log(`Fetched ${body.data.length} day(s), ${changed} changed. History now has ${Object.keys(sorted).length} day(s).`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
