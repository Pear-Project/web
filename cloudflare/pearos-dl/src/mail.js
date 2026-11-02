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

// Text of the BSD purchase confirmation (English; Romanian added for RO buyers).
export function bsdConfirmationText(session, meta, file, country) {
  const cur = String(session.currency || "").toUpperCase();
  const amount = Number.isFinite(session.amount_total) ? (session.amount_total / 100).toFixed(2) : "?";
  const when = (iso) => (iso ? String(iso).replace("T", " ").replace(/\.\d+Z$/, " UTC") : "-");
  const ref = String(session.payment_intent || "").slice(-8);
  const en = `Thank you for your purchase.

This email confirms your order and, on a durable medium, what you agreed to before paying.

ORDER
- Seller: Pear Software and Services S.R.L. (CUI 50888207), 133 Dacia Blvd, Floor D, Sector 2, Bucharest 020056, Romania
- Product: pearOS UltraC0re (${file}) - digital software, Developer Preview
- Amount paid: ${amount} ${cur}. This is the final price; the seller is not registered for VAT.
- Payment reference: ...${ref}
- Download link issued: ${when(meta.link_first_issued_at)}

WHAT YOU ACCEPTED BEFORE PAYING (${when(meta.terms_accepted_at)})
- Our Terms of Use (version ${meta.terms_version || "-"}): https://pearos.xyz/terms/
- Our Refund Policy: https://pearos.xyz/refund/
- You confirmed that (version ${meta.ack_version || "-"}):
  1. This is software, not a physical product, and payments for software are final and non-refundable. You expressly requested immediate delivery of this digital content and understand that you lose your 14-day right of withdrawal once the download link is issued.
  2. pearOS UltraC0re is experimental: a Developer Preview and a work in progress that can break, lose data or stop working.
  3. Its current limits: no installer, no web browser, CPU-only rendering (no GPU acceleration in virtual machines), and limited Wi-Fi, Bluetooth and GPU support.

USING THE BUILD
- The download is an .iso.xz archive: extract it first (xz -d, or 7-Zip on Windows).
- Login: account "alex", password "pear".
- Your download link is valid for 4 hours.

If something is wrong with your order, reply to this email or write to alex@pear-software.com. Your rights if the file cannot be delivered or does not work are described in the Refund Policy.

Pear Software and Services
https://pearos.xyz
`;
  if (country !== "RO") return en;
  const ro = `

----------------------------------------
Română

Îți mulțumim pentru achiziție.

Acest email confirmă comanda ta și, pe suport durabil, ce ai acceptat înainte de plată.

COMANDĂ
- Vânzător: Pear Software and Services S.R.L. (CUI 50888207), Bld. Dacia nr. 133, Et. D, Sector 2, București 020056, România
- Produs: pearOS UltraC0re (${file}) - software digital, versiune preliminară pentru dezvoltatori
- Suma plătită: ${amount} ${cur}. Este prețul final; vânzătorul nu este înregistrat în scopuri de TVA.
- Referință plată: ...${ref}
- Link de descărcare emis: ${when(meta.link_first_issued_at)}

CE AI ACCEPTAT ÎNAINTE DE PLATĂ (${when(meta.terms_accepted_at)})
- Termenii de utilizare (versiunea ${meta.terms_version || "-"}): https://pearos.xyz/terms/ro/
- Politica de rambursare: https://pearos.xyz/refund/ro/
- Ai confirmat că (versiunea ${meta.ack_version || "-"}):
  1. Este software, nu un produs fizic, iar plățile pentru software sunt definitive și nerambursabile. Ai cerut expres livrarea imediată a acestui conținut digital și înțelegi că pierzi dreptul de retragere de 14 zile odată ce linkul de descărcare este emis.
  2. pearOS UltraC0re este experimental: o versiune preliminară și o lucrare în curs, care se poate bloca, poate pierde date sau poate înceta să funcționeze.
  3. Limitele lui actuale: fără installer, fără browser web, redare doar pe CPU (fără accelerare GPU în mașini virtuale) și suport limitat pentru Wi-Fi, Bluetooth și GPU.

FOLOSIREA BUILD-ULUI
- Descărcarea este o arhivă .iso.xz: extrage-o mai întâi (xz -d sau 7-Zip pe Windows).
- Autentificare: cont "alex", parola "pear".
- Linkul de descărcare este valabil 4 ore.

Dacă ceva nu este în regulă cu comanda, răspunde la acest email sau scrie la alex@pear-software.com.
`;
  return en + ro;
}
