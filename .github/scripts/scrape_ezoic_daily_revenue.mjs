// Reads Ezoic's Revenue Daily table (analytics.ezoic.com/reports/revenue/
// revenueDaily) and merges each day's revenue into a persistent, per-day
// history file (stats/ezoic-daily-revenue.json), keyed by calendar date.
//
// Unlike the Real-Time chart (a live, constantly-shifting rolling window
// read by scrape_ezoic_revenue.mjs), this page is a plain HTML <table> - no
// hover simulation needed, just read cell text. Whatever range the
// dashboard defaults to (confirmed live it's inconsistent - anywhere from
// "Last 2 Days" to "Last 7 Days" depending on the session), it always
// includes today and yesterday, so every day still gets captured at least
// once (and re-captured a few times after, self-correcting if Ezoic revises
// a day's number slightly) as this runs hourly. Merging by date key makes
// re-reading the same day harmless, and safe against double-counting when
// computing all_time/last_30d totals afterward.
//
// This account's data only goes back to when the site itself launched, so
// "all_time" and "last_30d" happen to mean almost the same thing for now -
// this file just keeps accumulating correctly as more days pass.

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT_FILE = path.join(REPO_ROOT, 'stats', 'ezoic-daily-revenue.json');
const SESSION_PATH = process.env.EZOIC_SESSION_PATH || '/tmp/ezoic-session.json';
const DAILY_URL = 'https://analytics.ezoic.com/reports/revenue/revenueDaily';

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// "Sep 11, 2026 (Friday)" -> "2026-09-11". Returns null for rows that aren't
// a real day (the table's first row is a "% of Total" summary row with an
// empty date cell).
function parseDayLabel(label) {
  const m = label.match(/^([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})/);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (month === undefined) return null;
  const day = String(m[2]).padStart(2, '0');
  const monthStr = String(month + 1).padStart(2, '0');
  return `${m[3]}-${monthStr}-${day}`;
}

// "$7.02(100.00%)" -> 7.02
function parseDollarCell(cell) {
  const m = cell.match(/^\$([\d,.]+)/);
  return m ? parseFloat(m[1].replace(/,/g, '')) : null;
}

async function readDailyTable() {
  const table = document.querySelector('table');
  if (!table) return null;
  const rows = Array.from(table.querySelectorAll('tbody tr'));
  return rows.map((row) => Array.from(row.querySelectorAll('td')).map((td) => td.textContent.trim()));
}

function loadHistory() {
  if (!existsSync(OUTPUT_FILE)) return {};
  try {
    const parsed = JSON.parse(readFileSync(OUTPUT_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveHistory(history) {
  writeFileSync(OUTPUT_FILE, JSON.stringify(history, null, 2) + '\n');
}

// This reads whatever date range the dashboard defaults to (confirmed live
// that's inconsistent - anywhere from "Last 2 Days" to "Last 7 Days"
// depending on the session) rather than forcing a specific one: an attempt
// to explicitly select "All Time" via the range picker worked when driven
// interactively but silently never refreshed the table in headless CI (the
// range display updated, the underlying data never did, even after a 45s
// networkidle wait) for reasons that weren't worth chasing further blind.
// Since every day gets captured via this same rolling default window while
// it's still "today" or "yesterday", and results are merged by date key
// rather than overwritten wholesale, nothing is lost going forward - only
// days from before this scraper started running (which were never
// available anyway; the old Ezoic BDA API this replaces had no access on
// this account either) won't be backfilled.
async function main() {
  if (!existsSync(SESSION_PATH)) {
    throw new Error(`No session file at ${SESSION_PATH} - set EZOIC_SESSION_PATH or check the decode step.`);
  }

  const browser = await chromium.launch();
  // Playwright's default 1280x720 viewport is much narrower than a normal
  // desktop window - this dashboard is responsive, and a narrow viewport may
  // render a different (collapsed/limited) layout. Match a normal wide
  // desktop window to get the same behavior confirmed live.
  const context = await browser.newContext({ storageState: SESSION_PATH, viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  try {
    await page.goto(DAILY_URL, { waitUntil: 'networkidle', timeout: 60000 });

    const url = page.url();
    if (/accounts\.google\.com|\/login/i.test(url)) {
      throw new Error(
        `Ezoic session looks expired - got redirected to ${url}. Re-run ezoic_login_capture.mjs locally and update the EZOIC_SESSION_STATE secret.`
      );
    }

    await page.waitForSelector('table', { timeout: 30000 });

    // The table paints early with a handful of rows and fills in the rest
    // via follow-up requests - wait for the "Showing X to Y of Z entries"
    // footer text (DataTables-style) before trusting the row count, rather
    // than a fixed delay that can race a slow load and only capture 1-2 days.
    try {
      await page.waitForFunction(
        () => /Showing\s+\d+\s+to\s+\d+\s+of\s+\d+\s+entries/i.test(document.body.textContent || ''),
        { timeout: 20000 }
      );
    } catch {
      console.warn('Timed out waiting for the "Showing X to Y of Z entries" footer - reading whatever is there.');
    }
    await page.waitForTimeout(1500); // let the last batch of rows settle in

    const rawRows = await page.evaluate(readDailyTable);
    if (!rawRows || rawRows.length === 0) {
      throw new Error('Could not find the revenue table - the dashboard layout may have changed.');
    }

    console.log('Raw table rows:', JSON.stringify(rawRows, null, 2));

    const history = loadHistory();
    let updatedCount = 0;
    for (const row of rawRows) {
      const dateKey = parseDayLabel(row[0] || '');
      if (!dateKey) continue; // the summary row, or something we don't recognize
      const revenue = parseDollarCell(row[1] || '');
      if (revenue === null) continue;
      if (history[dateKey] !== revenue) updatedCount++;
      history[dateKey] = revenue;
    }

    saveHistory(history);
    console.log(`Merged ${rawRows.length} table rows, ${updatedCount} day(s) changed. History now has ${Object.keys(history).length} day(s).`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
