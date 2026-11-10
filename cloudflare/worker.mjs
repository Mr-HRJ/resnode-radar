function unavailable(message) {
  return Response.json({ error: message }, {
    status: 503,
    headers: { "cache-control": "no-store" }
  });
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
    if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(env.DATA_REPOSITORY ?? "")) {
      return unavailable("Inventory repository is not configured");
    }

    // The collector commits validated data; query strings and visitor credentials
    // must never become part of the upstream request or its shared cache key.
    let upstream;
    try {
      upstream = await fetch(
        `https://raw.githubusercontent.com/${env.DATA_REPOSITORY}/main/data/products.json`,
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
  }
};
