import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import worker from "../cloudflare/worker.mjs";
import { buildCloudflare } from "./build-cloudflare.mjs";

const env = { DATA_REPOSITORY: "Mr-HRJ/resnode-radar" };

function walkJsFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) results.push(...walkJsFiles(full));
    else if (entry.endsWith(".js") || entry.endsWith(".mjs")) results.push(full);
  }
  return results;
}

test("inventory uses only our repository and does not forward visitor credentials or query strings", async (t) => {
  const body = '{"generatedAt":"2026-11-10T00:00:00Z","products":[]}';
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://raw.githubusercontent.com/Mr-HRJ/resnode-radar/data/data/products.json");
    assert.deepEqual(options.headers, { accept: "application/json" });
    assert.equal(options.redirect, "manual");
    assert.equal(options.cf.cacheTtlByStatus["200"], 60);
    return new Response(body);
  });
  const response = await worker.fetch(new Request("https://radar.example/data/products.json?t=123&url=https://example.invalid", {
    headers: { cookie: "private=value", authorization: "Bearer private" }
  }), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.equal(await response.text(), body);
});

test("upstream redirects and errors stay unavailable rather than returning an old bundled snapshot", async (t) => {
  for (const status of [301, 302, 307, 404, 429, 503]) {
    t.mock.method(globalThis, "fetch", async () => new Response("error page", { status }));
    const response = await worker.fetch(new Request("https://radar.example/data/products.json"), env);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match((await response.json()).error, new RegExp(String(status)));
  }
});

test("transport errors and timeouts return a controlled unavailable response", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("network failed"); });
  const response = await worker.fetch(new Request("https://radar.example/data/products.json"), env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Inventory source could not be reached" });
});

test("HEAD returns inventory headers with an empty body", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response('{"products":[]}'));
  const response = await worker.fetch(new Request("https://radar.example/data/products.json", { method: "HEAD" }), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
});

test("inventory writes are rejected before any upstream request", async (t) => {
  t.mock.method(globalThis, "fetch", async () => assert.fail("Unexpected fetch"));
  const response = await worker.fetch(new Request("https://radar.example/data/products.json", { method: "POST" }), env);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD");
});

test("missing repository configuration cannot fall back to another owner's data", async (t) => {
  t.mock.method(globalThis, "fetch", async () => assert.fail("Unexpected fetch"));
  const response = await worker.fetch(new Request("https://radar.example/data/products.json"), {});
  assert.equal(response.status, 503);
});

test("other paths use the static asset binding and retain its status", async () => {
  const request = new Request("https://radar.example/missing");
  const response = await worker.fetch(request, {
    ASSETS: { fetch: async (received) => {
      assert.equal(received, request);
      return new Response("Not found", { status: 404 });
    } }
  });
  assert.equal(response.status, 404);
});

test("deployment package contains new modular browser assets, excludes legacy files, and resolves every import", () => {
  const output = mkdtempSync(join(tmpdir(), "resnode-cloudflare-test-"));
  try {
    buildCloudflare(output);
    const files = readdirSync(output);
    for (const excluded of [
      ".git", "node_modules", "scripts", "monitor", "data", "wrangler.json", "package.json",
      "styles.css", "radar.css", "app.js", "directory.js", "discovery.js", "product-view.js"
    ]) {
      assert.ok(!files.includes(excluded), `Excluded or legacy file leaked: ${excluded}`);
    }
    assert.ok(files.includes("LICENSE"));
    assert.ok(files.includes("styles"));
    assert.ok(files.includes("src"));

    // Verify every relative ES module import inside dist/ resolves to a packaged file
    for (const jsPath of walkJsFiles(output)) {
      const code = readFileSync(jsPath, "utf8");
      for (const [, spec] of code.matchAll(/from\s+["'](\.\.?\/[^"']+)["']/g)) {
        const resolved = resolve(dirname(jsPath), spec);
        assert.ok(existsSync(resolved), `${jsPath} requires missing packaged module ${spec}`);
      }
    }

    // Verify HTML stylesheet & module references exist in dist/
    for (const htmlRel of ["index.html", "reviews/aaitr.html", "reviews/lisahost.html"]) {
      const htmlPath = join(output, htmlRel);
      const html = readFileSync(htmlPath, "utf8");
      for (const [, ref] of html.matchAll(/(?:href|src)=["']((?!https?:|#|\/)[^"']+\.(?:css|js|svg))["']/g)) {
        const resolved = resolve(dirname(htmlPath), ref);
        assert.ok(existsSync(resolved), `${htmlRel} references missing asset ${ref}`);
      }
    }

    const html = readFileSync(join(output, "index.html"), "utf8");
    assert.match(html, /https:\/\/resnode-radar\.haorenjie1997\.workers\.dev\//);
    assert.match(html, /https:\/\/github\.com\/Mr-HRJ\/resnode-radar/);
    assert.doesNotMatch(html, /majiayu000\.github\.io/);
    assert.match(readFileSync(join(output, "reviews/aaitr.html"), "utf8"), /noindex/);
    assert.match(readFileSync(join(output, "reviews/lisahost.html"), "utf8"), /noindex/);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("Cloudflare Cron scheduled handler dispatches GitHub Actions monitor workflow when token is set", async (t) => {
  await assert.rejects(worker.scheduled({}, env), /configure GITHUB_DISPATCH_TOKEN/);

  let dispatchedUrl = null;
  let dispatchedBody = null;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    dispatchedUrl = url;
    dispatchedBody = JSON.parse(options.body);
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.authorization, "Bearer ghp_test_token");
    return new Response(null, { status: 204 });
  });

  const ok = await worker.scheduled({}, { ...env, GITHUB_DISPATCH_TOKEN: "ghp_test_token" });
  assert.equal(ok.dispatched, true);
  assert.equal(dispatchedUrl, "https://api.github.com/repos/Mr-HRJ/resnode-radar/actions/workflows/monitor.yml/dispatches");
  assert.deepEqual(dispatchedBody, { ref: "main" });
});

test("Cron dispatch failures reject so the invocation cannot be reported as successful", async (t) => {
  for (const status of [200, 302, 401, 403, 404, 429, 500]) {
    t.mock.method(globalThis, "fetch", async () => new Response("upstream detail", { status }));
    await assert.rejects(worker.scheduled({}, { ...env, GITHUB_DISPATCH_TOKEN: "test" }), new RegExp(`HTTP ${status}`));
  }
  t.mock.method(globalThis, "fetch", async () => { throw new Error("network timeout"); });
  await assert.rejects(worker.scheduled({}, { ...env, GITHUB_DISPATCH_TOKEN: "test" }), /network timeout/);
  await assert.rejects(worker.scheduled({}, { ...env, GITHUB_DISPATCH_TOKEN: "test", WORKFLOW_REF: "../main" }), /invalid workflow/);
});

test("inventory reads the configured data branch and rejects unsafe branch names", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(url, "https://raw.githubusercontent.com/Mr-HRJ/resnode-radar/snapshots/data/products.json");
    return new Response("{}");
  });
  assert.equal((await worker.fetch(new Request("https://radar.example/data/products.json"), { ...env, DATA_BRANCH: "snapshots" })).status, 200);
  for (const branch of ["../main", "a b", "main?x=1"]) {
    const response = await worker.fetch(new Request("https://radar.example/data/products.json"), { ...env, DATA_BRANCH: branch });
    assert.equal(response.status, 503);
  }
});

test("10-minute cadence is configured for the Cloudflare cron and the GitHub fallback schedule", () => {
  const config = JSON.parse(readFileSync(new URL("../wrangler.json", import.meta.url), "utf8"));
  assert.deepEqual(config.triggers.crons, ["*/10 * * * *"]);
  assert.equal(config.vars.DATA_BRANCH, "data");
  const workflow = readFileSync(new URL("../.github/workflows/monitor.yml", import.meta.url), "utf8");
  assert.match(workflow, /cron: "\*\/10 \* \* \* \*"/);
  assert.match(workflow, /DATA_BRANCH: data/);
  assert.match(workflow, /timeout-minutes: 12/);
});
