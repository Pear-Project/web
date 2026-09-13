// Run this ONCE, locally on your own machine (never in CI), to capture an
// authenticated Ezoic session for the CI scraper to reuse.
//
// Ezoic's login (email + password, plus a "new device" verification code)
// needs a human for that verification step, so it can't run unattended in
// CI. Instead, this opens a real, visible browser, lets you log in by hand
// once, and saves the resulting cookies/storage to a file. That file becomes
// the EZOIC_SESSION_STATE GitHub secret the scheduled workflow uses to skip
// login entirely on every run.
//
// Usage:
//   cd .github/scripts
//   npm install
//   npx playwright install chromium
//   node ezoic_login_capture.mjs
//   (log in - including the device verification code - in the window that
//   opens, then come back here and press Enter)
//
// The session will expire eventually (Ezoic's own session lifetime, usually
// on the order of weeks) - when the scheduled workflow starts failing with
// "Ezoic session looks expired", just repeat this process and update the
// secret.

import { chromium } from 'playwright';
import readline from 'node:readline/promises';

const OUTPUT_FILE = 'ezoic-session.json';

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto('https://analytics.ezoic.com/reports/realtime');

console.log('');
console.log('A browser window has opened. Log in there with your email and password,');
console.log('including the device verification code if Ezoic asks for one.');
console.log('Once you can see the Real-Time dashboard with data, come back here and press Enter.');
console.log('');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await rl.question('Press Enter once logged in... ');
rl.close();

await context.storageState({ path: OUTPUT_FILE });
await browser.close();

console.log('');
console.log(`Saved session to ${OUTPUT_FILE}.`);
console.log('Next steps:');
console.log(`  1. base64 encode it:   base64 -i ${OUTPUT_FILE} | pbcopy   (macOS, copies to clipboard)`);
console.log('  2. Paste it as a new GitHub repo secret named EZOIC_SESSION_STATE.');
console.log(`  3. Delete the local ${OUTPUT_FILE} file - it contains live login cookies.`);
