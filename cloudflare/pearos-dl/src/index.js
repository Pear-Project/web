import { sendMail, bsdConfirmation } from "./mail.js";

// pearOS download gateway: throttles free downloads to N MB/s, and issues/
// verifies signed URLs (via Stripe) that bypass the throttle for 4 hours.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return corsPreflight(request, env);
    }

    if (url.pathname === "/verify" && request.method === "POST") {
      return handleVerify(request, env, ctx);
    }

    if (url.pathname === "/checkout" && request.method === "POST") {
      return handleCheckout(request, env);
    }

    if (url.pathname === "/currency" && request.method === "GET") {
      return handleCurrency(request, env);
    }

    if (url.pathname === "/freepoint" && request.method === "POST") {
      return handleFreepoint(request, env);
    }

    if (url.pathname.startsWith("/iso/")) {
      return handleDownload(request, env, url);
    }

    if (url.pathname === "/badge/distrowatch" && request.method === "GET") {
      return handleDistrowatchBadge(request, ctx);
    }

    if (url.pathname === "/revenue" && request.method === "GET") {
      return handleRevenue(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};

// ---------- /verify: confirm Stripe payment, issue signed URL ----------

async function handleVerify(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, request, env);
  }

  const { session_id, file } = body || {};
  if (!session_id || !file) {
    return json({ error: "missing_session_id_or_file" }, 400, request, env);
  }
  if (file.includes("..") || !/^[\w.\-]+\.iso(?:\.xz)?$/.test(file)) {
    return json({ error: "invalid_file" }, 400, request, env);
  }

  const stripeRes = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(session_id)}`,
    { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } }
  );

  if (!stripeRes.ok) {
    return json({ error: "stripe_lookup_failed" }, 502, request, env);
  }

  const session = await stripeRes.json();
  if (session.payment_status !== "paid") {
    return json({ error: "not_paid" }, 402, request, env);
  }

  // A cheaper donation session must not unlock a BSD build -- /checkout
  // already enforces the BSD floor when the client says which file it is
  // for, but the client controls that field, so re-check the amount that
  // was actually paid here too.
  if (isBsdFile(file)) {
    const cfg = CURRENCY_CONFIG[String(session.currency || "").toLowerCase()];
    if (!cfg || !Number.isFinite(session.amount_total) || session.amount_total < cfg.bsd.minCents) {
      return json({ error: "below_bsd_minimum" }, 402, request, env);
    }
  }

  // Proof of delivery for a possible dispute: stamp the PaymentIntent with
  // when a BSD download link was first issued for this payment (and from which
  // country and IP), plus a running count. Best effort -- never blocks the download.
  if (isBsdFile(file) && typeof session.payment_intent === "string") {
    try {
      const rec = await recordBsdDelivery(env, session.payment_intent, file, request);
      // Confirmation email, once per payment, in the background so the download
      // is never delayed or blocked by the mail server.
      const to = session.customer_details && session.customer_details.email;
      if (rec && rec.first && env.SMTP_PASSWORD && typeof to === "string" && EMAIL_RE.test(to)) {
        const run = sendBsdConfirmation(env, session, rec.meta, file, to, rec.country);
        if (ctx && ctx.waitUntil) ctx.waitUntil(run);
      }
    } catch {
      // Stripe hiccup: the buyer still gets their link.
    }
  }

  const ttl = parseInt(env.SIGNED_URL_TTL_SECONDS, 10);
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const path = `/iso/${file}`;
  const sig = await sign(path, exp, "paid", env.HMAC_SECRET);

  const downloadUrl = `https://iso.pearos.xyz${path}?exp=${exp}&sig=${sig}&tier=paid`;
  return json({ url: downloadUrl, expires_at: exp }, 200, request, env);
}

const EMAIL_RE = /^[^\s<>@"'\r\n]+@[^\s<>@"'\r\n]+\.[^\s<>@"'\r\n]+$/;

async function recordBsdDelivery(env, paymentIntentId, file, request) {
  const auth = { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` };
  const piUrl = `https://api.stripe.com/v1/payment_intents/${encodeURIComponent(paymentIntentId)}`;
  const cur = await fetch(piUrl, { headers: auth });
  if (!cur.ok) return null;
  const meta = (await cur.json()).metadata || {};
  const first = !meta.link_first_issued_at;

  const now = new Date().toISOString();
  const country = (request.cf && request.cf.country) || "XX";
  const ip = (request.headers.get("CF-Connecting-IP") || "").slice(0, 64);
  const count = (parseInt(meta.link_issue_count, 10) || 0) + 1;
  const params = new URLSearchParams({
    "metadata[link_last_issued_at]": now,
    "metadata[link_issue_count]": String(count),
  });
  if (ip) params.set("metadata[link_last_ip]", ip);
  if (!meta.link_first_issued_at) {
    params.set("metadata[link_first_issued_at]", now);
    params.set("metadata[link_first_country]", country);
    params.set("metadata[link_file]", file);
    if (ip) params.set("metadata[link_first_ip]", ip);
  }
  await fetch(piUrl, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  return { first, meta, country };
}

// The purchase confirmation required for the withdrawal-right waiver: it
// repeats, on a durable medium (email), what the buyer agreed to before paying.
async function sendBsdConfirmation(env, session, meta, file, to, country) {
  const stamp = async (status) => {
    try {
      await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(session.payment_intent)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          "metadata[confirmation_email]": status,
          "metadata[confirmation_email_at]": new Date().toISOString(),
        }).toString(),
      });
    } catch {
      // nothing more to do
    }
  };
  try {
    const { text, html } = bsdConfirmation(session, meta, file, country);
    await sendMail(env, { to, subject: "Your pearOS UltraC0re purchase - confirmation", text, html });
    await stamp("sent");
  } catch (e) {
    await stamp("failed: " + String((e && e.message) || e).slice(0, 80));
  }
}


// ---------- /freepoint: mint a signed, throttled (free-tier) download link.
// ---------- Every /iso/ request now requires a valid signature -- this is
// ---------- how the free tier gets one, same 4h TTL as paid links, just
// ---------- without the "paid" tier flag that unlocks full speed. ----------

async function handleFreepoint(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, request, env);
  }

  const file = body && body.file;
  if (typeof file !== "string" || file.includes("..") || !/^[\w.\-]+\.iso(?:\.xz)?$/.test(file)) {
    return json({ error: "invalid_file" }, 400, request, env);
  }
  if (isBsdFile(file)) {
    return json({ error: "paid_only" }, 403, request, env);
  }

  const ttl = parseInt(env.SIGNED_URL_TTL_SECONDS, 10);
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const path = `/iso/${file}`;
  const sig = await sign(path, exp, "free", env.HMAC_SECRET);

  const downloadUrl = `https://iso.pearos.xyz${path}?exp=${exp}&sig=${sig}&tier=free`;
  return json({ url: downloadUrl, expires_at: exp }, 200, request, env);
}

// ---------- currency: derived server-side from Cloudflare's own
// ---------- request.cf.country, so the displayed currency and the one
// ---------- actually charged can never drift apart, and a client can't
// ---------- just claim a cheaper one. ----
//
// USD/EUR/GBP are roughly at parity, so those three just reuse the same
// numeric price with a different symbol (Netflix/Spotify-style display
// pricing, not a real FX conversion). INR and BRL are NOT at parity --
// "2.99" would be a meaningless amount in either -- so those get their
// own rounded, locally-sensible preset amounts instead (approximate
// purchasing-power equivalents, not a live FX rate; revisit occasionally
// rather than wiring up a rate API for a $1-10 donation flow).

const EUROZONE = new Set([
  "AT", "BE", "CY", "DE", "EE", "ES", "FI", "FR", "GR", "HR", "IE",
  "IT", "LT", "LU", "LV", "MT", "NL", "PT", "SI", "SK",
]);

//
// `bsd` is the same shape for the paid-only BSD (UltraC0re) builds: the
// first preset IS the floor (30.99 in USD/EUR/GBP), nobody can pay less.
// INR/BRL use the same rough rates as above (~84 and ~5.0 per USD).
const CURRENCY_CONFIG = {
  usd: { symbol: "$", presets: [299, 499, 999], minCents: 100, bsd: { presets: [3099, 4999, 7999], minCents: 3099 } },
  eur: { symbol: "€", presets: [299, 499, 999], minCents: 100, bsd: { presets: [3099, 4999, 7999], minCents: 3099 } },
  gbp: { symbol: "£", presets: [299, 499, 999], minCents: 100, bsd: { presets: [3099, 4999, 7999], minCents: 3099 } },
  // ~85 INR/USD -- 249/449/899 rupees, minimum ~1 USD equivalent
  inr: { symbol: "₹", presets: [24900, 44900, 89900], minCents: 8500, bsd: { presets: [259900, 419900, 669900], minCents: 259900 } },
  // ~5.3 BRL/USD -- 14.99/24.99/49.99 reais, minimum ~1 USD equivalent
  brl: { symbol: "R$", presets: [1499, 2499, 4999], minCents: 530, bsd: { presets: [15499, 24999, 39999], minCents: 15499 } },
};

// BSD builds are paid-only (no free tier, no throttle bypass question) --
// identified by name, same convention the stats page uses.
function isBsdFile(file) {
  return typeof file === "string" && /UltraC0re/i.test(file);
}

function currencyForCountry(country) {
  if (country === "GB") return { code: "gbp", ...CURRENCY_CONFIG.gbp };
  if (country === "IN") return { code: "inr", ...CURRENCY_CONFIG.inr };
  if (country === "BR") return { code: "brl", ...CURRENCY_CONFIG.brl };
  if (EUROZONE.has(country)) return { code: "eur", ...CURRENCY_CONFIG.eur };
  return { code: "usd", ...CURRENCY_CONFIG.usd };
}

async function handleCurrency(request, env) {
  const country = (request.cf && request.cf.country) || "XX";
  return json(currencyForCountry(country), 200, request, env);
}

// ---------- /checkout: create a Stripe Embedded Checkout session for a ----
// ---------- custom "pay what you want" donation amount ----------

async function handleCheckout(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, request, env);
  }

  const country = (request.cf && request.cf.country) || "XX";
  const { code: currency, minCents: baseMinCents, bsd } = currencyForCountry(country);
  const bsdBuild = isBsdFile(body && body.file);
  const minCents = bsdBuild ? bsd.minCents : baseMinCents;

  const amountCents = Math.round(Number(body && body.amount_cents));
  // Upper bound is a flat anti-abuse ceiling (not currency-scaled) --
  // 100,000,000 of any of these smallest units is absurdly high regardless.
  if (!Number.isFinite(amountCents) || amountCents < minCents || amountCents > 100000000) {
    return json({ error: "invalid_amount" }, 400, request, env);
  }

  const file = body && body.file;
  const validFile = typeof file === "string" && /^[\w.\-]+\.iso(?:\.xz)?$/.test(file);
  const returnUrl = validFile
    ? `https://pearos.xyz/thank-you/?session_id={CHECKOUT_SESSION_ID}&file=${encodeURIComponent(file)}`
    : "https://pearos.xyz/thank-you/?session_id={CHECKOUT_SESSION_ID}";

  const params = new URLSearchParams({
    mode: "payment",
    ui_mode: "embedded",
    "return_url": returnUrl,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": currency,
    "line_items[0][price_data][unit_amount]": String(amountCents),
    "line_items[0][price_data][product_data][name]": bsdBuild ? "pearOS UltraC0re (Developer Preview)" : "pearOS Donation",
    // Tag the charge so /revenue can tell BSD sales from donations (a BSD
    // sale can't be told apart by amount alone: donations are pay-what-you-want).
    "payment_intent_data[metadata][product]": bsdBuild ? "bsd" : "donation",
    "payment_intent_data[description]": bsdBuild ? "pearOS UltraC0re (Developer Preview)" : "pearOS Donation",
  });
  if (validFile) params.set("payment_intent_data[metadata][file]", file);
  // BSD buyers accept the site's Terms of Use (and a no-refund/experimental
  // acknowledgement) before paying; keep which version of the terms and when,
  // on the charge itself, in case of a later dispute.
  if (bsdBuild && typeof body.terms === "string" && /^[\w.\-]{1,40}$/.test(body.terms)) {
    params.set("payment_intent_data[metadata][terms_version]", body.terms);
    params.set("payment_intent_data[metadata][terms_accepted_at]", new Date().toISOString());
    // Buyer's IP when the checkout is created: evidence against card-fraud
    // disputes (disclosed in the privacy policy, legitimate interest).
    const buyerIp = request.headers.get("CF-Connecting-IP");
    if (buyerIp) params.set("payment_intent_data[metadata][checkout_ip]", buyerIp.slice(0, 64));
    // Version of the acknowledgement page (software / no refunds / experimental).
    if (typeof body.ack === "string" && /^[\w.\-]{1,40}$/.test(body.ack)) {
      params.set("payment_intent_data[metadata][ack_version]", body.ack);
    }
  }

  const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!stripeRes.ok) {
    return json({ error: "stripe_session_failed" }, 502, request, env);
  }

  const session = await stripeRes.json();
  return json({ client_secret: session.client_secret }, 200, request, env);
}

// ---------- /iso/<file>: serve from R2, throttled unless signed ----------

async function handleDownload(request, env, url) {
  const key = url.pathname.replace(/^\//, ""); // "iso/<file>.iso"
  const exp = url.searchParams.get("exp");
  const sig = url.searchParams.get("sig");
  const tier = url.searchParams.get("tier") === "paid" ? "paid" : "free";

  let unlocked = false;
  let validSigned = false;
  // Analytics label -- distinct from `unlocked` (which only controls speed).
  // A friends/family download is full-speed but isn't a donation; conflating
  // it with "paid" would make it look like real revenue in the stats/report.
  let accessTier = "free";
  if (exp && sig) {
    const expNum = parseInt(exp, 10);
    if (Number.isFinite(expNum) && expNum > Date.now() / 1000) {
      const expected = await sign(url.pathname, expNum, tier, env.HMAC_SECRET);
      if (timingSafeEqual(expected, sig)) {
        validSigned = true;
        if (tier === "paid") {
          unlocked = true;
          accessTier = "paid";
        }
      }
    }
  }

  // Static, non-expiring bypass for friends/family -- separate from the
  // Stripe-issued signed links (which expire after 4h). Known only to us;
  // anyone holding this exact value gets full speed forever, so rotate
  // env.FRIENDS_TOKEN (wrangler secret put) if it ever leaks.
  if (!validSigned && env.FRIENDS_TOKEN) {
    const friendKey = url.searchParams.get("key");
    if (friendKey && timingSafeEqual(friendKey, env.FRIENDS_TOKEN)) {
      unlocked = true;
      validSigned = true;
      accessTier = "friend";
    }
  }

  // BSD builds are paid-only: a free-tier signature (or none) never serves
  // bytes, only paid/friend access does. Checked before the generic
  // "unsigned" handling so HEAD (size lookups) still works but GET never
  // falls through to the throttled path.
  const bsdOnly = isBsdFile(key) && request.method !== "HEAD" && accessTier === "free";
  if (bsdOnly) {
    return new Response("This build is paid-only. Get it from https://pearos.xyz/bsd/\n", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // Small health-check probe used by external uptime monitors (Statuspage /
  // UptimeRobot etc.) -- always servable, no signature required.
  const isHealthCheck = key === "iso/health.check";

  // HEAD reveals only metadata (size/etag), never file bytes, and can't be
  // throttle-bypassed -- safe to leave unsigned. Our own update-sha.yml
  // automation relies on exactly this (a plain HEAD to check file size).
  const isHead = request.method === "HEAD";

  // Every other /iso/ GET now requires a valid, unexpired signature --
  // free-tier links get one from /freepoint, paid ones from /verify. This
  // is what actually stops the popup being bypassed by hitting the .iso URL
  // directly (a real chunk of traffic was doing exactly that).
  if (!validSigned && !isHealthCheck && !isHead) {
    const filename = key.replace(/^iso\//, "");

    // wget follows a 302 by default and (unlike curl) happily saves the
    // redirect target's *body* under the -O filename the user asked for --
    // silently writing this HTML error page to disk as if it were the ISO,
    // with no visible error at all. CLI tools get an honest plain-text
    // rejection instead; only real browsers get bounced to the HTML retry page.
    const ua = (request.headers.get("User-Agent") || "").toLowerCase();
    const isCliTool = /^(wget|curl|aria2|python-requests|go-http-client|libcurl|httpie|axios|node-fetch)/.test(ua);

    if (isCliTool) {
      return new Response(
        `This download link is not signed or has expired.\n\n` +
          `Open https://pearos.xyz/nicecore/ (or the relevant build page) in a browser to get a fresh link, ` +
          `then copy the resulting signed URL (it will include ?exp=...&sig=...&tier=...) and use that exact ` +
          `URL with wget/curl -- it stays valid for 4 hours.\n`,
        { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } }
      );
    }

    const expiredUrl = `https://pearos.xyz/download-expired/?file=${encodeURIComponent(filename)}`;
    return Response.redirect(expiredUrl, 302);
  }

  const head = await env.ISO_BUCKET.head(key);
  if (!head) {
    // Not in R2 (e.g. out of space there) -- fall back to a GitHub Release
    // asset if one is mapped for this key. Same signature/tier gating as
    // above has already run, so the upstream URL is never exposed and
    // anything paywalled stays paywalled.
    const upstream = fallbackUrlFor(env, key);
    if (upstream) {
      return serveFromUpstream(request, env, key, upstream, accessTier, unlocked);
    }
    return new Response("Not found", { status: 404 });
  }
  const totalSize = head.size;

  // Browsers resume an interrupted download by re-requesting with a Range
  // header. We advertised `accept-ranges: bytes` but never actually honored
  // Range -- we always sent the whole file back with status 200, which some
  // download managers then (mis)treat as a continuation, corrupting the file
  // on disk. Parse and serve Range properly (bytes=start-end / start- / -N).
  let rangeStart = 0;
  let rangeEnd = totalSize - 1;
  let isRangeRequest = false;
  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) {
    const m = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
    if (!m || (m[1] === "" && m[2] === "")) {
      return new Response("Malformed Range header", { status: 400 });
    }
    const [, startStr, endStr] = m;
    if (startStr === "") {
      const suffixLen = parseInt(endStr, 10);
      rangeStart = Math.max(totalSize - suffixLen, 0);
      rangeEnd = totalSize - 1;
    } else {
      rangeStart = parseInt(startStr, 10);
      rangeEnd = endStr === "" ? totalSize - 1 : parseInt(endStr, 10);
    }
    if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd) || rangeStart > rangeEnd || rangeStart >= totalSize) {
      return new Response("Range Not Satisfiable", {
        status: 416,
        headers: { "Content-Range": `bytes */${totalSize}` },
      });
    }
    rangeEnd = Math.min(rangeEnd, totalSize - 1);
    isRangeRequest = true;
  }

  const rangeLength = rangeEnd - rangeStart + 1;
  const object = await env.ISO_BUCKET.get(
    key,
    isRangeRequest ? { range: { offset: rangeStart, length: rangeLength } } : undefined
  );
  if (!object) {
    return new Response("Not found", { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  if (isRangeRequest) {
    headers.set("content-range", `bytes ${rangeStart}-${rangeEnd}/${totalSize}`);
    headers.set("content-length", rangeLength.toString());
  } else {
    headers.set("content-length", totalSize.toString());
  }
  const status = isRangeRequest ? 206 : 200;

  if (request.method === "HEAD") {
    return new Response(null, { headers, status });
  }

  // Count a download once, at the start of the file -- not on HEAD (no
  // bytes served) and not on a mid-file range resume (would double-count
  // a single browser download that retries/resumes partway through).
  if (env.DOWNLOADS && /\.iso(?:\.xz)?$/i.test(key) && (!isRangeRequest || rangeStart === 0)) {
    const country = (request.cf && request.cf.country) || "XX";
    let referrerHost = "direct";
    const referer = request.headers.get("referer");
    if (referer) {
      try {
        referrerHost = new URL(referer).hostname;
      } catch {
        // malformed Referer header, leave as "direct"
      }
    }
    env.DOWNLOADS.writeDataPoint({
      blobs: [key, accessTier, country, referrerHost],
      doubles: [totalSize],
      indexes: [key],
    });
  }

  if (unlocked) {
    // Full speed for paid, signed links.
    return new Response(object.body, { headers, status });
  }

  const bytesPerSec = parseInt(env.FREE_SPEED_BYTES_PER_SEC, 10);
  const throttled = throttleStream(object.body, bytesPerSec, isRangeRequest ? rangeLength : totalSize);
  return new Response(throttled, { headers, status });
}

// ---------- GitHub Releases fallback ----------
//
// env.GITHUB_FALLBACK is a Worker secret holding a JSON object that maps an
// R2 key to a direct release-asset URL, e.g.
//   {"iso/pearOS-UltraC0re-amd64-26.11.iso":"https://github.com/<org>/<repo>/releases/download/<tag>/<file>.iso"}
// Only honored for BSD builds (see fallbackUrlFor). It lives in a secret (not the repo, not bsd-versions.json) so the raw
// GitHub URL -- which would bypass the paywall -- is never public.

// Built-in mappings (public release assets, so nothing secret in them). The
// GITHUB_FALLBACK secret, if set, is merged on top and wins on a clash.
// Update the version in both the key and the URL when a new build ships.
const DEFAULT_FALLBACK = {
  "iso/pearOS-UltraC0re-amd64-26.10.iso.xz":
    "https://github.com/pearOS-bsd/misc/releases/download/iso-latest/pearOS-UltraC0re-amd64-26.10.iso.xz",
};

function fallbackUrlFor(env, key) {
  // BSD (UltraC0re) builds only -- NiceC0re/Goldwing/etc. never fall back,
  // even if a mapping for one were ever added to the secret by mistake.
  if (!isBsdFile(key)) return null;
  let map = DEFAULT_FALLBACK;
  if (env.GITHUB_FALLBACK) {
    try {
      const fromSecret = JSON.parse(env.GITHUB_FALLBACK);
      if (fromSecret && typeof fromSecret === "object") map = { ...DEFAULT_FALLBACK, ...fromSecret };
    } catch {
      // malformed secret: keep the built-in defaults
    }
  }
  const url = map[key];
  return typeof url === "string" && url.startsWith("https://github.com/") ? url : null;
}

async function serveFromUpstream(request, env, key, upstreamUrl, accessTier, unlocked) {
  const headers = new Headers();
  let range = request.headers.get("Range");

  // GitHub's CDN answers a suffix range ("bytes=-N", the last N bytes) with
  // 501, though some download managers / tools use it. Turn it into an
  // explicit range using the asset's size from a HEAD request.
  const suffix = range && range.match(/^bytes=-(\d+)$/);
  if (suffix) {
    const head = await fetch(upstreamUrl, { method: "HEAD", redirect: "follow" });
    const size = parseInt(head.headers.get("content-length"), 10);
    if (head.ok && Number.isFinite(size) && size > 0) {
      const n = Math.min(parseInt(suffix[1], 10), size);
      if (n > 0) range = `bytes=${size - n}-${size - 1}`;
    }
  }
  if (range) headers.set("Range", range);

  const upstream = await fetch(upstreamUrl, {
    method: request.method === "HEAD" ? "HEAD" : "GET",
    headers,
    redirect: "follow",
  });
  if (upstream.status === 416) {
    return new Response("Range Not Satisfiable", {
      status: 416,
      headers: { "Content-Range": upstream.headers.get("content-range") || "bytes */*" },
    });
  }
  if (!upstream.ok) {
    return new Response("Not found", { status: 404 });
  }

  const out = new Headers();
  out.set("content-type", "application/octet-stream");
  out.set("accept-ranges", "bytes");
  for (const h of ["content-length", "content-range", "etag", "last-modified"]) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }

  if (request.method === "HEAD") {
    return new Response(null, { status: upstream.status, headers: out });
  }

  // Same counting rule as the R2 path: once, at the start of the file.
  const cr = upstream.headers.get("content-range"); // "bytes 0-9/1000"
  const startsAtZero = upstream.status === 200 || (cr && /^bytes 0-/.test(cr));
  const totalSize = cr ? parseInt(cr.split("/")[1], 10) : parseInt(upstream.headers.get("content-length"), 10);
  if (env.DOWNLOADS && /\.iso(?:\.xz)?$/i.test(key) && startsAtZero && Number.isFinite(totalSize)) {
    const country = (request.cf && request.cf.country) || "XX";
    let referrerHost = "direct";
    const referer = request.headers.get("referer");
    if (referer) {
      try {
        referrerHost = new URL(referer).hostname;
      } catch {
        // malformed Referer header, leave as "direct"
      }
    }
    env.DOWNLOADS.writeDataPoint({
      blobs: [key, accessTier, country, referrerHost],
      doubles: [totalSize],
      indexes: [key],
    });
  }

  if (unlocked) {
    return new Response(upstream.body, { status: upstream.status, headers: out });
  }
  const bytesPerSec = parseInt(env.FREE_SPEED_BYTES_PER_SEC, 10);
  const upstreamLen = parseInt(upstream.headers.get("content-length"), 10);
  return new Response(throttleStream(upstream.body, bytesPerSec, upstreamLen), { status: upstream.status, headers: out });
}

// ---------- /badge/distrowatch: shields.io endpoint badge, backed by a ----
// ---------- live scrape of pearOS's DistroWatch ranking ----------

async function handleDistrowatchBadge(request, ctx) {
  const cacheKey = new Request("https://iso.pearos.xyz/badge/distrowatch", request);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  let label = "DistroWatch";
  let message = "unranked";
  let color = "lightgrey";

  try {
    const res = await fetch("https://distrowatch.com/table.php?distribution=pearos", {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      },
    });
    if (res.ok) {
      const html = await res.text();
      const match = html.match(/Popularity:<\/b>\s*<a[^>]*>(\d+)\s*\(([\d,]+)\s*hits per day\)<\/a>/i);
      if (match) {
        const rank = match[1];
        const hits = match[2];
        message = `#${rank} · ${hits} hits/day`;
        color = "success";
      }
    }
  } catch {
    // fall through with the "unranked" placeholder below
  }

  const body = JSON.stringify({ schemaVersion: 1, label, message, color });
  const response = new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=21600", // 6h: DistroWatch itself only updates ~daily
      "Access-Control-Allow-Origin": "*",
    },
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// ---------- /revenue: aggregated Stripe totals for the public stats page ----
//
// Public and unauthenticated on purpose -- the numbers it returns (donation
// totals by currency, no card/customer/session details) are meant to be
// shown on /stats/ anyway, so gating the read would just move the same data
// behind a secret the stats-sync GitHub Action would then also need. Edge
// caching is what actually matters here: it keeps a public route from
// hammering the Stripe API on every hit instead of once per cache window.
//
// `charges` (below) is a per-charge list -- amount, currency, timestamp,
// refund status, and the last 6 chars of the charge id, nothing else (no
// customer id, email, card details, or Checkout Session id) -- included so
// a specific number (e.g. "why did all-time jump but not last_30d") can be
// traced back to one real charge without opening the Stripe Dashboard. It's
// exposed on the same public, unauthenticated route as everything else here.

const REVENUE_CACHE_TTL_SECONDS = 900; // 15m -- frequent enough for a stats page, rare enough Stripe never notices

async function handleRevenue(request, env, ctx) {
  const cacheKey = new Request("https://iso.pearos.xyz/revenue", request);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const nowSec = Math.floor(Date.now() / 1000);
  const since30d = nowSec - 30 * 86400;
  const since24h = nowSec - 86400;

  // Charges (not just PaymentIntents) carry `amount_refunded` directly, so a
  // partial refund nets out without a second API call. Paginated because a
  // single /v1/charges page caps at 100 -- 10 pages is far more than this
  // donation volume will ever produce, but keeps a runaway account from
  // making this handler loop forever.
  let charges = [];
  let startingAfter;
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({ limit: "100" });
    if (startingAfter) params.set("starting_after", startingAfter);
    const res = await fetch(`https://api.stripe.com/v1/charges?${params}`, {
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
    });
    if (!res.ok) break;
    const data = await res.json();
    charges = charges.concat(data.data);
    if (!data.has_more || data.data.length === 0) break;
    startingAfter = data.data[data.data.length - 1].id;
  }

  // This Stripe account isn't dedicated to pearOS donations alone -- charges
  // from unrelated sales land in the same /v1/charges list with no field
  // distinguishing them (the Checkout Session created in handleCheckout()
  // never set metadata to tag its charges). Manually confirmed non-pearOS
  // charges are excluded here by id suffix (last 6 chars is unique enough
  // across this account's charge volume) rather than guessed at by date,
  // since an early real donation would look the same as an old unrelated
  // sale by timestamp alone.
  const EXCLUDED_CHARGE_ID_SUFFIXES = new Set([
    "elL3eF", // 2024-11-07, $102.00 USD -- pre-dates pearos-dl/checkout entirely; a different sale on this account, confirmed not a pearOS donation
  ]);

  // paid && !refunded keeps fully-refunded charges out entirely; a partial
  // refund still counts, net of the refunded amount, via amount_refunded.
  const succeeded = charges.filter(
    (c) => c.paid && c.status === "succeeded" && !c.refunded && !EXCLUDED_CHARGE_ID_SUFFIXES.has(c.id.slice(-6))
  );

  function aggregate(list) {
    const byCurrency = {};
    for (const c of list) {
      const cur = c.currency;
      if (!byCurrency[cur]) byCurrency[cur] = { amount_cents: 0, count: 0 };
      byCurrency[cur].amount_cents += c.amount - (c.amount_refunded || 0);
      byCurrency[cur].count += 1;
    }
    return byCurrency;
  }

  // BSD (UltraC0re) sales are tagged at checkout (metadata.product = "bsd",
  // description "pearOS UltraC0re ..."). Charges from before the tagging have
  // neither, so they count as donations -- there were no BSD sales then.
  const isBsdCharge = (c) =>
    (c.metadata && c.metadata.product === "bsd") || /UltraC0re/i.test(c.description || "");
  const bsdCharges = succeeded.filter(isBsdCharge);

  const chargeRow = (c) => ({
    id_suffix: c.id.slice(-6),
    amount_cents: c.amount - (c.amount_refunded || 0),
    currency: c.currency,
    created: new Date(c.created * 1000).toISOString(),
    partially_refunded: (c.amount_refunded || 0) > 0,
    product: isBsdCharge(c) ? "bsd" : "donation",
  });

  // all_time / last_30d / last_24h / charges still cover EVERYTHING (BSD
  // included), exactly as before, so existing consumers (stats chart, the
  // WhatsApp report) keep their totals. `bsd` is the BSD-only subset.
  const result = {
    generated_at: new Date().toISOString(),
    all_time: aggregate(succeeded),
    last_30d: aggregate(succeeded.filter((c) => c.created >= since30d)),
    last_24h: aggregate(succeeded.filter((c) => c.created >= since24h)),
    charges: succeeded.sort((a, b) => b.created - a.created).map(chargeRow),
    bsd: {
      all_time: aggregate(bsdCharges),
      last_30d: aggregate(bsdCharges.filter((c) => c.created >= since30d)),
      last_24h: aggregate(bsdCharges.filter((c) => c.created >= since24h)),
      charges: bsdCharges.sort((a, b) => b.created - a.created).map(chargeRow),
    },
  };

  const response = new Response(JSON.stringify(result), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${REVENUE_CACHE_TTL_SECONDS}`,
      "Access-Control-Allow-Origin": "*",
    },
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// Wraps a ReadableStream so it yields at most `bytesPerSec` bytes/second, on
// average, regardless of how the source chunks its reads.
//
// IMPORTANT: this used to pace on every raw R2 read (often just tens of KB),
// which meant tens of thousands of pull() calls -- each doing Date.now() and
// arithmetic -- over the ~25min a throttled multi-GB download takes. That
// cumulative CPU time exceeded the Workers Free plan's CPU budget (which
// can't even be raised on Free -- confirmed via `wrangler deploy`) and killed
// downloads mid-stream for some users.
//
// A first fix batched raw reads into 4MB chunks via a manual concat() before
// each pacing check -- but concat() copies every byte through Uint8Array.set,
// an O(file size) memcpy in JS. For a 3.3GB file that copy alone plausibly
// costs more CPU than the sleep-math ever did. This version enqueues every
// raw chunk as-is (zero-copy) and only *counts* bytes toward a 4MB threshold
// to decide when to run the (cheap) Date.now()/sleep pacing check -- so the
// data itself is never touched by JS, only forwarded.
// Chunk size for pacing. Small enough that traffic looks like a steady stream
// (a 4MB burst followed by ~2s of silence got cut by some VPNs/proxies/ISPs,
// leaving browsers stuck mid-download), large enough to keep pull() count --
// and so CPU time -- low: ~13k pulls for a 3.3GB file. Chunks are sliced with
// subarray(), so no bytes are copied.
const THROTTLE_CHUNK_BYTES = 256 * 1024; // 256KB

// `length` (bytes of the body) is optional but should be passed whenever known:
// a hand-built ReadableStream makes Workers drop Content-Length and fall back
// to chunked encoding, so browsers showed "Unknown time left" and couldn't
// sanity-check the download. Piping through FixedLengthStream restores it.
function throttleStream(sourceStream, bytesPerSec, length) {
  const reader = sourceStream.getReader();
  const start = Date.now();
  let bytesSent = 0;
  let pending = null; // remainder of an oversized source chunk

  const paced = new ReadableStream(
    {
      async pull(controller) {
        let chunk = pending;
        pending = null;
        if (!chunk) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          chunk = value;
        }
        if (chunk.byteLength > THROTTLE_CHUNK_BYTES) {
          pending = chunk.subarray(THROTTLE_CHUNK_BYTES);
          chunk = chunk.subarray(0, THROTTLE_CHUNK_BYTES);
        }

        controller.enqueue(chunk);
        bytesSent += chunk.byteLength;

        const expectedMs = (bytesSent / bytesPerSec) * 1000;
        const actualMs = Date.now() - start;
        if (expectedMs > actualMs) {
          await sleep(expectedMs - actualMs);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 } // no read-ahead: pull only when the client drains
  );

  if (Number.isFinite(length) && length >= 0 && typeof FixedLengthStream !== "undefined") {
    return paced.pipeThrough(new FixedLengthStream(length));
  }
  return paced;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- signing helpers ----------

async function sign(path, exp, tier, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${path}:${exp}:${tier}`)
  );
  return bufferToHex(mac);
}

function bufferToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// ---------- CORS helpers ----------

function corsHeaders(request, env) {
  const allowed = env.ALLOWED_ORIGIN.split(",").map((o) => o.trim());
  const origin = request.headers.get("Origin");
  const allowOrigin = allowed.includes(origin) ? origin : allowed[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function corsPreflight(request, env) {
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}

function json(data, status, request, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(request, env) },
  });
}
