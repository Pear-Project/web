// Maps each Cron Trigger (must match wrangler.toml's triggers.crons verbatim)
// to the GitHub Actions workflow file it stands in for.
const CRON_TO_WORKFLOW = {
  "7 * * * *": "update-stats.yml",
  "7 11 * * *": "whatsapp-report.yml",
  "4,19,34,49 * * * *": "uptime-monitor.yml",
};

async function dispatchWorkflow(env, workflowFile) {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${workflowFile}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_PAT}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "gh-cron-dispatcher",
    },
    body: JSON.stringify({ ref: "main" }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Dispatch failed for ${workflowFile}: ${res.status} ${body}`);
  }
}

export default {
  async scheduled(event, env, ctx) {
    const workflowFile = CRON_TO_WORKFLOW[event.cron];
    if (!workflowFile) {
      console.error(`Unrecognized cron trigger: ${event.cron}`);
      return;
    }
    ctx.waitUntil(dispatchWorkflow(env, workflowFile));
  },

  // Manual smoke test: GET /?workflow=uptime-monitor.yml
  async fetch(request, env) {
    const url = new URL(request.url);
    const workflowFile = url.searchParams.get("workflow");
    if (!workflowFile || !Object.values(CRON_TO_WORKFLOW).includes(workflowFile)) {
      return new Response(
        `Usage: ?workflow=<${Object.values(CRON_TO_WORKFLOW).join("|")}>`,
        { status: 400 }
      );
    }
    try {
      await dispatchWorkflow(env, workflowFile);
      return new Response(`Dispatched ${workflowFile}`);
    } catch (err) {
      return new Response(String(err), { status: 500 });
    }
  },
};
