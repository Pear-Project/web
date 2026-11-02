// Minimal SMTP client for the Worker (cloudflare:sockets), used to send the
// BSD purchase confirmation through the site's own mailbox (Namecheap Private
// Email). Implicit TLS on port 465, AUTH LOGIN. Port 25 is blocked on Workers.

import { connect } from "cloudflare:sockets";

const TIMEOUT_MS = 20000;

function b64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function wrap76(s) {
  return s.replace(/(.{76})/g, "$1\r\n");
}

// Builds the RFC 5322 message: plain text, UTF-8, base64 body (no line-length
// or encoding surprises). `subject` must be ASCII.
export function buildMessage({ from, fromName, to, replyTo, subject, text, domain }) {
  const id = `${crypto.randomUUID()}@${domain}`;
  const headers = [
    `From: ${fromName} <${from}>`,
    `To: <${to}>`,
    `Reply-To: ${replyTo || from}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${id}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
  ];
  return headers.join("\r\n") + "\r\n\r\n" + wrap76(b64(text.replace(/\r?\n/g, "\r\n")));
}

// Speaks SMTP over an already-open duplex stream pair. Exported for testing.
export async function smtpConversation(readable, writable, { user, pass, from, to, message, helo }) {
  const reader = readable.getReader();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let buf = "";

  async function readReply() {
    for (;;) {
      const lines = buf.split("\r\n");
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i]) || /^\d{3}$/.test(lines[i])) {
          const code = parseInt(lines[i].slice(0, 3), 10);
          buf = lines.slice(i + 1).join("\r\n");
          return { code, text: lines.slice(0, i + 1).join("\n") };
        }
      }
      const { done, value } = await reader.read();
      if (done) throw new Error("smtp: connection closed");
      buf += dec.decode(value, { stream: true });
    }
  }
  async function send(line) {
    await writer.write(enc.encode(line + "\r\n"));
  }
  async function expect(codes, what) {
    const r = await readReply();
    if (!codes.includes(r.code)) throw new Error(`smtp: ${what} -> ${r.code}`);
    return r;
  }

  await expect([220], "greeting");
  await send(`EHLO ${helo}`);
  await expect([250], "EHLO");
  await send("AUTH LOGIN");
  await expect([334], "AUTH");
  await send(btoa(user));
  await expect([334], "AUTH user");
  await send(btoa(pass));
  await expect([235], "AUTH pass");
  await send(`MAIL FROM:<${from}>`);
  await expect([250], "MAIL FROM");
  await send(`RCPT TO:<${to}>`);
  await expect([250, 251], "RCPT TO");
  await send("DATA");
  await expect([354], "DATA");
  // dot-stuffing, then the end-of-data marker
  await writer.write(enc.encode(message.replace(/^\./gm, "..") + "\r\n.\r\n"));
  await expect([250], "message");
  try {
    await send("QUIT");
  } catch {
    // already done
  }
}

function withTimeout(promise, ms) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new Error("smtp: timeout")), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

// Sends one message. Throws on any failure; callers decide what to do.
export async function sendMail(env, { to, subject, text }) {
  const user = env.SMTP_USER;
  const from = env.MAIL_FROM || user;
  const domain = from.split("@")[1] || "pearos.xyz";
  const message = buildMessage({ from, fromName: env.MAIL_FROM_NAME || "pearOS", to, subject, text, domain });
  const socket = connect(
    { hostname: env.SMTP_HOST, port: parseInt(env.SMTP_PORT, 10) || 465 },
    { secureTransport: "on", allowHalfOpen: false }
  );
  try {
    await withTimeout(
      smtpConversation(socket.readable, socket.writable, {
        user,
        pass: env.SMTP_PASSWORD,
        from,
        to,
        message,
        helo: "iso.pearos.xyz",
      }),
      TIMEOUT_MS
    );
  } finally {
    try {
      socket.close();
    } catch {
      // ignore
    }
  }
}
