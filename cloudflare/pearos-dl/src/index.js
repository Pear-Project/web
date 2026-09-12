// pearOS download gateway: throttles free downloads to N MB/s, and issues/
// verifies signed URLs (via Stripe) that bypass the throttle for 4 hours.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return corsPreflight(request, env);
    }

    if (url.pathname === "/verify" && request.method === "POST") {
      return handleVerify(request, env);
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

async function handleVerify(request, env) {
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
  if (file.includes("..") || !/^[\w.\-]+\.iso$/.test(file)) {
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

  const ttl = parseInt(env.SIGNED_URL_TTL_SECONDS, 10);
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const path = `/iso/${file}`;
  const sig = await sign(path, exp, "paid", env.HMAC_SECRET);

  const downloadUrl = `https://iso.pearos.xyz${path}?exp=${exp}&sig=${sig}&tier=paid`;
  return json({ url: downloadUrl, expires_at: exp }, 200, request, env);
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
  if (typeof file !== "string" || file.includes("..") || !/^[\w.\-]+\.iso$/.test(file)) {
    return json({ error: "invalid_file" }, 400, request, env);
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

const CURRENCY_CONFIG = {
  usd: { symbol: "$", presets: [299, 499, 999], minCents: 100 },
  eur: { symbol: "€", presets: [299, 499, 999], minCents: 100 },
  gbp: { symbol: "£", presets: [299, 499, 999], minCents: 100 },
  // ~85 INR/USD -- 249/449/899 rupees, minimum ~1 USD equivalent
  inr: { symbol: "₹", presets: [24900, 44900, 89900], minCents: 8500 },
  // ~5.3 BRL/USD -- 14.99/24.99/49.99 reais, minimum ~1 USD equivalent
  brl: { symbol: "R$", presets: [1499, 2499, 4999], minCents: 530 },
};

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
  const { code: currency, minCents } = currencyForCountry(country);

  const amountCents = Math.round(Number(body && body.amount_cents));
  // Upper bound is a flat anti-abuse ceiling (not currency-scaled) --
  // 100,000,000 of any of these smallest units is absurdly high regardless.
  if (!Number.isFinite(amountCents) || amountCents < minCents || amountCents > 100000000) {
    return json({ error: "invalid_amount" }, 400, request, env);
  }

  const file = body && body.file;
  const validFile = typeof file === "string" && /^[\w.\-]+\.iso$/.test(file);
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
    "line_items[0][price_data][product_data][name]": "pearOS Donation",
  });

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
  if (env.DOWNLOADS && /\.iso$/i.test(key) && (!isRangeRequest || rangeStart === 0)) {
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
  const throttled = throttleStream(object.body, bytesPerSec);
  return new Response(throttled, { headers, status });
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

  // paid && !refunded keeps fully-refunded charges out entirely; a partial
  // refund still counts, net of the refunded amount, via amount_refunded.
  const succeeded = charges.filter((c) => c.paid && c.status === "succeeded" && !c.refunded);

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

  const result = {
    generated_at: new Date().toISOString(),
    all_time: aggregate(succeeded),
    last_30d: aggregate(succeeded.filter((c) => c.created >= since30d)),
    last_24h: aggregate(succeeded.filter((c) => c.created >= since24h)),
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
const THROTTLE_BATCH_BYTES = 4 * 1024 * 1024; // 4MB

function throttleStream(sourceStream, bytesPerSec) {
  const reader = sourceStream.getReader();
  const start = Date.now();
  let bytesSent = 0;
  let sinceLastPace = 0;

  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }

      controller.enqueue(value); // zero-copy: forward the raw chunk as-is
      bytesSent += value.byteLength;
      sinceLastPace += value.byteLength;

      if (sinceLastPace < THROTTLE_BATCH_BYTES) {
        return; // skip the pacing check -- most pull() calls exit right here
      }
      sinceLastPace = 0;

      const expectedMs = (bytesSent / bytesPerSec) * 1000;
      const actualMs = Date.now() - start;
      if (expectedMs > actualMs) {
        await sleep(expectedMs - actualMs);
      }
    },
    cancel(reason) {
      reader.cancel(reason);
    },
  });
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
