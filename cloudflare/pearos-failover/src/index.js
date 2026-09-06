// GitHub's own IPs for pearos.xyz's normal (non-failover) state. Static and
// documented by GitHub for custom-domain Pages sites.
const GH_PAGES_IPS = [
  "185.199.108.153",
  "185.199.109.153",
  "185.199.110.153",
  "185.199.111.153",
];
const GH_PAGES_IPS_V6 = [
  "2606:50c0:8000::153",
  "2606:50c0:8001::153",
  "2606:50c0:8002::153",
  "2606:50c0:8003::153",
];

// Always resolves through GitHub's own infra -- GitHub Pages redirects this
// to the custom domain (pearos.xyz) when a CNAME file is present, so a 3xx
// here (not a connection failure or 5xx) proves the GH Pages origin itself
// is alive, independent of whatever pearos.xyz's DNS currently points at.
const GH_PAGES_HEALTH_URL = "https://pear-project.github.io/web/";

async function isGhPagesHealthy() {
  try {
    const res = await fetch(GH_PAGES_HEALTH_URL, { redirect: "manual" });
    return res.status >= 200 && res.status < 500;
  } catch (e) {
    return false;
  }
}

async function cfApi(env, path, options = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await res.json();
  if (!data.success) {
    throw new Error(`Cloudflare API error on ${path}: ${JSON.stringify(data.errors)}`);
  }
  return data;
}

async function getApexRecords(env) {
  const data = await cfApi(env, `/zones/${env.ZONE_ID}/dns_records?name=${env.RECORD_NAME}`);
  // The apex also carries MX (mail) and TXT (SPF, google/zoho verification)
  // records -- those must never be touched. Only ever act on the records
  // that actually route web traffic (A/AAAA normally, or our own failover
  // CNAME).
  return data.result.filter((r) => ["A", "AAAA", "CNAME"].includes(r.type));
}

async function deleteRecords(env, records) {
  for (const r of records) {
    await cfApi(env, `/zones/${env.ZONE_ID}/dns_records/${r.id}`, { method: "DELETE" });
  }
}

async function failOver(env, records) {
  await deleteRecords(env, records);
  await cfApi(env, `/zones/${env.ZONE_ID}/dns_records`, {
    method: "POST",
    body: JSON.stringify({
      type: "CNAME",
      name: env.RECORD_NAME,
      content: env.MIRROR_TARGET,
      proxied: true,
      ttl: 1,
    }),
  });
}

async function restoreGithubPages(env, records) {
  await deleteRecords(env, records);
  for (const ip of GH_PAGES_IPS) {
    await cfApi(env, `/zones/${env.ZONE_ID}/dns_records`, {
      method: "POST",
      body: JSON.stringify({ type: "A", name: env.RECORD_NAME, content: ip, proxied: true, ttl: 1 }),
    });
  }
  for (const ip of GH_PAGES_IPS_V6) {
    await cfApi(env, `/zones/${env.ZONE_ID}/dns_records`, {
      method: "POST",
      body: JSON.stringify({ type: "AAAA", name: env.RECORD_NAME, content: ip, proxied: true, ttl: 1 }),
    });
  }
}

async function reconcile(env) {
  const [healthy, records] = await Promise.all([isGhPagesHealthy(), getApexRecords(env)]);
  const failedOver = records.some((r) => r.type === "CNAME");

  if (!healthy && !failedOver) {
    console.log("GitHub Pages is down -- failing over to Cloudflare Pages mirror");
    await failOver(env, records);
  } else if (healthy && failedOver) {
    console.log("GitHub Pages has recovered -- restoring its DNS records");
    await restoreGithubPages(env, records);
  } else {
    console.log(`No action needed (healthy=${healthy}, failedOver=${failedOver})`);
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(reconcile(env));
  },

  // Manual check: GET / to force a reconcile pass and see the outcome.
  async fetch(request, env) {
    try {
      await reconcile(env);
      return new Response("Reconcile pass complete, check logs for outcome.");
    } catch (err) {
      return new Response(String(err), { status: 500 });
    }
  },
};
