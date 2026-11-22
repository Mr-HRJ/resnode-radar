import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchSnapshot } from "../src/services/snapshot.js";

const valid = { schemaVersion: 1, generatedAt: "2026-11-22T00:00:00Z", products: [{ id: "p", status: "available" }] };

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
