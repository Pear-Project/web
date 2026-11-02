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

function b64bytes(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function wrap76(s) {
  return s.replace(/(.{76})/g, "$1\r\n");
}

// Builds the RFC 5322 message. Text only, multipart/alternative (text + HTML) when
// `html` is given, and multipart/mixed when there are `attachments`
// ([{ filename, type, bytes }]). Bodies are UTF-8 + base64 (no line-length or
// encoding surprises). `subject` must be ASCII.
export function buildMessage({ from, fromName, to, replyTo, subject, text, html, attachments, domain }) {
  const id = `${crypto.randomUUID()}@${domain}`;
  const headers = [
    `From: ${fromName} <${from}>`,
    `To: <${to}>`,
    `Reply-To: ${replyTo || from}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${id}>`,
    "MIME-Version: 1.0",
  ];
  const rnd = () => crypto.randomUUID().replace(/-/g, "");
  const part = (type, body) =>
    `Content-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n` + wrap76(b64(body.replace(/\r?\n/g, "\r\n")));

  let block; // starts with its own Content-Type header
  if (html) {
    const ab = "=_alt_" + rnd();
    block =
      `Content-Type: multipart/alternative; boundary="${ab}"\r\n\r\n` +
      `--${ab}\r\n` + part("text/plain", text) + "\r\n" +
      `--${ab}\r\n` + part("text/html", html) + "\r\n" +
      `--${ab}--`;
  } else {
    block = part("text/plain", text);
  }
  if (!attachments || !attachments.length) return headers.join("\r\n") + "\r\n" + block;

  const mb = "=_mix_" + rnd();
  let out = headers.join("\r\n") + "\r\n" + `Content-Type: multipart/mixed; boundary="${mb}"\r\n\r\n` + `--${mb}\r\n` + block + "\r\n";
  for (const a of attachments) {
    const name = String(a.filename).replace(/[^\w.\-]/g, "_");
    out +=
      `--${mb}\r\n` +
      `Content-Type: ${a.type}; name="${name}"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="${name}"\r\n\r\n` +
      wrap76(b64bytes(a.bytes)) + "\r\n";
  }
  return out + `--${mb}--`;
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
export async function sendMail(env, { to, subject, text, html, attachments }) {
  const user = env.SMTP_USER;
  const from = env.MAIL_FROM || user;
  const domain = from.split("@")[1] || "pearos.xyz";
  const message = buildMessage({ from, fromName: env.MAIL_FROM_NAME || "pearOS", to, subject, text, html, attachments, domain });
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

// ---------------------------------------------------------------------------
// BSD purchase confirmation: one set of strings (per language), rendered both
// as plain text and as HTML in the site's light theme.
// ---------------------------------------------------------------------------

const SITE = "https://pearos.xyz";

// "2 November 2026 at 06:40 (Europe/Bucharest; 2026-11-02 04:40 UTC)". Falls back to
// UTC when the timezone is missing or not a valid IANA name.
function fmtTime(value, lang, tz) {
  const d = new Date(value);
  if (!value || isNaN(d.getTime())) return "-";
  const locale = lang === "ro" ? "ro-RO" : "en-GB";
  let zone = typeof tz === "string" && tz ? tz : "UTC";
  try {
    new Intl.DateTimeFormat(locale, { timeZone: zone });
  } catch {
    zone = "UTC";
  }
  const local = new Intl.DateTimeFormat(locale, { dateStyle: "long", timeStyle: "short", timeZone: zone }).format(d);
  if (zone === "UTC") return `${local} UTC`;
  return `${local} (${zone}; ${d.toISOString().slice(0, 16).replace("T", " ")} UTC)`;
}

function confirmationParts(session, meta, file, lang, extra = {}) {
  const ro = lang === "ro";
  const cur = String(session.currency || "").toUpperCase();
  const amount = Number.isFinite(session.amount_total) ? (session.amount_total / 100).toFixed(2) : "?";
  const tz = extra.tz;
  const when = (iso) => fmtTime(iso, lang, tz);
  const link = extra.link || null;
  const validUntil = link && link.exp ? when(link.exp * 1000) : null;
  const ref = "..." + String(session.payment_intent || "").slice(-8);
  const file_ = String(file || "");
  const u = (path) => SITE + (ro ? path.replace(/\/$/, "/ro/") : path);
  if (!ro) {
    return {
      lang: "en",
      pill: "Developer Preview",
      title: "Thank you for your purchase.",
      intro: "This email confirms your order and, on a durable medium, what you agreed to before paying.",
      orderTitle: "Your order",
      rows: [
        extra.managed
          ? ["Sold by", "Link (Stripe), as merchant of record. Software supplied by Pear Software and Services S.R.L. (CUI 50888207), 133 Dacia Blvd, Floor D, Sector 2, Bucharest 020056, Romania"]
          : ["Seller", "Pear Software and Services S.R.L. (CUI 50888207), 133 Dacia Blvd, Floor D, Sector 2, Bucharest 020056, Romania"],
        ["Product", `pearOS UltraC0re (${file_}) - digital software, Developer Preview`],
        ["Amount paid", extra.managed ? `${amount} ${cur}, tax included as shown on your receipt from Link.` : `${amount} ${cur}. This is the final price; the seller is not registered for VAT.`],
        ["Payment reference", ref],
        ["Download link issued", when(meta.link_first_issued_at)],
        ...(validUntil ? [["Link valid until", validUntil]] : []),
        ...(extra.invoice ? [["Invoice", `${extra.invoice.number}${extra.invoice.attached ? " (PDF attached)" : ""}`, extra.invoice.url]] : []),
      ],
      acceptTitle: "What you accepted before paying",
      acceptWhen: when(meta.terms_accepted_at),
      docs: [
        [`Terms of Use (version ${meta.terms_version || "-"})`, u("/terms/")],
        ["Refund Policy", u("/refund/")],
      ],
      ackIntro: `You confirmed that (version ${meta.ack_version || "-"}):`,
      link,
    acks: [
        "This is software, not a physical product, and payments for software are final and non-refundable. You expressly requested immediate delivery of this digital content and understand that you lose your 14-day right of withdrawal once the download link is issued.",
        "pearOS UltraC0re is experimental: a Developer Preview and a work in progress that can break, lose data or stop working.",
        "Its current limits: no installer, no web browser, CPU-only rendering (no GPU acceleration in virtual machines), and limited Wi-Fi, Bluetooth and GPU support.",
      ],
      useTitle: "Using the build",
      useItems: [
        "The download is an .iso.xz archive: extract it first (xz -d, or 7-Zip on Windows).",
        validUntil ? `Your download link is valid for 4 hours, until ${validUntil}.` : "Your download link is valid for 4 hours.",
      ],
      downloadLabel: "Download pearOS UltraC0re",
      linkNote: "This link is personal; please do not share it.",
      loginLabel: "Login",
      account: "Account",
      password: "Password",
      help: "If something is wrong with your order, reply to this email or write to alex@pear-software.com. Your rights if the file cannot be delivered or does not work are described in the Refund Policy.",
      links: [["Terms of Use", u("/terms/")], ["Refund Policy", u("/refund/")], ["Privacy Policy", u("/privacy/")]],
    };
  }
  return {
    lang: "ro",
    pill: "Developer Preview",
    title: "Îți mulțumim pentru achiziție.",
    intro: "Acest email confirmă comanda ta și, pe suport durabil, ce ai acceptat înainte de plată.",
    orderTitle: "Comanda ta",
    rows: [
      extra.managed
        ? ["Vândut de", "Link (Stripe), în calitate de comerciant înregistrat (merchant of record). Software furnizat de Pear Software and Services S.R.L. (CUI 50888207), Bld. Dacia nr. 133, Et. D, Sector 2, București 020056, România"]
        : ["Vânzător", "Pear Software and Services S.R.L. (CUI 50888207), Bld. Dacia nr. 133, Et. D, Sector 2, București 020056, România"],
      ["Produs", `pearOS UltraC0re (${file_}) - software digital, versiune preliminară pentru dezvoltatori`],
      ["Suma plătită", extra.managed ? `${amount} ${cur}, taxele incluse, așa cum apar pe chitanța de la Link.` : `${amount} ${cur}. Este prețul final; vânzătorul nu este înregistrat în scopuri de TVA.`],
      ["Referință plată", ref],
      ["Link de descărcare emis", when(meta.link_first_issued_at)],
      ...(validUntil ? [["Link valabil până la", validUntil]] : []),
      ...(extra.invoice ? [["Factură", `${extra.invoice.number}${extra.invoice.attached ? " (PDF atașat)" : ""}`, extra.invoice.url]] : []),
    ],
    acceptTitle: "Ce ai acceptat înainte de plată",
    acceptWhen: when(meta.terms_accepted_at),
    docs: [
      [`Termeni de utilizare (versiunea ${meta.terms_version || "-"})`, u("/terms/")],
      ["Politica de rambursare", u("/refund/")],
    ],
    ackIntro: `Ai confirmat că (versiunea ${meta.ack_version || "-"}):`,
    link,
    acks: [
      "Este software, nu un produs fizic, iar plățile pentru software sunt definitive și nerambursabile. Ai cerut expres livrarea imediată a acestui conținut digital și înțelegi că pierzi dreptul de retragere de 14 zile odată ce linkul de descărcare este emis.",
      "pearOS UltraC0re este experimental: o versiune preliminară și o lucrare în curs, care se poate bloca, poate pierde date sau poate înceta să funcționeze.",
      "Limitele lui actuale: fără installer, fără browser web, redare doar pe CPU (fără accelerare GPU în mașini virtuale) și suport limitat pentru Wi-Fi, Bluetooth și GPU.",
    ],
    useTitle: "Folosirea build-ului",
    useItems: [
      "Descărcarea este o arhivă .iso.xz: extrage-o mai întâi (xz -d sau 7-Zip pe Windows).",
      validUntil ? `Linkul de descărcare este valabil 4 ore, până la ${validUntil}.` : "Linkul de descărcare este valabil 4 ore.",
    ],
    downloadLabel: "Descarcă pearOS UltraC0re",
    linkNote: "Acest link este personal; te rugăm să nu îl partajezi.",
    loginLabel: "Autentificare",
    account: "Cont",
    password: "Parolă",
    help: "Dacă ceva nu este în regulă cu comanda, răspunde la acest email sau scrie la alex@pear-software.com. Drepturile tale în cazul în care fișierul nu poate fi livrat sau nu funcționează sunt descrise în Politica de rambursare.",
    links: [["Termeni de utilizare", u("/terms/")], ["Politica de rambursare", u("/refund/")], ["Politica de confidențialitate", u("/privacy/")]],
  };
}

function partsToText(p) {
  const out = [p.title, "", p.intro, "", p.orderTitle.toUpperCase()];
  for (const [k, v, href] of p.rows) out.push(`- ${k}: ${v}${href ? ` - ${href}` : ""}`);
  out.push("", `${p.acceptTitle.toUpperCase()} (${p.acceptWhen})`);
  for (const [k, url] of p.docs) out.push(`- ${k}: ${url}`);
  out.push(`- ${p.ackIntro}`);
  p.acks.forEach((a, i) => out.push(`  ${i + 1}. ${a}`));
  out.push("", p.useTitle.toUpperCase());
  for (const it of p.useItems) out.push(`- ${it}`);
  if (p.link && p.link.url) out.push(`- ${p.downloadLabel}: ${p.link.url}`, `  (${p.linkNote})`);
  if (!p.noLogin) out.push(`- ${p.loginLabel}: ${p.account.toLowerCase()} "alex", ${p.password.toLowerCase()} "pear".`);
  out.push("", p.help, "", "Pear Software and Services", SITE);
  return out.join("\n");
}

function esc(x) {
  return String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Colours are the site's light theme (assets/css): background #fcfcf7, ink #1a2018,
// muted #5f655e, card #fff, hairline border, destructive #ea384d.
const C = { bg: "#fcfcf7", ink: "#1a2018", muted: "#5f655e", card: "#ffffff", line: "#e6e7e1", soft: "#f3f3ee", accent: "#edf2ec", red: "#ea384d", redSoft: "#fdeef0", redLine: "#f4b9c1" };
const FONT = "'Plus Jakarta Sans','Inter',-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

function partsToHtmlSection(p, first) {
  const link = (t, url) => `<a href="${esc(url)}" style="color:${C.ink};text-decoration:underline">${esc(t)}</a>`;
  const card = (inner, extra = "") =>
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px"><tr><td style="background:${C.card};border:1px solid ${C.line};border-radius:12px;padding:22px 24px;${extra}">${inner}</td></tr></table>`;
  const h2 = (t) => `<div style="font-family:${FONT};font-size:15px;font-weight:700;color:${C.ink};margin:0 0 12px;letter-spacing:-.01em">${esc(t)}</div>`;
  const rows = p.rows
    .map(
      ([k, v, href], i) =>
        `<tr><td style="font-family:${FONT};font-size:12px;color:${C.muted};text-transform:uppercase;letter-spacing:.04em;padding:9px 12px 9px 0;vertical-align:top;width:34%;${i ? `border-top:1px solid ${C.line};` : ""}">${esc(k)}</td><td style="font-family:${FONT};font-size:14px;color:${C.ink};padding:9px 0;line-height:1.5;vertical-align:top;${i ? `border-top:1px solid ${C.line};` : ""}">${href ? `<a href="${esc(href)}" style="color:${C.ink};text-decoration:underline">${esc(v)}</a>` : esc(v)}</td></tr>`
    )
    .join("");
  const acks = p.acks
    .map(
      (a, i) =>
        `<tr><td style="vertical-align:top;padding:0 10px 10px 0;width:22px"><div style="width:22px;height:22px;border-radius:11px;background:${C.accent};border:1px solid ${C.line};text-align:center;font-family:${FONT};font-size:12px;line-height:22px;font-weight:700;color:${C.ink}">${i + 1}</div></td><td style="font-family:${FONT};font-size:14px;line-height:1.55;color:${C.ink};padding:0 0 10px">${esc(a)}</td></tr>`
    )
    .join("");
  const docs = p.docs.map(([k, url]) => `<li style="margin:0 0 4px">${link(k, url)}</li>`).join("");
  const use = p.useItems.map((i) => `<li style="margin:0 0 6px">${esc(i)}</li>`).join("");
  return (
    (first
      ? ""
      : `<div style="height:1px;background:${C.line};margin:34px 0 30px"></div>`) +
    `<div style="font-family:${FONT};margin:0 0 6px"><span style="display:inline-block;background:${p.pillInfo ? C.accent : C.redSoft};color:${p.pillInfo ? C.ink : C.red};border-radius:999px;padding:3px 11px;font-size:12px;font-weight:700">${esc(p.pill)}</span></div>` +
    `<h1 style="font-family:${FONT};font-size:30px;line-height:1.15;font-weight:700;letter-spacing:-.02em;color:${C.ink};margin:10px 0 8px">${esc(p.title)}</h1>` +
    `<p style="font-family:${FONT};font-size:15px;line-height:1.6;color:${C.muted};margin:0 0 22px">${esc(p.intro)}</p>` +
    card(h2(p.orderTitle) + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>`) +
    card(
      h2(p.acceptTitle) +
        `<div style="font-family:${FONT};font-size:12px;color:${C.muted};margin:-6px 0 12px">${esc(p.acceptWhen)}</div>` +
        `<ul style="font-family:${FONT};font-size:14px;line-height:1.55;color:${C.ink};margin:0 0 14px;padding-left:20px">${docs}</ul>` +
        `<div style="font-family:${FONT};font-size:14px;font-weight:600;color:${C.ink};margin:0 0 10px">${esc(p.ackIntro)}</div>` +
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${acks}</table>`,
      p.pillInfo ? `background:${C.soft};` : `background:${C.redSoft};border-color:${C.redLine};`
    ) +
    card(
      h2(p.useTitle) +
        `<ul style="font-family:${FONT};font-size:14px;line-height:1.55;color:${C.ink};margin:0 0 16px;padding-left:20px">${use}</ul>` +
        (p.link && p.link.url
          ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 8px"><tr><td style="background:${C.ink};border-radius:10px"><a href="${esc(p.link.url)}" style="display:inline-block;font-family:${FONT};font-size:15px;font-weight:700;color:${C.bg};text-decoration:none;padding:12px 24px">${esc(p.downloadLabel)} &rarr;</a></td></tr></table>` +
            `<div style="font-family:${FONT};font-size:12px;line-height:1.5;color:${C.muted};margin:0 0 16px">${esc(p.linkNote)}<br><a href="${esc(p.link.url)}" style="font-family:${MONO};font-size:11px;color:${C.muted};word-break:break-all">${esc(p.link.url)}</a></div>`
          : "") +
        (p.noLogin ? "" : `<table role="presentation" cellpadding="0" cellspacing="0"><tr>`) +
        (p.noLogin ? "" : `<td style="padding:0 10px 0 0"><div style="background:${C.soft};border:1px solid ${C.line};border-radius:10px;padding:10px 18px;text-align:center"><div style="font-family:${FONT};font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:${C.muted}">${esc(p.account)}</div><div style="font-family:${MONO};font-size:22px;font-weight:700;color:${C.ink};letter-spacing:.06em">alex</div></div></td>` +
        `<td><div style="background:${C.soft};border:1px solid ${C.line};border-radius:10px;padding:10px 18px;text-align:center"><div style="font-family:${FONT};font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:${C.muted}">${esc(p.password)}</div><div style="font-family:${MONO};font-size:22px;font-weight:700;color:${C.ink};letter-spacing:.06em">pear</div></div></td>` +
        `</tr></table>`)
    ) +
    `<p style="font-family:${FONT};font-size:14px;line-height:1.6;color:${C.muted};margin:6px 0 0">${esc(p.help)}</p>`
  );
}

function renderHtml(sections, banner) {
  const ps = sections;
  const footerLinks = ps[0].links.map(([t, url]) => `<a href="${esc(url)}" style="color:${C.muted};text-decoration:underline">${esc(t)}</a>`).join(" &nbsp;&middot;&nbsp; ");
  return (
    `<!doctype html><html lang="${ps[0].lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only"><title>pearOS UltraC0re</title></head>` +
    `<body style="margin:0;padding:0;background:${C.bg};color:${C.ink}">` +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(ps[0].intro)}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg}"><tr><td align="center" style="padding:28px 14px 40px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">` +
    // header, like the site's: pear + name
    `<tr><td style="padding:0 2px 22px"><table role="presentation" cellpadding="0" cellspacing="0"><tr>` +
    `<td style="vertical-align:middle;padding-right:10px"><img src="${SITE}/assets/images/email-pear.png" width="22" height="34" alt="" style="display:block;border:0"></td>` +
    `<td style="vertical-align:middle;font-family:${FONT};font-size:18px;font-weight:700;letter-spacing:-.01em;color:${C.ink}">Pear Software and Services</td></tr></table></td></tr>` +
    (banner
      ? `<tr><td style="padding:0 0 16px"><div style="font-family:${FONT};font-size:13px;font-weight:700;color:${C.red};border:1px dashed ${C.red};border-radius:10px;padding:10px 14px;text-align:center">${esc(banner)}</div></td></tr>`
      : "") +
    `<tr><td>${ps.map((p, i) => partsToHtmlSection(p, i === 0)).join("")}</td></tr>` +
    `<tr><td style="padding:30px 2px 0;border-top:0"><div style="height:1px;background:${C.line};margin:0 0 18px"></div>` +
    `<div style="font-family:${FONT};font-size:12px;line-height:1.7;color:${C.muted}">Pear Software and Services S.R.L. &middot; CUI 50888207 &middot; 133 Dacia Blvd, Floor D, Sector 2, Bucharest 020056, Romania<br>${footerLinks}<br><a href="${SITE}" style="color:${C.muted};text-decoration:underline">pearos.xyz</a></div></td></tr>` +
    `</table></td></tr></table></body></html>`
  );
}

// The email: {text, html}. English always; a Romanian section is added for
// buyers in Romania. `sample` adds a "this is not a real order" banner.
export function bsdConfirmation(session, meta, file, country, { sample = false, link = null, invoice = null, managed = false } = {}) {
  const extra = { link, tz: link && link.tz, invoice, managed };
  const parts = [confirmationParts(session, meta, file, "en", extra)];
  if (country === "RO") parts.push(confirmationParts(session, meta, file, "ro", extra));
  const banner = sample ? "SAMPLE - this is not a real order" : "";
  const text = (banner ? `[${banner}]\n\n` : "") + parts.map(partsToText).join("\n\n----------------------------------------\n\n");
  return { text, html: renderHtml(parts, banner) };
}

// Plain-text "new sale" note sent to the shop's own mailbox, for the books.
export function accountingText({ kind = "bsd", session, meta, file, country, charge, invoice, buyerEmail, link, managed }) {
  const cur = String(session.currency || "").toUpperCase();
  const amount = Number.isFinite(session.amount_total) ? (session.amount_total / 100).toFixed(2) : "?";
  const bd = (charge && charge.billing_details) || {};
  const cardCountry = charge && charge.payment_method_details && charge.payment_method_details.card && charge.payment_method_details.card.country;
  const at = (iso) => (iso ? String(iso).replace("T", " ").replace(/\.\d+Z$/, " UTC") : "-");
  const lines = [
    kind === "premium" ? "New premium access sale (full-speed download)" : "New paid BSD sale",
    "",
    `Amount: ${amount} ${cur} (${managed ? "tax handled by Stripe as merchant of record (Managed Payments); the payout is net of tax and fees" : "VAT: seller not registered"})`,
    kind === "premium" ? `Product: pearOS premium access - full-speed download of ${file} (4 hours)` : `Product: pearOS UltraC0re - ${file}`,
    `Paid / link issued: ${at(meta.link_first_issued_at)}`,
    "",
    "Buyer",
    `- Email: ${buyerEmail}`,
    `- Name (card): ${bd.name || (session.customer_details && session.customer_details.name) || "-"}`,
    `- Billing country: ${(bd.address && bd.address.country) || (session.customer_details && session.customer_details.address && session.customer_details.address.country) || "-"}`,
    `- Card country: ${cardCountry || "-"}`,
    `- Download country (geoIP): ${country || "-"}`,
    `- IP at checkout: ${meta.checkout_ip || "-"}`,
    `- IP at link issue: ${meta.link_first_ip || "-"}`,
    "",
    "Invoice",
  ];
  if (invoice) {
    lines.push(`- Number: ${invoice.number}`, `- PDF: attached to this email (${invoice.invoice_pdf})`, `- Online: ${invoice.hosted_invoice_url}`);
  } else {
    lines.push("- NO INVOICE was available when this email was sent. Look for it in Stripe (Billing > Invoices) or issue one manually.");
  }
  lines.push(
    "",
    "Stripe",
    `- Payment: https://dashboard.stripe.com/payments/${session.payment_intent}`,
    ...(charge && charge.receipt_url ? [`- Receipt: ${charge.receipt_url}`] : []),
    "",
    "Consent on record",
    ...(kind === "premium"
      ? ["- Notice shown in the download prompt before payment (immediate access; withdrawal right lost once the link is issued); links to Terms and Refund Policy."]
      : [
          `- Terms of Use version: ${meta.terms_version || "-"}`,
          `- Acknowledgement version: ${meta.ack_version || "-"}`,
          `- Accepted at: ${at(meta.terms_accepted_at)}`,
        ]),
    ""
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Premium access (the paid full-speed download of a free build): a thank-you with
// the link, its expiry, and what applies to the purchase.
// ---------------------------------------------------------------------------
function premiumParts(session, meta, file, lang, extra = {}) {
  const ro = lang === "ro";
  const cur = String(session.currency || "").toUpperCase();
  const amount = Number.isFinite(session.amount_total) ? (session.amount_total / 100).toFixed(2) : "?";
  const tz = extra.tz;
  const when = (v) => fmtTime(v, lang, tz);
  const link = extra.link || null;
  const validUntil = link && link.exp ? when(link.exp * 1000) : null;
  const ref = "..." + String(session.payment_intent || "").slice(-8);
  const u = (path) => SITE + (ro ? path.replace(/\/$/, "/ro/") : path);
  const base = { pillInfo: true, noLogin: true, link, loginLabel: "", account: "", password: "" };
  if (!ro) {
    return {
      ...base,
      lang: "en",
      pill: "Premium access",
      title: "Thank you for supporting pearOS.",
      intro: "Your full-speed download link is below. This email also confirms what you paid for and what applies to it.",
      orderTitle: "Your purchase",
      rows: [
        ["Item", `pearOS premium access: full-speed download of ${file} (4 hours)`],
        ["Amount paid", extra.managed ? `${amount} ${cur}, tax included as shown on your receipt from Link.` : `${amount} ${cur}. This is the final price; the seller is not registered for VAT.`],
        ["Payment reference", ref],
        ["Download link issued", when(meta.link_first_issued_at)],
        ...(validUntil ? [["Link valid until", validUntil]] : []),
      ],
      acceptTitle: "What applies to this purchase",
      acceptWhen: when(meta.link_first_issued_at),
      docs: [["Terms of Use", u("/terms/")], ["Refund Policy", u("/refund/")]],
      ackIntro: "Premium access is a digital service delivered immediately:",
      acks: [
        "By paying you asked for immediate access and acknowledged that you lose the 14-day right of withdrawal once the download link is issued.",
        "Payments for premium access are final once the link is issued, except for mistaken, duplicate or unauthorised payments, or a file that cannot be delivered (see the Refund Policy).",
        extra.managed ? "Your receipt and invoice come from Link, which sells this to you; keep them for your records." : "Your receipt comes from Stripe; keep it for your records. Need an invoice for your company? Reply to this email.",
      ],
      useTitle: "Using your link",
      useItems: [
        "Download with the button below. The link is personal; please do not share it.",
        validUntil ? `It is valid for 4 hours, until ${validUntil}.` : "It is valid for 4 hours.",
        "Verify the SHA256 checksum before installing: https://support.pearos.xyz/articles/how-to-verify-the-sha256-checksum-on-your-system",
      ],
      downloadLabel: "Download at full speed",
      linkNote: "This link is personal; please do not share it.",
      help: "If something is wrong with your order, reply to this email or write to alex@pear-software.com.",
      links: [["Terms of Use", u("/terms/")], ["Refund Policy", u("/refund/")], ["Privacy Policy", u("/privacy/")]],
    };
  }
  return {
    ...base,
    lang: "ro",
    pill: "Acces premium",
    title: "Îți mulțumim că susții pearOS.",
    intro: "Linkul tău de descărcare la viteză maximă e mai jos. Acest email confirmă și ce ai plătit și ce se aplică.",
    orderTitle: "Achiziția ta",
    rows: [
      ["Produs", `pearOS acces premium: descărcare la viteză maximă pentru ${file} (4 ore)`],
      ["Suma plătită", extra.managed ? `${amount} ${cur}, taxele incluse, așa cum apar pe chitanța de la Link.` : `${amount} ${cur}. Este prețul final; vânzătorul nu este înregistrat în scopuri de TVA.`],
      ["Referință plată", ref],
      ["Link de descărcare emis", when(meta.link_first_issued_at)],
      ...(validUntil ? [["Link valabil până la", validUntil]] : []),
    ],
    acceptTitle: "Ce se aplică acestei achiziții",
    acceptWhen: when(meta.link_first_issued_at),
    docs: [["Termeni de utilizare", u("/terms/")], ["Politica de rambursare", u("/refund/")]],
    ackIntro: "Accesul premium este un serviciu digital livrat imediat:",
    acks: [
      "Prin plată ai cerut acces imediat și ai confirmat că pierzi dreptul de retragere de 14 zile odată ce linkul de descărcare este emis.",
      "Plățile pentru acces premium sunt definitive după emiterea linkului, cu excepția plăților greșite, duplicate sau neautorizate, sau a unui fișier care nu poate fi livrat (vezi Politica de rambursare).",
      extra.managed ? "Chitanța și factura vin de la Link, care ți-o vinde; păstrează-le în evidențele tale." : "Chitanța vine de la Stripe; păstreaz-o. Ai nevoie de o factură pe firma ta? Răspunde la acest email.",
    ],
    useTitle: "Folosirea linkului",
    useItems: [
      "Descarcă cu butonul de mai jos. Linkul este personal; te rugăm să nu îl partajezi.",
      validUntil ? `Este valabil 4 ore, până la ${validUntil}.` : "Este valabil 4 ore.",
      "Verifică suma de control SHA256 înainte de instalare: https://support.pearos.xyz/articles/how-to-verify-the-sha256-checksum-on-your-system",
    ],
    downloadLabel: "Descarcă la viteză maximă",
    linkNote: "Acest link este personal; te rugăm să nu îl partajezi.",
    help: "Dacă ceva nu este în regulă cu comanda, răspunde la acest email sau scrie la alex@pear-software.com.",
    links: [["Termeni de utilizare", u("/terms/")], ["Politica de rambursare", u("/refund/")], ["Politica de confidențialitate", u("/privacy/")]],
  };
}

export function premiumConfirmation(session, meta, file, country, { link = null, managed = false } = {}) {
  const extra = { link, tz: link && link.tz, managed };
  const parts = [premiumParts(session, meta, file, "en", extra)];
  if (country === "RO") parts.push(premiumParts(session, meta, file, "ro", extra));
  return {
    text: parts.map(partsToText).join("\n\n----------------------------------------\n\n"),
    html: renderHtml(parts, ""),
  };
}
