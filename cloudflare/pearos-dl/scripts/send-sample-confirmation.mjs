// Sends a SAMPLE of the BSD purchase confirmation email (made-up order data)
// so you can see exactly what a buyer receives.
//
//   SMTP_PASSWORD='...' node scripts/send-sample-confirmation.mjs you@example.com [RO] [Europe/Bucharest]
//
// Add RO as the second argument to get the version with the Romanian block, and an
// IANA timezone as the third to see the times as a buyer in that zone would.
import tls from "node:tls";
import { Readable, Writable } from "node:stream";
import { readFileSync } from "node:fs";

const to = process.argv[2];
const country = (process.argv[3] || "DE").toUpperCase();
const pass = process.env.SMTP_PASSWORD;
if (!to || !pass) {
  console.error("usage: SMTP_PASSWORD='...' node scripts/send-sample-confirmation.mjs recipient@example.com [RO]");
  process.exit(2);
}
const host = process.env.SMTP_HOST || "mail.privateemail.com";
const user = process.env.SMTP_USER || "alex@pear-software.com";

const src = readFileSync(new URL("../src/mail.js", import.meta.url), "utf8").replace(/^import .*cloudflare:sockets.*$/m, "");
const { buildMessage, smtpConversation, bsdConfirmation } = await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));

const now = new Date().toISOString();
const session = { currency: "eur", amount_total: 3099, payment_intent: "pi_3SAMPLE00000000EXAMPLE" };
const meta = { terms_version: "tos-2026-11-02", ack_version: "ack-2026-11-02", terms_accepted_at: now, link_first_issued_at: now };
const tz = process.argv[4] || Intl.DateTimeFormat().resolvedOptions().timeZone; // the buyer's zone, from geoIP in the real thing
const exp = Math.floor(Date.now() / 1000) + 4 * 3600;
const link = { url: `https://iso.pearos.xyz/iso/pearOS-UltraC0re-amd64-26.10.iso.xz?exp=${exp}&sig=SAMPLE-NOT-VALID&tier=paid`, exp, tz };
const { text, html } = bsdConfirmation(session, meta, "pearOS-UltraC0re-amd64-26.10.iso.xz", country, { sample: true, link });

const socket = tls.connect({ host, port: 465, servername: host });
await new Promise((res, rej) => { socket.once("secureConnect", res); socket.once("error", rej); });
const message = buildMessage({ from: user, fromName: "pearOS", to, subject: "[SAMPLE] Your pearOS UltraC0re purchase - confirmation", text, html, domain: user.split("@")[1] });
try {
  await smtpConversation(Readable.toWeb(socket), Writable.toWeb(socket), { user, pass, from: user, to, message, helo: "iso.pearos.xyz" });
  console.log("sample sent to", to);
} catch (e) {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
} finally {
  socket.end();
}
