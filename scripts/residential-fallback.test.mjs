import assert from "node:assert/strict";
import { test } from "node:test";
import { collectWithResidentialFallback } from "./residential-fallback.mjs";

const source = { id: "catalog-greencloud", adapter: "public_catalog" };
const proxy = "http://127.0.0.1:17897";
const product = (id, status = "available") => ({ id, status, raw: { price: 12 } });
const blocked = (reason = "challenge") => ({ id: "diagnostic", diagnostic: true, status: "blocked", httpStatus: 403,
  evidence: "Refused", raw: { attempts: [{ reason }] } });

test("residential fallback is limited to two catalogs and transport/challenge failures", async () => {
  for (const [s, records, configured] of [
    [source, [product("a")], proxy], [source, [blocked()], undefined],
    [{ ...source, id: "catalog-other" }, [blocked()], proxy],
    [{ ...source, adapter: "whmcs_pid_watch" }, [blocked()], proxy],
    [source, [blocked("login-required")], proxy], [source, [blocked("rate-limited")], proxy],
  ]) {
    let calls = 0;
    const result = await collectWithResidentialFallback(s, async (attempt) => {
      calls++; assert.equal(attempt.proxyUrl, undefined); return records;
    }, configured);
    assert.equal(calls, 1);
    assert.strictEqual(result, records);
  }
});

test("residential fallback recovers plans, merges IDs, and records their route", async () => {
  for (const id of ["catalog-greencloud", "catalog-novixlink"]) {
    const calls = [];
    const result = await collectWithResidentialFallback({ ...source, id }, async (attempt) => {
      calls.push(attempt);
      return attempt.proxyUrl ? [product("a", "unavailable"), product("b")] : [product("a"), product("c"), blocked()];
    }, proxy);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].proxyUrl, undefined);
    assert.equal(calls[1].proxyUrl, proxy);
    assert.deepEqual(result.map((p) => p.id).sort(), ["a", "b", "c"]);
    assert.equal(result.find((p) => p.id === "a").status, "unavailable");
    assert.deepEqual(result.find((p) => p.id === "b").raw, { price: 12, egress: "residential", fallbackFrom: "direct" });
    assert.equal(result.find((p) => p.id === "c").raw.egress, undefined);
  }
});

test("backup failure preserves direct plans and exposes both attempts", async () => {
  const error = { id: "diagnostic", diagnostic: true, status: "error", error: "ECONNREFUSED" };
  const result = await collectWithResidentialFallback(source, async (s) => s.proxyUrl ? [error] : [product("a"), blocked()], proxy);
  assert.equal(result[0].id, "a");
  assert.equal(result[1].status, "error");
  assert.equal(result[1].raw.egressAttempts[0].failures[0].httpStatus, 403);
  assert.equal(result[1].raw.egressAttempts[1].products, 0);
  assert.match(result[1].evidence, /ECONNREFUSED/);
});

test("connection errors can retry but empty results cannot erase the direct diagnosis", async () => {
  const direct = [{ id: "diagnostic", diagnostic: true, status: "error", error: "ECONNRESET" }];
  let calls = 0;
  assert.strictEqual(await collectWithResidentialFallback(source, async () => ++calls === 1 ? direct : [], proxy), direct);
  assert.equal(calls, 2);
});
