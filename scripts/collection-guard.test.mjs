import assert from "node:assert/strict";
import { test } from "node:test";
import { collectionDecision } from "./collection-guard.mjs";

const now = Date.parse("2026-11-22T12:00:00Z");
const products = (minutesAgo) => JSON.stringify({ generatedAt: new Date(now - minutesAgo * 60000).toISOString() });
const fx = (hoursAgo) => JSON.stringify({ fetchedAt: new Date(now - hoursAgo * 3600000).toISOString() });

test("a 10-minute cadence collects when the snapshot is due and skips duplicate fallback triggers", () => {
  assert.equal(collectionDecision({ productsJson: products(9.5), fxJson: fx(1), nowMs: now }).collect, true);
  const duplicate = collectionDecision({ productsJson: products(-1), fxJson: fx(1), nowMs: now + 3 * 60000 });
  assert.equal(duplicate.collect, false);
  assert.equal(duplicate.reason, "snapshot-fresh");
});

test("a delayed fallback cannot suppress the next ten-minute slot, and future timestamps cannot stall collection", () => {
  assert.equal(collectionDecision({ productsJson: products(1), nowMs: now }).collect, true);
  assert.equal(collectionDecision({ productsJson: products(-20), nowMs: now }).collect, true);
  assert.equal(collectionDecision({ productsJson: products(1), fxJson: fx(-1), nowMs: now }).fxStale, true);
  assert.throws(() => collectionDecision({ intervalMinutes: NaN }), /Invalid collection interval/);
});

test("manual force and a missing or corrupt snapshot always collect", () => {
  assert.equal(collectionDecision({ productsJson: products(1), nowMs: now, force: true }).reason, "forced");
  assert.equal(collectionDecision({ productsJson: null, nowMs: now }).reason, "no-snapshot");
  assert.equal(collectionDecision({ productsJson: "{not json", nowMs: now }).collect, true);
});

test("ECB rates refresh at most every six hours instead of on every collection", () => {
  assert.equal(collectionDecision({ productsJson: products(10), fxJson: fx(2), nowMs: now }).fxStale, false);
  assert.equal(collectionDecision({ productsJson: products(10), fxJson: fx(7), nowMs: now }).fxStale, true);
  assert.equal(collectionDecision({ productsJson: products(10), fxJson: null, nowMs: now }).fxStale, true);
});
