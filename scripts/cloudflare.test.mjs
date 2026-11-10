import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import worker from "../cloudflare/worker.mjs";
import { buildCloudflare } from "./build-cloudflare.mjs";

const env = { DATA_REPOSITORY: "Mr-HRJ/resnode-radar" };

test("inventory uses only our repository and does not forward visitor credentials or query strings", async (t) => {
  const body = '{"generatedAt":"2026-11-10T00:00:00Z","products":[]}';
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://raw.githubusercontent.com/Mr-HRJ/resnode-radar/main/data/products.json");
    assert.deepEqual(options.headers, { accept: "application/json" });
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

test("upstream errors stay unavailable rather than returning an old bundled snapshot", async (t) => {
  for (const status of [404, 429, 503]) {
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

test("deployment package contains browser assets and license with the deployment's canonical URLs", () => {
  const output = mkdtempSync(join(tmpdir(), "resnode-cloudflare-test-"));
  try {
    buildCloudflare(output);
    const files = readdirSync(output);
    for (const excluded of [".git", "node_modules", "scripts", "monitor", "data", "wrangler.json", "package.json"]) {
      assert.ok(!files.includes(excluded), excluded);
    }
    assert.ok(files.includes("LICENSE"));
    const html = readFileSync(join(output, "index.html"), "utf8");
    assert.match(html, /https:\/\/resnode-radar\.haorenjie1997\.workers\.dev\//);
    assert.match(html, /https:\/\/github\.com\/Mr-HRJ\/resnode-radar/);
    assert.doesNotMatch(html, /majiayu000\.github\.io/);
    assert.match(readFileSync(join(output, "reviews/aaitr.html"), "utf8"), /noindex/);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
