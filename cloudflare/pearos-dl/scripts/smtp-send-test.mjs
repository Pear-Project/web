// Sends one test message through the same SMTP code the Worker uses, from your
// own machine, to check the mailbox login before relying on it in production.
//
//   SMTP_PASSWORD='...' node scripts/smtp-send-test.mjs you@example.com
//
// (Node 18+. The password is read from the environment and never stored.)
import tls from "node:tls";
import { Readable, Writable } from "node:stream";
import { readFileSync } from "node:fs";

const to = process.argv[2];
const pass = process.env.SMTP_PASSWORD;
if (!to || !pass) {
  console.error("usage: SMTP_PASSWORD='...' node scripts/smtp-send-test.mjs recipient@example.com");
  process.exit(2);
}
const host = process.env.SMTP_HOST || "mail.privateemail.com";
const user = process.env.SMTP_USER || "alex@pear-software.com";

// mail.js imports cloudflare:sockets, which only exists in Workers: drop that line.
const src = readFileSync(new URL("../src/mail.js", import.meta.url), "utf8").replace(/^import .*cloudflare:sockets.*$/m, "");
const { buildMessage, smtpConversation } = await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));

const socket = tls.connect({ host, port: 465, servername: host });
await new Promise((res, rej) => { socket.once("secureConnect", res); socket.once("error", rej); });

const message = buildMessage({
  from: user, fromName: "pearOS", to, subject: "pearOS SMTP test",
  text: "This is a test message from the pearOS download gateway's mail code.\nIf you can read it, sending works.\n",
  domain: user.split("@")[1],
});
try {
  await smtpConversation(Readable.toWeb(socket), Writable.toWeb(socket), { user, pass, from: user, to, message, helo: "iso.pearos.xyz" });
  console.log("sent to", to);
} catch (e) {
  console.error("FAILED:", e.message); // e.g. "smtp: AUTH pass -> 535" = wrong login
  process.exitCode = 1;
} finally {
  socket.end();
}
