import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchSnapshot } from "../src/services/snapshot.js";

const valid = { schemaVersion: 1, generatedAt: "2026-11-22T00:00:00Z", products: [{ id: "p", status: "available" }] };

test("snapshot retries reuse a stable URL so CDN freshness is controlled by response TTL", async (t) => {
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    urls.push(url);
    assert.equal(options.cache, "default");
    return Response.json(valid);
  });
  await fetchSnapshot("data/products.json?scope=public");
  await fetchSnapshot("data/products.json?scope=public");
  assert.deepEqual(urls, ["data/products.json?scope=public", "data/products.json?scope=public"]);
});

test("snapshot rejects malformed records and duplicate identities before updating the UI", async (t) => {
  for (const payload of [
    { ...valid, schemaVersion: 2 }, { ...valid, generatedAt: null },
    { ...valid, products: [] }, { ...valid, products: [null] }, { ...valid, products: [{}] },
    { ...valid, products: [valid.products[0], valid.products[0]] },
    { ...valid, events: [null] }
  ]) {
    t.mock.method(globalThis, "fetch", async () => Response.json(payload));
    await assert.rejects(fetchSnapshot(), (error) => error.code === "SCHEMA");
    t.mock.restoreAll();
  }
});

test("snapshot timeout covers both response headers and body reads", async (t) => {
  for (const phase of ["headers", "body"]) {
    t.mock.method(globalThis, "fetch", (_url, { signal }) => {
      const stalled = () => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      return phase === "headers" ? stalled() : { ok: true, status: 200, json: stalled };
    });
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      await assert.rejects(fetchSnapshot("data/products.json", { timeoutMs: 10 }), (error) => error.code === "TIMEOUT");
    } finally {
      clearTimeout(keepAlive);
      t.mock.restoreAll();
    }
  }
});

test("large snapshot normalization yields to browser input and can be aborted between batches", async (t) => {
  const products = Array.from({ length: 3880 }, (_, index) => ({ ...valid.products[0], id: `p-${index}` }));
  t.mock.method(globalThis, "fetch", async () => Response.json({ ...valid, products }));
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const controller = new AbortController();
  let yields = 0;
  let abortOnYield = false;
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    setTimeout(resolve) {
      yields += 1;
      if (abortOnYield) controller.abort();
      resolve();
    }
  } });
  t.after(() => original ? Object.defineProperty(globalThis, "window", original) : delete globalThis.window);
  const snapshot = await fetchSnapshot();
  assert.equal(snapshot.plans.length, 3880);
  assert.equal(snapshot.plans.at(-1).id, "p-3879");
  assert.ok(yields > 1);
  abortOnYield = true;
  await assert.rejects(fetchSnapshot("data/products.json", { signal: controller.signal }), error => error.code === "ABORTED");
});
