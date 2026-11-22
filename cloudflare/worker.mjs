function unavailable(message) {
  return Response.json({ error: message }, {
    status: 503,
    headers: { "cache-control": "no-store" }
  });
}

function validRepository(repo) {
  return /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(repo ?? "");
}

function gitRef(value, fallback) {
  const ref = value || fallback;
  return /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,99}$/.test(ref) && !ref.includes("..") ? ref : null;
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== "/data/products.json") {
      return env.ASSETS.fetch(request);
    }
    if (!["GET", "HEAD"].includes(request.method)) {
      return new Response("Method not allowed", {
        status: 405,
        headers: { allow: "GET, HEAD" }
      });
    }
    // The collector force-publishes each validated snapshot to a dedicated data branch.
    const dataBranch = gitRef(env.DATA_BRANCH, "data");
    if (!validRepository(env.DATA_REPOSITORY) || !dataBranch) {
      return unavailable("Inventory repository is not configured");
    }

    // The collector commits validated data; query strings and visitor credentials
    // must never become part of the upstream request or its shared cache key.
    let upstream;
    try {
      upstream = await fetch(
        `https://raw.githubusercontent.com/${env.DATA_REPOSITORY}/${dataBranch}/data/products.json`,
        {
          headers: { accept: "application/json" },
          // Workers supports manual redirects; all non-200 responses are rejected below.
          redirect: "manual",
          signal: AbortSignal.timeout(10000),
          cf: { cacheEverything: true, cacheTtlByStatus: { "200": 60, "300-599": -1 } }
        }
      );
    } catch (error) {
      console.error("Inventory source fetch failed:", error instanceof Error ? `${error.name}: ${error.message}` : "Unknown transport error");
      return unavailable("Inventory source could not be reached");
    }
    if (upstream.status !== 200) {
      await upstream.body?.cancel();
      return unavailable(`Inventory source returned HTTP ${upstream.status}`);
    }
    const headers = {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff"
    };
    if (request.method === "HEAD") {
      await upstream.body?.cancel();
      return new Response(null, { headers });
    }
    return new Response(upstream.body, { headers });
  },

  /**
   * Cloudflare Cron Trigger ("*\/10 * * * *"):
   * With the GITHUB_DISPATCH_TOKEN secret set, dispatches the collector workflow every
   * 10 minutes. Runner queueing may delay collection; acceptance is not completion.
   * GitHub's own `schedule` is a fallback in monitor.yml.
   */
  async scheduled(_controller, env) {
    if (!validRepository(env?.DATA_REPOSITORY) || !env?.GITHUB_DISPATCH_TOKEN) {
      throw new Error("Scheduled collection failed: configure GITHUB_DISPATCH_TOKEN and DATA_REPOSITORY");
    }
    const workflow = env.MONITOR_WORKFLOW || "monitor.yml";
    const ref = gitRef(env.WORKFLOW_REF, "main");
    if (!ref || !/^[a-zA-Z0-9_.-]+$/.test(workflow)) {
      throw new Error("Scheduled collection failed: invalid workflow configuration");
    }
    const response = await fetch(
      `https://api.github.com/repos/${env.DATA_REPOSITORY}/actions/workflows/${workflow}/dispatches`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
          "content-type": "application/json",
          "user-agent": "ResNodeRadar-Cloudflare-Cron/1.0",
          "x-github-api-version": "2022-11-28"
        },
        body: JSON.stringify({ ref }),
        redirect: "error",
        signal: AbortSignal.timeout(10000)
      }
    );
    if (response.status !== 204) {
      await response.body?.cancel();
      throw new Error(`Scheduled workflow dispatch failed with HTTP ${response.status}`);
    }
    return { dispatched: true, status: response.status };
  }
};
